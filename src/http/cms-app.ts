import fs from 'node:fs';
import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { DB } from '../db/db.ts';
import type { User } from '../domain/authz.ts';
import { compilePlainText, parseContentTypeDocument, type Block, type ContentTypeDocument } from '../domain/content.ts';
import { newToken, safeEqual } from '../domain/crypto.ts';
import { AppError } from '../domain/errors.ts';
import { TIMEZONES } from '../domain/time.ts';
import type { DnsLookup, Transport } from '../domain/webhooks.ts';
import { esc, renderBlocks } from '../render/blocks.ts';
import {
  addSiteMember,
  approveRevision,
  archiveEntry,
  compareRevisions,
  createContentType,
  createEntry,
  createLocale,
  createRedirect,
  createSite,
  createWebhookEndpoint,
  dashboardData,
  deliverDueWebhooks,
  entryEditorData,
  getPublicEntry,
  listJobs,
  listPublicEntries,
  listWebhookDeliveries,
  login,
  logout,
  mintPreview,
  previewMedia,
  publicMedia,
  publishEntryRevision,
  readPreview,
  readSession,
  resolveRedirect,
  rollbackEntry,
  saveMedia,
  saveRevision,
  scheduleRevision,
  sitesFor,
  updateContentType,
} from '../services/cms.ts';
import { confirmPage, editorPage, layout, loginPage } from './admin-html.ts';
import { applyIntent, draftsFromBlocks, draftsToBlocks, readDrafts, type Draft } from './editor.ts';

type Vars = { user: User; csrf: string };

export type CmsOptions = {
  db: DB;
  mediaRoot: string;
  now?: () => Date;
  secureCookies?: boolean;
  webhookLookup?: DnsLookup;
  webhookTransport?: Transport;
};

const EXAMPLE_SCHEMA = {
  version: 1,
  blocks: true,
  fields: [
    { key: 'title', label: 'Title', type: 'string', required: true, maxLength: 140 },
    { key: 'summary', label: 'Summary', type: 'text', required: false },
    { key: 'seoTitle', label: 'SEO title', type: 'string', required: false, maxLength: 70 },
    { key: 'seoDescription', label: 'SEO description', type: 'text', required: false, maxLength: 160 },
  ],
};

