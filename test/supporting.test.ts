import assert from 'node:assert/strict';
import { test } from 'node:test';
import { signPayload } from '../src/domain/crypto.ts';
import { solidPng } from '../src/domain/media.ts';
import { isUnsafeIp, validateWebhookDestination } from '../src/domain/webhooks.ts';
import { createWebhookEndpoint, deliverDueWebhooks } from '../src/services/cms.ts';
import { api, fixture, pageDocument, signIn } from './helpers.ts';

test('scenarios 16-19 sites, media, webhooks, redirects', async () => {
  const seen: { url: string; body: string; headers: Record<string, string> }[] = [];
  const fx = await fixture({
    webhookLookup: async () => ['93.184.216.34'],
  });
  try {
    const admin = await signIn(fx.origin, 'cam.admin@marlow.test', 'local-admin-pass');
    const editor = await signIn(fx.origin, 'ada.editor@marlow.test', 'local-editor-pass');
    const publisher = await signIn(fx.origin, 'ben.publisher@marlow.test', 'local-publisher-pass');
    const type = await api(fx.origin, admin, '/admin/api/content-types', {
      siteId: fx.siteId,
      apiKey: 'page',
      name: 'Page',
      document: pageDocument,
    });
    const typeId = (type.json as { id: string }).id;
    const english = await api(fx.origin, editor, '/admin/api/entries', {
      siteId: fx.siteId,
      contentTypeId: typeId,
      localeId: fx.localeId,
      slug: 'about',
      fields: { title: 'About the desk', summary: 'English public', seoTitle: 'About the desk', seoDescription: 'How the desk publishes.' },
      blocks: [{ type: 'richText', props: { nodes: [{ kind: 'p', text: 'English body' }] } }],
    });
    const aboutId = (english.json as { entryId: string }).entryId;
    const aboutRevision = (english.json as { revisionId: string }).revisionId;
    assert.equal((await api(fx.origin, publisher, `/admin/api/revisions/${aboutRevision}/approve`)).status, 200);
    assert.equal((await api(fx.origin, publisher, `/admin/api/entries/${aboutId}/publish`, { revisionId: aboutRevision })).status, 200);
    const duplicate = await api(fx.origin, editor, '/admin/api/entries', {
      siteId: fx.siteId,
      contentTypeId: typeId,
      localeId: fx.localeId,
      slug: 'about',
      fields: { title: 'Duplicate' },
      blocks: [],
    });
    assert.equal(duplicate.status, 409);

    const spanish = fx.db.prepare('SELECT id FROM locales WHERE site_id = ? AND code = ?').get(fx.siteId, 'en') as { id: string };
    const added = await fetch(`${fx.origin}/admin/locales`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: admin.csrf, code: 'es', localeName: 'Espanol', fallback: spanish.id }),
      redirect: 'manual',
    });
    assert.equal(added.status, 302, await added.clone().text());
    const es = fx.db.prepare(`SELECT id FROM locales WHERE site_id = ? AND code = 'es'`).get(fx.siteId) as { id: string };
    const draft = await api(fx.origin, editor, '/admin/api/entries', {
      siteId: fx.siteId,
      contentTypeId: typeId,
      localeId: es.id,
      slug: 'about',
      fields: { title: 'Borrador secreto' },
      blocks: [],
    });
    assert.equal(draft.status, 200, JSON.stringify(draft.json));
    const fallback = await (await fetch(`${fx.origin}/api/public/marlow/entries/about?locale=es`)).json() as { fallback: boolean; localeServed: string; meta: { title: string } };
    assert.equal(fallback.fallback, true);
    assert.equal(fallback.localeServed, 'en');
    assert.equal(fallback.meta.title, 'About the desk');
    assert.equal(JSON.stringify(fallback).includes('Borrador secreto'), false);

    const other = await fetch(`${fx.origin}/admin/sites`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: admin.csrf, name: 'Other Desk', slug: 'other' }),
      redirect: 'manual',
    });
    assert.equal(other.status, 302);
    const otherSite = fx.db.prepare(`SELECT id FROM sites WHERE slug = 'other'`).get() as { id: string };
    const otherLocale = fx.db.prepare('SELECT id FROM locales WHERE site_id = ?').get(otherSite.id) as { id: string };
    const outsider = await api(fx.origin, editor, '/admin/api/entries', {
      siteId: otherSite.id,
      contentTypeId: typeId,
      localeId: otherLocale.id,
      slug: 'about',
      fields: { title: 'Wrong site' },
      blocks: [],
    });
    assert.equal(outsider.status, 403);
    const cross = await fetch(`${fx.origin}/api/public/other/entries/about`);
    assert.equal(cross.status, 404);

    const png = solidPng(8, 8, [15, 110, 106, 255]);
    const upload = new FormData();
    upload.set('_csrf', editor.csrf);
    upload.set('alt', 'East pier at dawn');
    upload.set('file', new File([new Uint8Array(png)], 'pier.png', { type: 'image/png' }));
    const uploaded = await fetch(`${fx.origin}/admin/media`, { method: 'POST', headers: { cookie: editor.cookie }, body: upload, redirect: 'manual' });
    assert.equal(uploaded.status, 302, await uploaded.clone().text());
    const media = fx.db.prepare('SELECT id FROM media LIMIT 1').get() as { id: string };
    const bad = new FormData();
    bad.set('_csrf', editor.csrf);
    bad.set('alt', 'not an image');
    bad.set('file', new File(['<html></html>'], 'page.html', { type: 'text/html' }));
    const rejected = await fetch(`${fx.origin}/admin/media`, { method: 'POST', headers: { cookie: editor.cookie }, body: bad });
    assert.equal(rejected.status, 400);
    const huge = Buffer.alloc(2_000_001);
    png.copy(huge, 0, 0, 8);
    const oversized = new FormData();
    oversized.set('_csrf', editor.csrf);
    oversized.set('alt', 'too big');
    oversized.set('file', new File([new Uint8Array(huge)], 'big.png', { type: 'image/png' }));
    const tooBig = await fetch(`${fx.origin}/admin/media`, { method: 'POST', headers: { cookie: editor.cookie }, body: oversized });
    assert.equal(tooBig.status, 400);

    const endpoint = await createWebhookEndpoint(fx.db, fx.admin, { siteId: fx.siteId, url: 'https://hooks.example.com/inbox' }, async () => ['93.184.216.34']);
    const hookRevision = await api(fx.origin, editor, `/admin/api/entries/${aboutId}/revisions`, {
      fields: { title: 'About the desk', summary: 'With webhook' },
      blocks: [],
    });
    const hookRevisionId = (hookRevision.json as { id: string }).id;
    assert.equal((await api(fx.origin, publisher, `/admin/api/revisions/${hookRevisionId}/approve`)).status, 200);
    assert.equal((await api(fx.origin, publisher, `/admin/api/entries/${aboutId}/publish`, { revisionId: hookRevisionId })).status, 200);
    const transport = async (request: { url: string; body: string; headers: Record<string, string> }) => {
      seen.push(request);
      return { status: seen.length < 2 ? 500 : 200 };
    };
    await deliverDueWebhooks(fx.db, new Date(), transport, async () => ['93.184.216.34'], () => 0);
    await deliverDueWebhooks(fx.db, new Date(), transport, async () => ['93.184.216.34'], () => 0);
    assert.ok(seen.length >= 2);
    const signed = seen[0];
    assert.ok(signed);
    const payload = JSON.parse(signed.body) as { id: string; createdAt: string };
    assert.match(payload.id, /^[0-9a-f-]{36}$/i);
    assert.ok(payload.createdAt);
    const timestamp = signed.headers['webhook-timestamp'];
    assert.equal(signed.headers['webhook-signature'], `v1=${signPayload(endpoint.secret, timestamp ?? '', signed.body)}`);
    const state = fx.db.prepare('SELECT status, attempts, last_error FROM webhook_outbox LIMIT 1').get() as { status: string; attempts: number; last_error: string | null };
    assert.equal(state.status, 'delivered');
    assert.ok(state.attempts >= 2);

    const unsafe = await fetch(`${fx.origin}/admin/webhooks`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: admin.csrf, url: 'http://127.0.0.1/hook' }),
    });
    assert.equal(unsafe.status, 400);
    await assert.rejects(validateWebhookDestination('https://127.0.0.1/hook'), /blocked|not allowed/);
    await assert.rejects(validateWebhookDestination('https://hooks.example.com/inbox', async () => ['127.0.0.1']), /blocked/);
    assert.equal(isUnsafeIp('169.254.169.254'), true);
    assert.equal(isUnsafeIp('93.184.216.34'), false);
    fx.db.prepare(`UPDATE webhook_outbox SET status = 'pending', attempts = 0, next_attempt_at = ?`).run(new Date().toISOString());
    const callsBefore = seen.length;
    await deliverDueWebhooks(fx.db, new Date(), transport, async () => ['10.1.2.3'], () => 0);
    assert.equal(seen.length, callsBefore);
    const blocked = fx.db.prepare('SELECT status, last_error FROM webhook_outbox LIMIT 1').get() as { status: string; last_error: string | null };
    assert.equal(blocked.status, 'terminal');
    assert.match(blocked.last_error ?? '', /blocked|not allowed|Resolves|resolve/i);

    const redirect = await fetch(`${fx.origin}/admin/redirects`, {
      method: 'POST',
      headers: { cookie: publisher.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: publisher.csrf, localeId: fx.localeId, fromPath: '/ferry', toPath: '/about', statusCode: '301' }),
      redirect: 'manual',
    });
    assert.equal(redirect.status, 302, await redirect.clone().text());
    const open = await fetch(`${fx.origin}/admin/redirects`, {
      method: 'POST',
      headers: { cookie: publisher.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: publisher.csrf, localeId: fx.localeId, fromPath: '/out', toPath: 'https://evil.example/phish', statusCode: '302' }),
    });
    assert.equal(open.status, 400);
    const loop = await fetch(`${fx.origin}/admin/redirects`, {
      method: 'POST',
      headers: { cookie: publisher.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: publisher.csrf, localeId: fx.localeId, fromPath: '/about', toPath: '/ferry', statusCode: '301' }),
    });
    assert.equal(loop.status, 400);
    const resolved = await (await fetch(`${fx.origin}/api/public/marlow/redirect?path=${encodeURIComponent('/ferry')}`)).json() as { to: string; statusCode: number };
    assert.equal(resolved.to, '/about');
    assert.equal(resolved.statusCode, 301);
    const meta = await (await fetch(`${fx.origin}/api/public/marlow/entries/about`)).json() as { meta: { title: string; description: string } };
    assert.equal(meta.meta.title, 'About the desk');
    assert.equal(meta.meta.description, 'With webhook');
    assert.equal(JSON.stringify(meta).includes('Borrador secreto'), false);
  } finally {
    await fx.close();
  }
});
