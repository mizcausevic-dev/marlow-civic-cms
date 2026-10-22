import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, migrate, type DB } from '../src/db/db.ts';
import { createCmsApp, type CmsOptions } from '../src/http/cms-app.ts';
import { addSiteMember, createSite, createUser } from '../src/services/cms.ts';
import type { User } from '../src/domain/authz.ts';

export const pageDocument = {
  version: 1 as const,
  blocks: true,
  fields: [
    { key: 'title', label: 'Title', type: 'string' as const, required: true, maxLength: 140 },
    { key: 'summary', label: 'Summary', type: 'text' as const, required: false },
    { key: 'seoTitle', label: 'SEO title', type: 'string' as const, required: false, maxLength: 70 },
    { key: 'seoDescription', label: 'SEO description', type: 'text' as const, required: false, maxLength: 160 },
  ],
};

export type Fixture = {
  dir: string;
  db: DB;
  origin: string;
  siteId: string;
  localeId: string;
  admin: User;
  editor: User;
  publisher: User;
  close: () => Promise<void>;
};

export async function fixture(options: Partial<CmsOptions> = {}): Promise<Fixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marlow-'));
  const db = openDatabase(path.join(dir, 'cms.sqlite'));
  migrate(db);
  const admin = createUser(db, { email: 'cam.admin@marlow.test', name: 'Cam Admin', password: 'local-admin-pass', role: 'administrator' });
  const editor = createUser(db, { email: 'ada.editor@marlow.test', name: 'Ada Editor', password: 'local-editor-pass', role: 'editor' });
  const publisher = createUser(db, { email: 'ben.publisher@marlow.test', name: 'Ben Publisher', password: 'local-publisher-pass', role: 'publisher' });
  const site = createSite(db, admin, { name: 'Marlow Civic Desk', slug: 'marlow' });
  for (const user of [admin, editor, publisher]) addSiteMember(db, admin, site.id, user.id);
  const locale = db.prepare('SELECT id FROM locales WHERE site_id = ? AND code = ?').get(site.id, 'en') as { id: string };
  const app = createCmsApp({ db, mediaRoot: path.join(dir, 'media'), ...options });
  const server = await listen(app);
  return {
    dir,
    db,
    origin: server.origin,
    siteId: site.id,
    localeId: locale.id,
    admin,
    editor,
    publisher,
    close: async () => {
      await server.close();
      db.close();
    },
  };
}

export async function listen(app: { fetch: (request: Request) => Promise<Response> | Response }): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer(async (req, res) => {
    try {
      await proxy(app, req, res);
    } catch (error) {
      res.writeHead(500);
      res.end(error instanceof Error ? error.message : 'error');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function proxy(app: { fetch: (request: Request) => Promise<Response> | Response }, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(key, item));
    else if (value !== undefined) headers.set(key, value);
  }
  const response = await app.fetch(new Request(`http://127.0.0.1${req.url}`, {
    method: req.method,
    headers,
    body: body.length > 0 && req.method !== 'GET' && req.method !== 'HEAD' ? new Uint8Array(body) : undefined,
  }));
  const outgoing = new Map<string, string | string[]>();
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie' || key.toLowerCase() === 'content-length') return;
    outgoing.set(key, value);
  });
  const cookies = response.headers.getSetCookie?.() ?? [];
  if (cookies.length > 0) outgoing.set('set-cookie', cookies);
  res.writeHead(response.status, Object.fromEntries(outgoing));
  res.end(new Uint8Array(await response.arrayBuffer()));
}

export function jar(response: Response, previous = ''): string {
  const map = new Map<string, string>();
  for (const part of previous.split(';').map((item) => item.trim()).filter(Boolean)) {
    const index = part.indexOf('=');
    if (index > 0) map.set(part.slice(0, index), part.slice(index + 1));
  }
  const cookies = response.headers.getSetCookie?.() ?? [];
  for (const cookie of cookies) {
    const pair = cookie.split(';')[0] ?? '';
    const index = pair.indexOf('=');
    if (index > 0) map.set(pair.slice(0, index).trim(), pair.slice(index + 1));
  }
  return [...map.entries()].map(([key, value]) => `${key}=${value}`).join('; ');
}

export async function signIn(origin: string, email: string, password: string): Promise<{ cookie: string; csrf: string }> {
  const page = await fetch(`${origin}/admin/login`);
  const html = await page.text();
  const csrf = /name="_csrf" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(csrf, 'login form did not include a CSRF token');
  const posted = await fetch(`${origin}/admin/login`, {
    method: 'POST',
    headers: { cookie: jar(page), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, email, password }),
    redirect: 'manual',
  });
  assert.equal(posted.status, 302, await posted.text());
  const cookie = jar(posted, jar(page));
  const home = await fetch(`${origin}/admin`, { headers: { cookie } });
  const homeHtml = await home.text();
  const meta = /name="csrf-token" content="([^"]+)"/.exec(homeHtml)?.[1];
  assert.equal(home.status, 200);
  assert.ok(meta);
  return { cookie: jar(home, cookie), csrf: meta };
}

export async function api(origin: string, session: { cookie: string; csrf: string }, path: string, body?: unknown, method = 'POST') {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      cookie: session.cookie,
      'content-type': 'application/json',
      'x-csrf-token': session.csrf,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: response.status, json, text, headers: response.headers };
}