export function createCmsApp(options: CmsOptions) {
  const now = () => options.now?.() ?? new Date();
  const app = new Hono<{ Variables: Vars }>();

  app.use('*', async (c, next) => {
    const length = Number(c.req.header('content-length') ?? 0);
    if (length > 3_000_000) return c.json({ error: 'payload_too_large', message: 'Request is too large' }, 413);
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Frame-Options', 'DENY');
    if (!c.res.headers.get('Content-Security-Policy')) {
      c.header(
        'Content-Security-Policy',
        "default-src 'self'; img-src 'self' data:; style-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
      );
    }
    if (!c.res.headers.get('Cache-Control')) c.header('Cache-Control', 'no-store');
    if (c.req.path.startsWith('/preview')) {
      c.header('Cache-Control', 'private, no-store');
      c.header('X-Robots-Tag', 'noindex, nofollow');
    }
  });

  app.onError((err, c) => {
    const known = err instanceof AppError;
    const status = known ? err.status : 500;
    const code = known ? err.code : 'internal_error';
    const message = known ? err.message : 'Something went wrong';
    if (!known) {
      console.log(JSON.stringify({ level: 'error', event: 'unhandled', message: err instanceof Error ? err.message : 'error' }));
    }
    if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/admin/api')) {
      return c.json({ error: code, message }, status as 400);
    }
    return c.html(layout({ title: 'Error', user: null, csrf: '', body: `<div class="panel errors" role="alert"><p>${esc(message)}</p></div>` }), status as 400);
  });

  app.get('/health', (c) => c.json({ ok: true }));
  app.get('/favicon.ico', (c) => c.body(null, 204));
  app.get('/assets/admin.css', (c) => {
    const css = fs.readFileSync(new URL('../ui/admin.css', import.meta.url), 'utf8');
    return c.body(css, 200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' });
  });

  app.get('/api/public/:site/entries', (c) => {
    const items = listPublicEntries(options.db, c.req.param('site'), c.req.query('locale'), c.req.query('type'));
    return c.json({ items });
  });

  app.get('/api/public/:site/entries/:slug', (c) => {
    const entry = getPublicEntry(options.db, c.req.param('site'), c.req.param('slug'), c.req.query('locale'));
    if (!entry) return c.json({ error: 'not_found' }, 404);
    return c.json(entry);
  });

  app.get('/api/public/:site/redirect', (c) => {
    const path = c.req.query('path') ?? '';
    const result = resolveRedirect(options.db, c.req.param('site'), c.req.query('locale'), path);
    if (!result) return c.json({ error: 'not_found' }, 404);
    if ('loop' in result) return c.json({ error: 'redirect_loop' }, 508);
    return c.json(result);
  });

  app.get('/media/:id', (c) => {
    const media = publicMedia(options.db, c.req.param('id'), options.mediaRoot);
    if (!media) return c.json({ error: 'not_found' }, 404);
    return mediaResponse(fs.readFileSync(media.file), media.mime);
  });

  app.get('/preview', (c) => {
    const token = previewToken(c);
    if (!token) return c.json({ error: 'invalid_preview', message: 'Preview token is missing' }, 401);
    const entry = readPreview(options.db, token, now(), c.req.header('x-preview-revision') ?? undefined);
    return c.html(previewHtml(entry), 200, { 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex, nofollow' });
  });

  app.get('/preview/media/:id', (c) => {
    const token = previewToken(c);
    if (!token) return c.json({ error: 'invalid_preview' }, 401);
    const media = previewMedia(options.db, token, c.req.param('id'), options.mediaRoot, now());
    if (!media) return c.json({ error: 'not_found' }, 404);
    return mediaResponse(fs.readFileSync(media.file), media.mime);
  });

  app.get('/admin/login', (c) => {
    const token = newToken();
    setCookie(c, 'pre_csrf', token, cookie(options, 'Lax', '/admin/login', 600));
    return c.html(loginPage(token));
  });

  app.post('/admin/login', async (c) => {
    const form = await readForm(c);
    const expected = getCookie(c, 'pre_csrf') ?? '';
    if (!form._csrf || !safeEqual(form._csrf, expected)) {
      return c.html(loginPage(expected, 'Reload the sign-in form and try again.'), 403);
    }
    const session = login(options.db, form.email ?? '', form.password ?? '', now());
    if (!session) return c.html(loginPage(expected, 'Email or password is wrong.'), 401);
    setCookie(c, 'sid', session.token, cookie(options, 'Lax', '/', 60 * 60 * 24 * 7));
    return c.redirect('/admin');
  });

  app.use('/admin/*', async (c, next) => {
    if (c.req.path === '/admin/login') return next();
    const token = getCookie(c, 'sid');
    const session = token ? readSession(options.db, token, now()) : null;
    if (!session) {
      if (c.req.path.startsWith('/admin/api')) return c.json({ error: 'unauthorized', message: 'Sign in required' }, 401);
      return c.redirect('/admin/login');
    }
    c.set('user', session.user);
    c.set('csrf', session.csrf);
    if (c.req.method === 'POST' || c.req.method === 'DELETE') {
      const header = c.req.header('x-csrf-token');
      const type = c.req.header('content-type') ?? '';
      let provided = header;
      if (!provided && type.includes('application/json')) {
        const json = await c.req.json().catch(() => ({}));
        provided = typeof (json as { _csrf?: unknown })._csrf === 'string' ? (json as { _csrf: string })._csrf : undefined;
      } else if (!provided) {
        const form = await readForm(c);
        provided = form._csrf;
      }
      if (!provided || !safeEqual(provided, session.csrf)) {
        throw new AppError(403, 'invalid_csrf', 'The form token is missing or expired. Reload and try again.');
      }
    }
    await next();
  });

  app.post('/admin/logout', (c) => {
    const token = getCookie(c, 'sid');
    if (token) logout(options.db, token);
    setCookie(c, 'sid', '', cookie(options, 'Lax', '/', 0));
    return c.redirect('/admin/login');
  });

  app.get('/admin', (c) => {
    const site = currentSite(c, options.db);
    const data = dashboardData(options.db, c.get('user'), site.id);
    const rows = (data.entries as Array<Record<string, unknown>>)
      .map((entry) => `<tr>
        <td><a href="/admin/entries/${esc(entry.id)}">${esc(entry.slug)}</a></td>
        <td>${esc(entry.type_name)}</td>
        <td>${esc(entry.locale_code)}</td>
        <td class="status">${esc(entry.status)}</td>
        <td>${esc(entry.latest_number)}</td>
        <td>${esc(entry.published_number ?? '')}</td>
      </tr>`)
      .join('');
    return c.html(layout({
      title: 'Entries',
      user: c.get('user'),
      csrf: c.get('csrf'),
      body: `<h1>${esc(site.name)}</h1>
        <p class="muted">Public pages come from a published revision. A newer save stays off the site until it is approved and published.</p>
        <p><a class="button" href="/admin/entries/new">New entry</a></p>
        <table><thead><tr><th>Slug</th><th>Type</th><th>Locale</th><th>Status</th><th>Latest</th><th>Public</th></tr></thead><tbody>${rows || '<tr><td colspan="6">No entries yet.</td></tr>'}</tbody></table>`,
    }));
  });

  app.get('/admin/entries/new', (c) => {
    const site = currentSite(c, options.db);
    const data = dashboardData(options.db, c.get('user'), site.id);
    return c.html(newEntryPage(c.get('user'), c.get('csrf'), data));
  });

  app.post('/admin/entries', async (c) => {
    const form = await readForm(c);
    const site = currentSite(c, options.db);
    const data = dashboardData(options.db, c.get('user'), site.id);
    const contentType = (data.types as Array<{ id: string; schema_json: string }>).find((item) => item.id === form.contentTypeId);
    if (!contentType) throw new AppError(400, 'invalid_entry', 'Choose a content type');
    const document = parseContentTypeDocument(JSON.parse(contentType.schema_json));
    const created = createEntry(options.db, c.get('user'), {
      siteId: site.id,
      contentTypeId: form.contentTypeId ?? '',
      localeId: form.localeId ?? '',
      slug: form.slug ?? '',
      fields: fieldsFromForm(document, form),
      blocks: [],
    });
    return c.redirect(`/admin/entries/${created.entryId}`);
  });

  app.get('/admin/entries/:id', (c) => c.html(renderEditor(options.db, c.get('user'), c.get('csrf'), c.req.param('id'), [])));

  app.post('/admin/entries/:id/edit', async (c) => {
    const form = await readForm(c);
    const user = c.get('user');
    const csrf = c.get('csrf');
    const entryId = c.req.param('id');
    const intent = form.intent || 'save';
    try {
      const drafts = intent === 'save' ? readDrafts(form) : applyIntent(readDrafts(form), intent);
      if (intent !== 'save') {
        return c.html(renderEditor(options.db, user, csrf, entryId, [], drafts, form));
      }
      const data = entryEditorData(options.db, user, entryId);
      saveRevision(options.db, user, entryId, {
        fields: fieldsFromForm(data.document, form),
        blocks: draftsToBlocks(drafts),
      });
      return c.redirect(`/admin/entries/${entryId}`);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      return c.html(renderEditor(options.db, user, csrf, entryId, [error.message], undefined, form), error.status as 400);
    }
  });

  app.post('/admin/revisions/:id/approve', (c) => {
    approveRevision(options.db, c.get('user'), c.req.param('id'), now());
    const revision = options.db.prepare('SELECT entry_id FROM revisions WHERE id = ?').get(c.req.param('id')) as { entry_id: string };
    return c.redirect(`/admin/entries/${revision.entry_id}`);
  });

  app.get('/admin/entries/:id/publish', (c) => {
    const revision = c.req.query('revision') ?? '';
    return c.html(confirmPage({
      user: c.get('user'),
      csrf: c.get('csrf'),
      title: 'Publish revision',
      action: `/admin/entries/${c.req.param('id')}/publish`,
      hidden: { revisionId: revision },
      message: 'Publishing makes this exact approved revision the public version. The previous public revision stays in history.',
    }));
  });

  app.post('/admin/entries/:id/publish', async (c) => {
    const form = await readForm(c);
    requireConfirm(form);
    publishEntryRevision(options.db, c.get('user'), c.req.param('id'), form.revisionId ?? '', now());
    return c.redirect(`/admin/entries/${c.req.param('id')}`);
  });

  app.get('/admin/entries/:id/schedule', (c) => {
    const zones = TIMEZONES.map((zone) => `<option value="${zone}">${zone}</option>`).join('');
    return c.html(layout({
      title: 'Schedule',
      user: c.get('user'),
      csrf: c.get('csrf'),
      body: `<h1>Schedule publication</h1>
        <form class="panel stack" method="post" action="/admin/entries/${esc(c.req.param('id'))}/schedule">
          <input type="hidden" name="_csrf" value="${esc(c.get('csrf'))}" />
          <input type="hidden" name="revisionId" value="${esc(c.req.query('revision') ?? '')}" />
          <label for="local">Local time</label>
          <input id="local" name="local" type="datetime-local" required />
          <label for="timezone">Timezone</label>
          <select id="timezone" name="timezone">${zones}</select>
          <p class="muted">The worker stores the instant in UTC and publishes this revision, not whatever draft is newest later.</p>
          <label><input type="checkbox" name="confirm" value="yes" /> Schedule this approved revision.</label>
          <button type="submit">Schedule</button>
        </form>`,
    }));
  });

  app.post('/admin/entries/:id/schedule', async (c) => {
    const form = await readForm(c);
    requireConfirm(form);
    scheduleRevision(options.db, c.get('user'), c.req.param('id'), form.revisionId ?? '', form.local ?? '', form.timezone ?? 'UTC', now());
    return c.redirect('/admin/jobs');
  });

  app.get('/admin/entries/:id/archive', (c) => c.html(confirmPage({
    user: c.get('user'),
    csrf: c.get('csrf'),
    title: 'Archive entry',
    action: `/admin/entries/${c.req.param('id')}/archive`,
    hidden: {},
    message: 'Archived entries disappear from the public API, the public site, and reference expansion. Publication history is kept.',
  })));

  app.post('/admin/entries/:id/archive', async (c) => {
    const form = await readForm(c);
    requireConfirm(form);
    archiveEntry(options.db, c.get('user'), c.req.param('id'), now());
    return c.redirect(`/admin/entries/${c.req.param('id')}`);
  });

  app.get('/admin/entries/:id/rollback', (c) => c.html(confirmPage({
    user: c.get('user'),
    csrf: c.get('csrf'),
    title: 'Roll back',
    action: `/admin/entries/${c.req.param('id')}/rollback`,
    hidden: { revisionId: c.req.query('revision') ?? '' },
    message: 'Rollback publishes an earlier published revision and writes a new audit event. It does not delete history.',
  })));

  app.post('/admin/entries/:id/rollback', async (c) => {
    const form = await readForm(c);
    requireConfirm(form);
    rollbackEntry(options.db, c.get('user'), c.req.param('id'), form.revisionId ?? '', now());
    return c.redirect(`/admin/entries/${c.req.param('id')}`);
  });

  app.post('/admin/entries/:id/preview', async (c) => {
    const form = await readForm(c);
    const minted = mintPreview(options.db, c.get('user'), form.revisionId ?? '', now());
    setCookie(c, 'preview', minted.token, { ...cookie(options, 'Strict', '/preview', 900), httpOnly: true });
    return c.redirect('/preview');
  });

  app.get('/admin/entries/:id/compare', (c) => {
    const data = entryEditorData(options.db, c.get('user'), c.req.param('id'));
    const optionsHtml = data.revisions
      .map((revision) => `<option value="${esc(revision.id)}">${esc(revision.revision_number)}</option>`)
      .join('');
    const left = c.req.query('a') ?? data.revisions[1]?.id ?? data.revisions[0]?.id ?? '';
    const right = c.req.query('b') ?? data.revisions[0]?.id ?? '';
    let body = '';
    if (left && right) {
      const diff = compareRevisions(options.db, c.get('user'), c.req.param('id'), left, right);
      const fields = diff.fields
        .filter((field) => field.change !== 'same')
        .map((field) => `<li>${esc(field.key)} ${esc(field.change)}: ${esc(JSON.stringify(field.before))} → ${esc(JSON.stringify(field.after))}</li>`)
        .join('');
      const blocks = diff.blocks
        .filter((block) => block.change !== 'same')
        .map((block) => `<li>Block ${block.index} ${esc(block.change)} ${esc(block.beforeType ?? '')} ${esc(block.afterType ?? '')}</li>`)
        .join('');
      body = `<h2>Changes</h2><ul>${fields || '<li>No field changes.</li>'}</ul><ul>${blocks || '<li>No block changes.</li>'}</ul>`;
    }
    return c.html(layout({
      title: 'Compare',
      user: c.get('user'),
      csrf: c.get('csrf'),
      body: `<h1>Compare revisions</h1>
        <form class="row" method="get">
          <label>From <select name="a">${optionsHtml}</select></label>
          <label>To <select name="b">${optionsHtml}</select></label>
          <button type="submit">Compare</button>
        </form>${body}`,
    }));
  });

  app.get('/admin/types', (c) => {
    const site = currentSite(c, options.db);
    const data = dashboardData(options.db, c.get('user'), site.id);
    const rows = (data.types as Array<{ id: string; name: string; api_key: string; schema_version: number }>)
      .map((type) => `<li><a href="/admin/types/${esc(type.id)}">${esc(type.name)}</a> <span class="muted">${esc(type.api_key)} · v${esc(type.schema_version)}</span></li>`)
      .join('');
    return c.html(layout({
      title: 'Content types',
      user: c.get('user'),
      csrf: c.get('csrf'),
      body: `<h1>Content types</h1><p><a class="button" href="/admin/types/new">New type</a></p><ul>${rows || '<li>No types yet.</li>'}</ul>`,
    }));
  });

  app.get('/admin/types/new', (c) => c.html(layout({
    title: 'New type',
    user: c.get('user'),
    csrf: c.get('csrf'),
    body: `<h1>New content type</h1>
      <form class="panel stack" method="post" action="/admin/types">
        <input type="hidden" name="_csrf" value="${esc(c.get('csrf'))}" />
        <label for="name">Name</label><input id="name" name="name" required />
        <label for="apiKey">API key</label><input id="apiKey" name="apiKey" required />
        <label for="document">Schema</label>
        <textarea id="document" name="document">${esc(JSON.stringify(EXAMPLE_SCHEMA, null, 2))}</textarea>
        <button type="submit">Create type</button>
      </form>`,
  })));

  app.post('/admin/types', async (c) => {
    const form = await readForm(c);
    const site = currentSite(c, options.db);
    let document: unknown;
    try {
      document = JSON.parse(form.document ?? '');
    } catch {
      throw new AppError(400, 'invalid_schema', 'Schema must be JSON');
    }
    const created = createContentType(options.db, c.get('user'), {
      siteId: site.id,
      apiKey: form.apiKey ?? '',
      name: form.name ?? '',
      document,
    });
    return c.redirect(`/admin/types/${created.id}`);
  });

  app.get('/admin/types/:id', (c) => {
    const row = options.db.prepare('SELECT * FROM content_types WHERE id = ?').get(c.req.param('id')) as { name: string; schema_json: string; schema_version: number } | undefined;
    if (!row) return c.json({ error: 'not_found' }, 404);
    return c.html(layout({
      title: row.name,
      user: c.get('user'),
      csrf: c.get('csrf'),
      body: `<h1>${esc(row.name)}</h1><p class="muted">Schema version ${esc(row.schema_version)}. Removing fields or changing types is rejected after entries exist.</p>
        <form class="panel stack" method="post" action="/admin/types/${esc(c.req.param('id'))}">
          <input type="hidden" name="_csrf" value="${esc(c.get('csrf'))}" />
          <label for="document">Schema</label>
          <textarea id="document" name="document">${esc(JSON.stringify(JSON.parse(row.schema_json), null, 2))}</textarea>
          <button type="submit">Save schema</button>
        </form>`,
    }));
  });

  app.post('/admin/types/:id', async (c) => {
    const form = await readForm(c);
    let document: unknown;
    try {
      document = JSON.parse(form.document ?? '');
    } catch {
      throw new AppError(400, 'invalid_schema', 'Schema must be JSON');
    }
    updateContentType(options.db, c.get('user'), c.req.param('id'), document);
    return c.redirect(`/admin/types/${c.req.param('id')}`);
  });

  app.get('/admin/media', (c) => {
    const site = currentSite(c, options.db);
    const data = dashboardData(options.db, c.get('user'), site.id);
    const items = (data.media as Array<{ alt: string; original_name: string; mime: string }>).
      map((item) => `<li>${esc(item.alt)} <span class="muted">${esc(item.original_name)} · ${esc(item.mime)}</span></li>`).join('');
    return c.html(layout({
      title: 'Media',
      user: c.get('user'),
      csrf: c.get('csrf'),
      body: `<h1>Media</h1>
        <form class="panel stack" method="post" action="/admin/media" enctype="multipart/form-data">
          <input type="hidden" name="_csrf" value="${esc(c.get('csrf'))}" />
          <label for="file">Image file</label><input id="file" name="file" type="file" accept="image/png,image/jpeg,image/gif,image/webp" required />
          <label for="alt">Alt text</label><input id="alt" name="alt" required />
          <button type="submit">Upload</button>
        </form>
        <ul>${items || '<li>No media yet.</li>'}</ul>`,
    }));
  });

  app.post('/admin/media', async (c) => {
    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) throw new AppError(400, 'invalid_media', 'Choose a file');
    const bytes = Buffer.from(await file.arrayBuffer());
    const site = currentSite(c, options.db);
    saveMedia(options.db, c.get('user'), options.mediaRoot, {
      siteId: site.id,
      bytes,
      originalName: file.name,
      alt: String(body.alt ?? ''),
    });
    return c.redirect('/admin/media');
  });

  app.get('/admin/redirects', (c) => {
    const site = currentSite(c, options.db);
    const data = dashboardData(options.db, c.get('user'), site.id);
    const locales = (data.locales as Array<{ id: string; code: string }>).map((locale) => `<option value="${esc(locale.id)}">${esc(locale.code)}</option>`).join('');
    const rows = (data.redirects as Array<{ from_path: string; to_path: string; status_code: number; locale_code: string }>)
      .map((row) => `<li>${esc(row.locale_code)} ${esc(row.from_path)} → ${esc(row.to_path)} (${esc(row.status_code)})</li>`)
      .join('');
    return c.html(layout({
      title: 'Redirects',
      user: c.get('user'),
      csrf: c.get('csrf'),
      body: `<h1>Redirects</h1>
        <form class="panel stack" method="post" action="/admin/redirects">
          <input type="hidden" name="_csrf" value="${esc(c.get('csrf'))}" />
          <label for="localeId">Locale</label><select id="localeId" name="localeId">${locales}</select>
          <label for="fromPath">From</label><input id="fromPath" name="fromPath" placeholder="/ferry" />
          <label for="toPath">To</label><input id="toPath" name="toPath" placeholder="/ferry-schedule" />
          <label for="statusCode">Status</label><select id="statusCode" name="statusCode"><option value="301">301</option><option value="302">302</option></select>
          <button type="submit">Add redirect</button>
        </form><ul>${rows || '<li>No redirects.</li>'}</ul>`,
    }));
  });

  app.post('/admin/redirects', async (c) => {
    const form = await readForm(c);
    const site = currentSite(c, options.db);
    createRedirect(options.db, c.get('user'), {
      siteId: site.id,
      localeId: form.localeId ?? '',
      fromPath: form.fromPath ?? '',
      toPath: form.toPath ?? '',
      statusCode: Number(form.statusCode ?? 301),
    });
    return c.redirect('/admin/redirects');
  });

  app.get('/admin/jobs', (c) => {
    const site = currentSite(c, options.db);
    const jobs = listJobs(options.db, c.get('user'), site.id) as Array<Record<string, unknown>>;
    const rows = jobs.map((job) => `<tr><td>${esc(job.slug)}</td><td class="status">${esc(job.status)}</td><td>${esc(job.run_at)} UTC</td><td>${esc(job.timezone)} ${esc(job.local_input)}</td><td>${esc(job.attempts)}</td><td>${esc(job.last_error ?? '')}</td></tr>`).join('');
    return c.html(layout({
      title: 'Schedule',
      user: c.get('user'),
      csrf: c.get('csrf'),
      body: `<h1>Scheduled publication</h1><p class="muted">Times below are the stored UTC instant. The timezone column is what the editor selected.</p><table><thead><tr><th>Entry</th><th>Status</th><th>UTC</th><th>Selected zone</th><th>Attempts</th><th>Error</th></tr></thead><tbody>${rows || '<tr><td colspan="6">No jobs.</td></tr>'}</tbody></table>`,
    }));
  });

  app.get('/admin/webhooks', (c) => {
    const site = currentSite(c, options.db);
    const deliveries = listWebhookDeliveries(options.db, c.get('user'), site.id) as Array<Record<string, unknown>>;
    const rows = deliveries.map((row) => `<tr><td>${esc(row.status)}</td><td>${esc(row.attempts)}</td><td>${esc(row.url)}</td><td>${esc(row.last_error ?? '')}</td><td>${esc(row.last_response_status ?? '')}</td></tr>`).join('');
    return c.html(layout({
      title: 'Webhooks',
      user: c.get('user'),
      csrf: c.get('csrf'),
      body: `<h1>Webhooks</h1>
        <p class="muted">Payloads are signed as <code>v1=HMAC-SHA256(secret, timestamp + "." + rawBody)</code>. Receivers should reject timestamps older than five minutes and dedupe <code>id</code>. Redirects are not followed.</p>
        <form class="panel stack" method="post" action="/admin/webhooks">
          <input type="hidden" name="_csrf" value="${esc(c.get('csrf'))}" />
          <label for="url">HTTPS endpoint</label><input id="url" name="url" type="url" placeholder="https://example.com/hooks" required />
          <button type="submit">Add endpoint</button>
        </form>
        <table><thead><tr><th>Status</th><th>Attempts</th><th>URL</th><th>Error</th><th>HTTP</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No deliveries.</td></tr>'}</tbody></table>`,
    }));
  });

  app.post('/admin/webhooks', async (c) => {
    const form = await readForm(c);
    const site = currentSite(c, options.db);
    const created = await createWebhookEndpoint(options.db, c.get('user'), { siteId: site.id, url: form.url ?? '' }, options.webhookLookup);
    return c.html(layout({
      title: 'Webhook secret',
      user: c.get('user'),
      csrf: c.get('csrf'),
      body: `<h1>Endpoint added</h1><p>Copy this signing secret now. It is stored for delivery and is not shown in logs.</p><p class="panel"><code>${esc(created.secret)}</code></p><p><a href="/admin/webhooks">Back</a></p>`,
    }));
  });

  app.get('/admin/sites', (c) => {
    const sites = sitesFor(options.db, c.get('user'));
    const items = sites.map((site) => `<li><a href="/admin?site=${esc(site.slug)}">${esc(site.name)}</a></li>`).join('');
    return c.html(layout({
      title: 'Sites',
      user: c.get('user'),
      csrf: c.get('csrf'),
      body: `<h1>Sites</h1><ul>${items}</ul>
        <form class="panel stack" method="post" action="/admin/sites">
          <input type="hidden" name="_csrf" value="${esc(c.get('csrf'))}" />
          <label for="name">Name</label><input id="name" name="name" required />
          <label for="slug">Slug</label><input id="slug" name="slug" required />
          <button type="submit">Create site</button>
        </form>
        <form class="panel stack" method="post" action="/admin/locales">
          <input type="hidden" name="_csrf" value="${esc(c.get('csrf'))}" />
          <label for="code">Locale code</label><input id="code" name="code" placeholder="es" />
          <label for="localeName">Name</label><input id="localeName" name="localeName" />
          <label for="fallback">Fallback locale id</label><input id="fallback" name="fallback" />
          <button type="submit">Add locale</button>
        </form>`,
    }));
  });

  app.post('/admin/sites', async (c) => {
    const form = await readForm(c);
    createSite(options.db, c.get('user'), { name: form.name ?? '', slug: form.slug ?? '' });
    return c.redirect('/admin/sites');
  });

  app.post('/admin/locales', async (c) => {
    const form = await readForm(c);
    const site = currentSite(c, options.db);
    createLocale(options.db, c.get('user'), {
      siteId: site.id,
      code: form.code ?? '',
      name: form.localeName ?? form.code ?? '',
      fallbackLocaleId: form.fallback || null,
      isDefault: false,
    });
    return c.redirect('/admin/sites');
  });

  app.post('/admin/api/entries/:id/revisions', async (c) => {
    const body = await c.req.json();
    const revision = saveRevision(options.db, c.get('user'), c.req.param('id'), { fields: body.fields, blocks: body.blocks });
    return c.json({ id: revision.id, revisionNumber: revision.revision_number });
  });

  app.post('/admin/api/content-types', async (c) => {
    const body = await c.req.json();
    const site = currentSite(c, options.db);
    const created = createContentType(options.db, c.get('user'), {
      siteId: body.siteId ?? site.id,
      apiKey: body.apiKey,
      name: body.name,
      document: body.document,
    });
    return c.json({ id: created.id });
  });

  app.post('/admin/api/entries', async (c) => {
    const body = await c.req.json();
    const created = createEntry(options.db, c.get('user'), body);
    return c.json(created);
  });

  app.post('/admin/api/revisions/:id/approve', (c) => {
    approveRevision(options.db, c.get('user'), c.req.param('id'), now());
    return c.json({ ok: true });
  });

  app.post('/admin/api/entries/:id/publish', async (c) => {
    const body = await c.req.json();
    const result = publishEntryRevision(options.db, c.get('user'), c.req.param('id'), body.revisionId, now());
    return c.json(result);
  });

  app.post('/admin/api/entries/:id/schedule', async (c) => {
    const body = await c.req.json();
    const result = scheduleRevision(options.db, c.get('user'), c.req.param('id'), body.revisionId, body.local, body.timezone, now());
    return c.json(result);
  });

  app.post('/admin/api/entries/:id/archive', (c) => {
    archiveEntry(options.db, c.get('user'), c.req.param('id'), now());
    return c.json({ ok: true });
  });

  app.post('/admin/api/entries/:id/rollback', async (c) => {
    const body = await c.req.json();
    const result = rollbackEntry(options.db, c.get('user'), c.req.param('id'), body.revisionId, now());
    return c.json(result);
  });

  app.post('/admin/api/revisions/:id/preview', (c) => {
    const minted = mintPreview(options.db, c.get('user'), c.req.param('id'), now());
    return c.json(minted);
  });

  app.post('/admin/api/deliver-webhooks', async (c) => {
    if (!options.webhookTransport) throw new AppError(400, 'no_transport', 'No test transport is configured');
    const count = await deliverDueWebhooks(options.db, now(), options.webhookTransport, options.webhookLookup, () => 0);
    return c.json({ delivered: count });
  });

  return app;
}

function cookie(options: CmsOptions, sameSite: 'Lax' | 'Strict', path: string, maxAge: number) {
  return {
    httpOnly: true,
    sameSite,
    path,
    secure: options.secureCookies ?? false,
    maxAge,
  };
}

function previewToken(c: { req: { header: (name: string) => string | undefined } }): string | null {
  const header = c.req.header('authorization') ?? '';
  if (header.startsWith('Preview ')) return header.slice('Preview '.length);
  return getCookie(c as never, 'preview') ?? null;
}

function mediaResponse(bytes: Buffer, mime: string) {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'content-type': mime,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'",
      'cache-control': 'no-store',
      'content-disposition': 'inline',
    },
  });
}

