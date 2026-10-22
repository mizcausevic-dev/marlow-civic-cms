import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { openDatabase } from '../src/db/db.ts';
import { processDueJob } from '../src/services/cms.ts';
import { api, fixture, pageDocument, signIn } from './helpers.ts';

const root = path.resolve(import.meta.dirname, '..');

test('scenarios 11-15 publishing reliability', async () => {
  const fx = await fixture();
  const workers: ChildProcess[] = [];
  try {
    const admin = await signIn(fx.origin, 'cam.admin@marlow.test', 'local-admin-pass');
    const publisher = await signIn(fx.origin, 'ben.publisher@marlow.test', 'local-publisher-pass');
    const editor = await signIn(fx.origin, 'ada.editor@marlow.test', 'local-editor-pass');
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
      slug: 'harbor-vote',
      fields: { title: 'First public title', summary: 'Original' },
      blocks: [{ type: 'hero', props: { heading: 'First headline', subheading: '', ctaLabel: '', ctaHref: '' } }],
    });
    const entryId = (created.json as { entryId: string }).entryId;
    const firstRevision = (created.json as { revisionId: string }).revisionId;
    assert.equal((await api(fx.origin, publisher, `/admin/api/revisions/${firstRevision}/approve`)).status, 200);
    assert.equal((await api(fx.origin, publisher, `/admin/api/entries/${entryId}/publish`, { revisionId: firstRevision })).status, 200);

    const second = await api(fx.origin, editor, `/admin/api/entries/${entryId}/revisions`, {
      fields: { title: 'Second public title', summary: 'Next' },
      blocks: [{ type: 'hero', props: { heading: 'Second headline', subheading: '', ctaLabel: '', ctaHref: '' } }],
    });
    const secondRevision = (second.json as { id: string }).id;
    assert.equal((await api(fx.origin, publisher, `/admin/api/revisions/${secondRevision}/approve`)).status, 200);

    const runAt = new Date(Date.now() + 60_000).toISOString().slice(0, 16);
    const scheduled = await api(fx.origin, publisher, `/admin/api/entries/${entryId}/schedule`, {
      revisionId: secondRevision,
      local: runAt,
      timezone: 'UTC',
    });
    assert.equal(scheduled.status, 200, JSON.stringify(scheduled.json));
    const jobId = (scheduled.json as { jobId: string }).jobId;
    const databasePath = path.join(fx.dir, 'cms.sqlite');
    const firstWorker = startWorker(databasePath);
    workers.push(firstWorker);
    await delay(250);
    firstWorker.kill('SIGKILL');
    await onceExit(firstWorker);
    const pending = fx.db.prepare('SELECT status FROM scheduled_jobs WHERE id = ?').get(jobId) as { status: string };
    assert.equal(pending.status, 'pending');
    fx.db.prepare(`UPDATE scheduled_jobs SET run_at = ?, not_before = ? WHERE id = ?`).run('2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z', jobId);
    const secondWorker = startWorker(databasePath);
    workers.push(secondWorker);
    await waitFor(() => {
      const row = fx.db.prepare('SELECT status FROM scheduled_jobs WHERE id = ?').get(jobId) as { status: string };
      return row.status === 'succeeded';
    });
    secondWorker.kill('SIGTERM');
    const events = fx.db.prepare('SELECT event_type FROM publications WHERE job_id = ?').all(jobId) as { event_type: string }[];
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event_type, 'schedule');
    const live = await (await fetch(`${fx.origin}/api/public/marlow/entries/harbor-vote`)).json() as { revisionId: string };
    assert.equal(live.revisionId, secondRevision);

    const third = await api(fx.origin, editor, `/admin/api/entries/${entryId}/revisions`, {
      fields: { title: 'Scheduled once', summary: 'Race' },
      blocks: [{ type: 'quote', props: { text: 'Only once', attribution: '' } }],
    });
    const thirdRevision = (third.json as { id: string }).id;
    assert.equal((await api(fx.origin, publisher, `/admin/api/revisions/${thirdRevision}/approve`)).status, 200);
    const past = new Date(Date.now() - 60_000).toISOString().slice(0, 16);
    const race = await api(fx.origin, publisher, `/admin/api/entries/${entryId}/schedule`, {
      revisionId: thirdRevision,
      local: past,
      timezone: 'UTC',
    });
    const raceJob = (race.json as { jobId: string }).jobId;
    const left = startOnce(databasePath);
    const right = startOnce(databasePath);
    workers.push(left, right);
    const [leftCode, rightCode] = await Promise.all([onceExit(left), onceExit(right)]);
    assert.equal(leftCode, 0, left.output);
    assert.equal(rightCode, 0, right.output);
    const raceEvents = fx.db.prepare('SELECT id FROM publications WHERE job_id = ?').all(raceJob);
    assert.equal(raceEvents.length, 1);

    fx.db.prepare(
      `UPDATE scheduled_jobs SET status = 'claimed', lease_until = '2000-01-01T00:00:00.000Z', attempts = 1, claim_token = 'crashed', run_at = '2000-01-01T00:00:00.000Z', not_before = '2000-01-01T00:00:00.000Z' WHERE id = ?`,
    ).run(raceJob);
    const before = (fx.db.prepare('SELECT COUNT(*) AS n FROM publications WHERE job_id = ?').get(raceJob) as { n: number }).n;
    processDueJob(fx.db, { now: new Date(), workerId: 'reclaim', backoffMs: () => 0 });
    const after = (fx.db.prepare('SELECT COUNT(*) AS n FROM publications WHERE job_id = ?').get(raceJob) as { n: number }).n;
    assert.equal(after, before);

    const rolled = await api(fx.origin, publisher, `/admin/api/entries/${entryId}/rollback`, { revisionId: firstRevision });
    assert.equal(rolled.status, 200, JSON.stringify(rolled.json));
    const history = fx.db.prepare(`SELECT event_type FROM publications WHERE entry_id = ? ORDER BY created_at`).all(entryId) as { event_type: string }[];
    assert.ok(history.filter((row) => row.event_type === 'publish').length >= 1);
    assert.ok(history.some((row) => row.event_type === 'rollback'));
    const afterRollback = await (await fetch(`${fx.origin}/api/public/marlow/entries/harbor-vote`)).json() as { revisionId: string; meta: { title: string } };
    assert.equal(afterRollback.revisionId, firstRevision);
    assert.equal(afterRollback.meta.title, 'First public title');
    assert.equal((await api(fx.origin, editor, `/admin/api/entries/${entryId}/rollback`, { revisionId: secondRevision })).status, 403);

    const other = await api(fx.origin, editor, '/admin/api/entries', {
      siteId: fx.siteId,
      contentTypeId: typeId,
      localeId: fx.localeId,
      slug: 'linked',
      fields: { title: 'Linked page' },
      blocks: [{ type: 'reference', props: { entryId } }],
    });
    const linkedId = (other.json as { entryId: string }).entryId;
    const linkedRevision = (other.json as { revisionId: string }).revisionId;
    assert.equal((await api(fx.origin, publisher, `/admin/api/revisions/${linkedRevision}/approve`)).status, 200);
    assert.equal((await api(fx.origin, publisher, `/admin/api/entries/${linkedId}/publish`, { revisionId: linkedRevision })).status, 200);
    assert.equal((await api(fx.origin, publisher, `/admin/api/entries/${entryId}/archive`)).status, 200);
    const archived = await fetch(`${fx.origin}/api/public/marlow/entries/harbor-vote`);
    assert.equal(archived.status, 404);
    const linked = await (await fetch(`${fx.origin}/api/public/marlow/entries/linked`)).json() as { references: Record<string, { status: string; title?: string }> };
    assert.equal(linked.references[`block:${entryId}`]?.status, 'unavailable');
    assert.equal(JSON.stringify(linked).includes('First public title'), false);
    const kept = (fx.db.prepare('SELECT COUNT(*) AS n FROM publications WHERE entry_id = ?').get(entryId) as { n: number }).n;
    assert.ok(kept >= 2);

    const preview = await api(fx.origin, editor, `/admin/api/revisions/${secondRevision}/preview`);
    const token = (preview.json as { token: string }).token;
    const previewResponse = await fetch(`${fx.origin}/preview`, { headers: { authorization: `Preview ${token}` } });
    const publicResponse = await fetch(`${fx.origin}/api/public/marlow/entries/linked`);
    assert.equal(previewResponse.headers.get('cache-control'), 'private, no-store');
    assert.equal(publicResponse.headers.get('cache-control'), 'no-store');
    assert.match(await previewResponse.text(), /Second headline/);
    assert.equal((await publicResponse.text()).includes('Second headline'), false);
  } finally {
    for (const worker of workers) {
      if (worker.exitCode === null) worker.kill('SIGKILL');
    }
    await fx.close();
  }
});

function startWorker(databasePath: string): ChildProcess & { output: string } {
  return track(spawn(process.execPath, ['--import', 'tsx', 'src/worker/main.ts'], workerEnv(databasePath)));
}

function startOnce(databasePath: string): ChildProcess & { output: string } {
  return track(spawn(process.execPath, ['--import', 'tsx', 'src/worker/once.ts'], workerEnv(databasePath)));
}

function workerEnv(databasePath: string) {
  return {
    cwd: root,
    env: { ...process.env, DATABASE_PATH: databasePath, POLL_MS: '100', SCRYPT_N: '4096' },
    stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
  };
}

function track(child: ChildProcess): ChildProcess & { output: string } {
  const tracked = child as ChildProcess & { output: string };
  tracked.output = '';
  child.stdout?.on('data', (chunk) => {
    tracked.output += String(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    tracked.output += String(chunk);
  });
  return tracked;
}

function onceExit(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => child.once('exit', (code) => resolve(code ?? 1)));
}

async function waitFor(check: () => boolean): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 5000) {
    if (check()) return;
    await delay(50);
  }
  throw new Error('timed out waiting for the scheduled job');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void openDatabase;
