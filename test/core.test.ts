import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api, fixture, pageDocument, signIn } from './helpers.ts';

const hero = {
  type: 'hero',
  props: { heading: 'The harbor vote is Thursday', subheading: 'Six crossings.', ctaLabel: 'Read', ctaHref: '/ferry-schedule' },
};

test('scenarios 1-10 core publishing path', async () => {
  const fx = await fixture();
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
    assert.equal(type.status, 200, JSON.stringify(type.json));
    const typeId = (type.json as { id: string }).id;

    const invalid = await api(fx.origin, editor, '/admin/api/entries', {
      siteId: fx.siteId,
      contentTypeId: typeId,
      localeId: fx.localeId,
      slug: 'bad-count',
      fields: { title: 'Bad', count: 'nope' },
      blocks: [],
    });
    assert.equal(invalid.status, 400);

    const created = await api(fx.origin, editor, '/admin/api/entries', {
      siteId: fx.siteId,
      contentTypeId: typeId,
      localeId: fx.localeId,
      slug: 'harbor-vote',
      fields: { title: 'Harbor vote', summary: 'Thursday night', seoTitle: 'Harbor vote', seoDescription: 'The Thursday vote.' },
      blocks: [hero, { type: 'richText', props: { nodes: [{ kind: 'p', text: 'The pier office posted the card.' }] } }],
    });
    assert.equal(created.status, 200, JSON.stringify(created.json));
    const entryId = (created.json as { entryId: string }).entryId;
    const revisionId = (created.json as { revisionId: string }).revisionId;

    const hidden = await fetch(`${fx.origin}/api/public/marlow/entries/harbor-vote`);
    const hiddenBody = await hidden.text();
    assert.equal(hidden.status, 404);
    assert.equal(hiddenBody.includes('Harbor vote'), false);
    assert.equal(hidden.headers.get('cache-control'), 'no-store');

    const preview = await api(fx.origin, editor, `/admin/api/revisions/${revisionId}/preview`);
    assert.equal(preview.status, 200);
    const token = (preview.json as { token: string }).token;
    const previewPage = await fetch(`${fx.origin}/preview`, { headers: { authorization: `Preview ${token}` } });
    const previewHtml = await previewPage.text();
    assert.equal(previewPage.status, 200);
    assert.match(previewHtml, /The harbor vote is Thursday/);
    assert.equal(previewPage.headers.get('cache-control'), 'private, no-store');
    assert.match(previewPage.headers.get('x-robots-tag') ?? '', /noindex/);

    const tampered = await fetch(`${fx.origin}/preview`, { headers: { authorization: 'Preview not-a-real-token' } });
    assert.equal(tampered.status, 401);
    fx.db.prepare('UPDATE preview_tokens SET expires_at = ?').run('2000-01-01T00:00:00.000Z');
    const expired = await fetch(`${fx.origin}/preview`, { headers: { authorization: `Preview ${token}` } });
    assert.equal(expired.status, 401);
    const fresh = await api(fx.origin, editor, `/admin/api/revisions/${revisionId}/preview`);
    const freshToken = (fresh.json as { token: string }).token;
    const scoped = await fetch(`${fx.origin}/preview`, {
      headers: { authorization: `Preview ${freshToken}`, 'x-preview-revision': '00000000-0000-4000-8000-000000000000' },
    });
    assert.equal(scoped.status, 403);

    const editorApprove = await api(fx.origin, editor, `/admin/api/revisions/${revisionId}/approve`);
    assert.equal(editorApprove.status, 403);
    const editorPublish = await api(fx.origin, editor, `/admin/api/entries/${entryId}/publish`, { revisionId });
    assert.equal(editorPublish.status, 403);
    const anonymous = await fetch(`${fx.origin}/admin/entries/${entryId}`, { redirect: 'manual' });
    assert.equal(anonymous.status, 302);

    const approved = await api(fx.origin, publisher, `/admin/api/revisions/${revisionId}/approve`);
    assert.equal(approved.status, 200);
    const published = await api(fx.origin, publisher, `/admin/api/entries/${entryId}/publish`, { revisionId });
    assert.equal(published.status, 200, JSON.stringify(published.json));

    const live = await fetch(`${fx.origin}/api/public/marlow/entries/harbor-vote`);
    const liveJson = await live.json() as { meta: { title: string }; revisionId: string };
    assert.equal(live.status, 200);
    assert.equal(liveJson.meta.title, 'Harbor vote');
    assert.equal(liveJson.revisionId, revisionId);

    const edited = await api(fx.origin, editor, `/admin/api/entries/${entryId}/revisions`, {
      fields: { title: 'Unapproved rewrite', summary: 'Not public' },
      blocks: [hero],
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.json));
    const newRevision = (edited.json as { id: string }).id;
    const approval = fx.db.prepare('SELECT id FROM approvals WHERE revision_id = ?').get(newRevision);
    assert.equal(approval, undefined);
    const still = await fetch(`${fx.origin}/api/public/marlow/entries/harbor-vote`);
    const stillJson = await still.json() as { meta: { title: string }; revisionId: string };
    assert.equal(stillJson.meta.title, 'Harbor vote');
    assert.equal(stillJson.revisionId, revisionId);
    assert.equal(JSON.stringify(stillJson).includes('Unapproved rewrite'), false);

    const badProps = await api(fx.origin, editor, `/admin/api/entries/${entryId}/revisions`, {
      fields: { title: 'Harbor vote' },
      blocks: [{ type: 'hero', props: { heading: '', subheading: '', ctaLabel: 'Go', ctaHref: '' } }],
    });
    assert.equal(badProps.status, 400);
    const unknown = await api(fx.origin, editor, `/admin/api/entries/${entryId}/revisions`, {
      fields: { title: 'Harbor vote' },
      blocks: [{ type: 'script', props: { heading: 'nope' } }],
    });
    assert.equal(unknown.status, 400);
    const nested = columns(4);
    const tooDeep = await api(fx.origin, editor, `/admin/api/entries/${entryId}/revisions`, {
      fields: { title: 'Harbor vote' },
      blocks: [nested],
    });
    assert.equal(tooDeep.status, 400);
    const badRef = await api(fx.origin, editor, `/admin/api/entries/${entryId}/revisions`, {
      fields: { title: 'Harbor vote' },
      blocks: [{ type: 'reference', props: { entryId: '00000000-0000-4000-8000-000000000099' } }],
    });
    assert.equal(badRef.status, 400);

    const immutable = () => fx.db.prepare("UPDATE revisions SET fields_json = '{}' WHERE id = ?").run(revisionId);
    assert.throws(immutable, /immutable/);
  } finally {
    await fx.close();
  }
});

function columns(depth: number): unknown {
  if (depth <= 1) return { type: 'quote', props: { text: 'Too deep', attribution: '' } };
  return { type: 'columns', props: { columns: [[columns(depth - 1)], [columns(depth - 1)]] } };
}