function previewHtml(entry: { meta: { title: string }; blocks: Block[]; references: Record<string, { status: string }>; revisionId: string }): string {
  const body = renderBlocks(entry.blocks, {
    mediaSrc: (id) => `/preview/media/${id}`,
    entryHref: () => '#',
    references: entry.references as never,
  });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="referrer" content="no-referrer" /><meta name="robots" content="noindex, nofollow" /><title>Preview: ${esc(entry.meta.title)}</title><link rel="stylesheet" href="/assets/admin.css" /></head><body><main id="main" class="panel"><p class="status warn">Private preview of revision ${esc(entry.revisionId)}. This is not public.</p>${body}</main></body></html>`;
}

async function readForm(c: { req: { parseBody: () => Promise<Record<string, unknown>> } }): Promise<Record<string, string>> {
  const body = await c.req.parseBody();
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

function requireConfirm(form: Record<string, string>): void {
  if (form.confirm !== 'yes') throw new AppError(400, 'confirmation_required', 'Confirm the action before continuing');
}

function currentSite(c: { req: { query: (name: string) => string | undefined }; get: (key: 'user') => User }, db: DB) {
  const sites = sitesFor(db, c.get('user'));
  const requested = c.req.query('site');
  const site = sites.find((item) => item.slug === requested) ?? sites[0];
  if (!site) throw new AppError(404, 'not_found', 'No site is available for this account');
  return site;
}

function fieldsFromForm(document: ContentTypeDocument, form: Record<string, string>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const field of document.fields) {
    const raw = form[`field_${field.key}`];
    if (raw === undefined || raw === '') continue;
    if (field.type === 'number') fields[field.key] = Number(raw);
    else if (field.type === 'boolean') fields[field.key] = raw === 'true';
    else if (field.type === 'richtext') fields[field.key] = compilePlainText(raw);
    else fields[field.key] = raw;
  }
  return fields;
}

function fieldValuesFrom(fields: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[key] = String(value);
    else if (Array.isArray(value)) {
      out[key] = (value as Array<{ kind: string; text: string }>)
        .map((node) => (node.kind === 'h2' ? `## ${node.text}` : node.kind === 'h3' ? `### ${node.text}` : node.kind === 'quote' ? `> ${node.text}` : node.text))
        .join('\n\n');
    }
  }
  return out;
}

