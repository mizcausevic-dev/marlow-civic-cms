import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createWebApp } from '../src/web/app.ts';
import { api, fixture, listen, pageDocument, signIn } from './helpers.ts';

test('scenario 7 separate frontend renders the published API entry', async () => {
  const fx = await fixture();
  const web = await listen(createWebApp({ cmsOrigin: fx.origin, siteSlug: 'marlow' }));
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
    const created = await api(fx.origin, editor, '/admin/api/entries', {
      siteId: fx.siteId,
      contentTypeId: typeId,
      localeId: fx.localeId,
      slug: 'home',
      fields: { title: 'Marlow Civic Desk', summary: 'Public summary', seoTitle: 'Marlow Civic Desk', seoDescription: 'Published through the API.' },
      blocks: [{ type: 'hero', props: { heading: 'The harbor vote is Thursday', subheading: 'Public subheading', ctaLabel: '', ctaHref: '' } }],
    });
    const entryId = (created.json as { entryId: string }).entryId;
    const revisionId = (created.json as { revisionId: string }).revisionId;
    assert.equal((await api(fx.origin, publisher, `/admin/api/revisions/${revisionId}/approve`)).status, 200);
    assert.equal((await api(fx.origin, publisher, `/admin/api/entries/${entryId}/publish`, { revisionId })).status, 200);
    await api(fx.origin, editor, `/admin/api/entries/${entryId}/revisions`, {
      fields: { title: 'Secret draft title' },
      blocks: [{ type: 'hero', props: { heading: 'Secret draft headline', subheading: '', ctaLabel: '', ctaHref: '' } }],
    });
    const page = await fetch(`${web.origin}/`);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /The harbor vote is Thursday/);
    assert.equal(html.includes('Secret draft headline'), false);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    const missing = await fetch(`${web.origin}/missing-page`);
    assert.equal(missing.status, 404);
  } finally {
    await web.close();
    await fx.close();
  }
});

test('public frontend source does not read the CMS database', () => {
  const directory = path.resolve(import.meta.dirname, '../src/web');
  for (const file of fs.readdirSync(directory)) {
    const source = fs.readFileSync(path.join(directory, file), 'utf8');
    assert.equal(source.includes('../db/'), false, file);
    assert.equal(source.includes('../services/'), false, file);
    assert.equal(source.includes('node:sqlite'), false, file);
  }
});