function renderEditor(
  db: DB,
  user: User,
  csrf: string,
  entryId: string,
  errors: string[],
  drafts?: Draft[],
  form?: Record<string, string>,
): string {
  const data = entryEditorData(db, user, entryId);
  const latest = data.revisions[0];
  const fields = latest ? (JSON.parse(latest.fields_json) as Record<string, unknown>) : {};
  const blocks = latest ? (JSON.parse(latest.blocks_json) as Block[]) : [];
  const fieldValues = form ? fieldValuesFrom(fieldsFromForm(data.document, form)) : fieldValuesFrom(fields);
  const approved = new Set(data.approvals.map((approval) => approval.revision_id));
  return editorPage({
    user,
    csrf,
    entryId,
    slug: data.entry.slug,
    locale: data.locale.code,
    status: data.entry.status,
    typeName: data.contentType.name,
    document: data.document,
    fieldValues,
    drafts: drafts ?? draftsFromBlocks(blocks),
    revisions: data.revisions.map((revision) => ({
      id: revision.id,
      revision_number: revision.revision_number,
      created_at: revision.created_at,
      approved: approved.has(revision.id),
      published: revision.id === data.entry.published_revision_id,
    })),
    errors,
    media: data.media,
    entries: data.entryChoices,
  });
}

function newEntryPage(user: User, csrf: string, data: ReturnType<typeof dashboardData>): string {
  const types = (data.types as Array<{ id: string; name: string }>).map((type) => `<option value="${esc(type.id)}">${esc(type.name)}</option>`).join('');
  const locales = (data.locales as Array<{ id: string; code: string }>).map((locale) => `<option value="${esc(locale.id)}">${esc(locale.code)}</option>`).join('');
  const doc = (data.types as Array<{ schema_json: string }>)[0];
  const sample = doc ? parseContentTypeDocument(JSON.parse(doc.schema_json)) : null;
  const fields = sample ? sample.fields.map((field) => `<label for="field_${esc(field.key)}">${esc(field.label)}</label><input id="field_${esc(field.key)}" name="field_${esc(field.key)}" />`).join('') : '';
  return layout({
    title: 'New entry',
    user,
    csrf,
    body: `<h1>New entry</h1>
      <form class="panel stack" method="post" action="/admin/entries">
        <input type="hidden" name="_csrf" value="${esc(csrf)}" />
        <label for="contentTypeId">Type</label><select id="contentTypeId" name="contentTypeId">${types}</select>
        <label for="localeId">Locale</label><select id="localeId" name="localeId">${locales}</select>
        <label for="slug">Slug</label><input id="slug" name="slug" required />
        ${fields}
        <button type="submit">Create draft</button>
      </form>`,
  });
}
