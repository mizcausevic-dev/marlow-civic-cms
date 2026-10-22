import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type { DB } from '../db/db.ts';
import { all, get, run, withTx } from '../db/db.ts';
import { canAccessSite, requirePermission, requireSite, type User } from '../domain/authz.ts';
import {
  assertCompatibleChange,
  assertSlug,
  collectReferenceIds,
  parseContentTypeDocument,
  validateBlocks,
  validateFields,
  type Block,
  type ContentTypeDocument,
  type RefLookup,
} from '../domain/content.ts';
import { hashPassword, newToken, sha256, verifyPassword } from '../domain/crypto.ts';
import { diffBlocks, diffFields } from '../domain/diff.ts';
import { AppError, isUniqueConstraint } from '../domain/errors.ts';
import { detectImage, safeDisplayName } from '../domain/media.ts';
import { zonedLocalToUtc } from '../domain/time.ts';
import {
  publicationEventPayload,
  validateWebhookDestination,
  webhookHeaders,
  type DnsLookup,
  type Transport,
} from '../domain/webhooks.ts';
import type { PublicEntry, PublicReference, PublicSummary } from '../contract/public.ts';

const dummyPassword = hashPassword(randomBytes(16).toString('hex'));

export type Session = { token: string; csrf: string; user: User; expiresAt: string };

type SiteRow = { id: string; name: string; slug: string };
type LocaleRow = {
  id: string;
  site_id: string;
  code: string;
  name: string;
  is_default: number;
  fallback_locale_id: string | null;
};
type TypeRow = {
  id: string;
  site_id: string;
  api_key: string;
  name: string;
  schema_json: string;
  schema_version: number;
};
type EntryRow = {
  id: string;
  site_id: string;
  content_type_id: string;
  locale_id: string;
  slug: string;
  status: 'draft' | 'published' | 'archived';
  published_revision_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};
type RevisionRow = {
  id: string;
  entry_id: string;
  revision_number: number;
  schema_version: number;
  fields_json: string;
  blocks_json: string;
  created_by: string;
  created_at: string;
};
type JobRow = {
  id: string;
  entry_id: string;
  revision_id: string;
  run_at: string;
  timezone: string;
  local_input: string;
  status: string;
  claim_token: string | null;
  attempts: number;
  max_attempts: number;
  created_by: string;
};

function must<T>(value: T | undefined, message: string, status = 404, code = 'not_found'): T {
  if (value === undefined) throw new AppError(status, code, message);
  return value;
}

function refsFor(db: DB, siteId: string): RefLookup {
  return {
    entryOnSite: (id) => Boolean(get(db, 'SELECT id FROM entries WHERE id = ? AND site_id = ?', id, siteId)),
    mediaOnSite: (id) => Boolean(get(db, 'SELECT id FROM media WHERE id = ? AND site_id = ?', id, siteId)),
  };
}

function siteById(db: DB, id: string): SiteRow {
  return must(get<SiteRow>(db, 'SELECT id, name, slug FROM sites WHERE id = ?', id), 'Site not found');
}

function localeById(db: DB, id: string): LocaleRow {
  return must(
    get<LocaleRow>(
      db,
      'SELECT id, site_id, code, name, is_default, fallback_locale_id FROM locales WHERE id = ?',
      id,
    ),
    'Locale not found',
  );
}

function typeById(db: DB, id: string): TypeRow {
  return must(
    get<TypeRow>(
      db,
      'SELECT id, site_id, api_key, name, schema_json, schema_version FROM content_types WHERE id = ?',
      id,
    ),
    'Content type not found',
  );
}

function entryById(db: DB, id: string): EntryRow {
  return must(get<EntryRow>(db, 'SELECT * FROM entries WHERE id = ?', id), 'Entry not found');
}

function revisionById(db: DB, id: string): RevisionRow {
  return must(get<RevisionRow>(db, 'SELECT * FROM revisions WHERE id = ?', id), 'Revision not found');
}

function parseDoc(row: TypeRow): ContentTypeDocument {
  return parseContentTypeDocument(JSON.parse(row.schema_json));
}

export function login(db: DB, email: string, password: string, now: Date): Session | null {
  const normalized = email.trim().toLowerCase();
  const since = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
  const failures = get<{ n: number }>(
    db,
    'SELECT COUNT(*) AS n FROM login_attempts WHERE email = ? AND success = 0 AND attempted_at >= ?',
    normalized,
    since,
  );
  if ((failures?.n ?? 0) >= 5) throw new AppError(429, 'rate_limited', 'Too many sign-in attempts. Wait ten minutes.');
  const row = get<{ id: string; email: string; name: string; role: User['role']; password_hash: string }>(
    db,
    'SELECT id, email, name, role, password_hash FROM users WHERE email = ?',
    normalized,
  );
  const ok = verifyPassword(password, row?.password_hash ?? dummyPassword);
  run(db, 'INSERT INTO login_attempts (email, success, attempted_at) VALUES (?, ?, ?)', normalized, ok && row ? 1 : 0, now.toISOString());
  if (!row || !ok) return null;
  const token = newToken();
  const csrf = newToken();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  run(
    db,
    'INSERT INTO sessions (id, user_id, token_hash, csrf_secret, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    randomUUID(),
    row.id,
    sha256(token),
    csrf,
    expiresAt,
    now.toISOString(),
  );
  return { token, csrf, expiresAt, user: { id: row.id, email: row.email, name: row.name, role: row.role } };
}

export function logout(db: DB, token: string): void {
  run(db, 'DELETE FROM sessions WHERE token_hash = ?', sha256(token));
}

export function readSession(db: DB, token: string, now: Date): { user: User; csrf: string } | null {
  const row = get<{ id: string; email: string; name: string; role: User['role']; csrf_secret: string }>(
    db,
    `SELECT u.id, u.email, u.name, u.role, s.csrf_secret
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
    sha256(token),
    now.toISOString(),
  );
  if (!row) return null;
  return { csrf: row.csrf_secret, user: { id: row.id, email: row.email, name: row.name, role: row.role } };
}

export function createUser(db: DB, input: { email: string; name: string; password: string; role: User['role'] }): User {
  const id = randomUUID();
  const email = input.email.trim().toLowerCase();
  run(
    db,
    'INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    id,
    email,
    input.name,
    hashPassword(input.password),
    input.role,
    new Date().toISOString(),
  );
  return { id, email, name: input.name, role: input.role };
}

export function createSite(db: DB, actor: User, input: { name: string; slug: string }): SiteRow {
  requirePermission(actor, 'site.write');
  const slug = assertSlug(input.slug, 'Site slug');
  const id = randomUUID();
  const now = new Date().toISOString();
  try {
    withTx(db, () => {
      run(db, 'INSERT INTO sites (id, name, slug, created_at) VALUES (?, ?, ?, ?)', id, input.name.trim(), slug, now);
      run(
        db,
        'INSERT INTO locales (id, site_id, code, name, is_default, fallback_locale_id) VALUES (?, ?, ?, ?, ?, ?)',
        randomUUID(),
        id,
        'en',
        'English',
        1,
        null,
      );
    });
  } catch (error) {
    if (isUniqueConstraint(error)) throw new AppError(409, 'conflict', 'Site slug already exists');
    throw error;
  }
  return siteById(db, id);
}

export function addSiteMember(db: DB, actor: User, siteId: string, userId: string): void {
  requirePermission(actor, 'member.write');
  siteById(db, siteId);
  must(get(db, 'SELECT id FROM users WHERE id = ?', userId), 'User not found');
  run(db, 'INSERT OR IGNORE INTO user_sites (user_id, site_id) VALUES (?, ?)', userId, siteId);
}

export function createLocale(
  db: DB,
  actor: User,
  input: { siteId: string; code: string; name: string; fallbackLocaleId: string | null; isDefault: boolean },
): LocaleRow {
  requirePermission(actor, 'site.write');
  requireSite(db, actor, input.siteId);
  if (!/^[a-z]{2}(?:-[a-z0-9]{2,8})?$/.test(input.code)) {
    throw new AppError(400, 'invalid_locale', 'Locale code must look like en or es');
  }
  if (input.fallbackLocaleId) {
    const fallback = localeById(db, input.fallbackLocaleId);
    if (fallback.site_id !== input.siteId) throw new AppError(400, 'invalid_locale', 'Fallback locale is on another site');
    assertNoLocaleCycle(db, input.siteId, null, input.fallbackLocaleId);
  }
  const id = randomUUID();
  try {
    withTx(db, () => {
      if (input.isDefault) run(db, 'UPDATE locales SET is_default = 0 WHERE site_id = ?', input.siteId);
      run(
        db,
        'INSERT INTO locales (id, site_id, code, name, is_default, fallback_locale_id) VALUES (?, ?, ?, ?, ?, ?)',
        id,
        input.siteId,
        input.code,
        input.name.trim(),
        input.isDefault ? 1 : 0,
        input.fallbackLocaleId,
      );
    });
  } catch (error) {
    if (isUniqueConstraint(error)) throw new AppError(409, 'conflict', 'Locale already exists');
    throw error;
  }
  return localeById(db, id);
}

function assertNoLocaleCycle(db: DB, siteId: string, selfId: string | null, fallbackId: string): void {
  const seen = new Set<string>();
  if (selfId) seen.add(selfId);
  let cursor: string | null = fallbackId;
  while (cursor) {
    if (seen.has(cursor)) throw new AppError(400, 'invalid_locale', 'Locale fallback would cycle');
    seen.add(cursor);
    if (seen.size > 5) throw new AppError(400, 'invalid_locale', 'Locale fallback chain is too long');
    const row = localeById(db, cursor);
    if (row.site_id !== siteId) throw new AppError(400, 'invalid_locale', 'Fallback locale is on another site');
    cursor = row.fallback_locale_id;
  }
}

export function fallbackChain(db: DB, start: LocaleRow): LocaleRow[] {
  const chain: LocaleRow[] = [];
  const seen = new Set<string>();
  let cursor: LocaleRow | undefined = start;
  while (cursor && !seen.has(cursor.id) && chain.length < 5) {
    seen.add(cursor.id);
    chain.push(cursor);
    cursor = cursor.fallback_locale_id ? localeById(db, cursor.fallback_locale_id) : undefined;
  }
  return chain;
}

export function createContentType(
  db: DB,
  actor: User,
  input: { siteId: string; apiKey: string; name: string; document: unknown },
): TypeRow {
  requirePermission(actor, 'type.write');
  requireSite(db, actor, input.siteId);
  const document = parseContentTypeDocument(input.document);
  const apiKey = assertSlug(input.apiKey, 'API key');
  const id = randomUUID();
  const now = new Date().toISOString();
  try {
    run(
      db,
      `INSERT INTO content_types (id, site_id, api_key, name, schema_json, schema_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      id,
      input.siteId,
      apiKey,
      input.name.trim(),
      JSON.stringify(document),
      now,
      now,
    );
  } catch (error) {
    if (isUniqueConstraint(error)) throw new AppError(409, 'conflict', 'Content type key already exists on this site');
    throw error;
  }
  return typeById(db, id);
}

export function updateContentType(db: DB, actor: User, typeId: string, documentInput: unknown): TypeRow {
  requirePermission(actor, 'type.write');
  const current = typeById(db, typeId);
  requireSite(db, actor, current.site_id);
  const next = parseContentTypeDocument(documentInput);
  const existing = get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM entries WHERE content_type_id = ?', typeId);
  if ((existing?.n ?? 0) > 0) assertCompatibleChange(parseDoc(current), next);
  const now = new Date().toISOString();
  run(
    db,
    'UPDATE content_types SET schema_json = ?, schema_version = schema_version + 1, updated_at = ? WHERE id = ?',
    JSON.stringify(next),
    now,
    typeId,
  );
  return typeById(db, typeId);
}

export function createEntry(
  db: DB,
  actor: User,
  input: { siteId: string; contentTypeId: string; localeId: string; slug: string; fields: unknown; blocks: unknown },
): { entryId: string; revisionId: string } {
  requirePermission(actor, 'entry.write');
  requireSite(db, actor, input.siteId);
  const contentType = typeById(db, input.contentTypeId);
  if (contentType.site_id !== input.siteId) throw new AppError(400, 'invalid_entry', 'Content type is on another site');
  const locale = localeById(db, input.localeId);
  if (locale.site_id !== input.siteId) throw new AppError(400, 'invalid_entry', 'Locale is on another site');
  const slug = assertSlug(input.slug);
  const fields = validateFields(parseDoc(contentType), input.fields, refsFor(db, input.siteId));
  const blocks = validateBlocks(input.blocks, refsFor(db, input.siteId), parseDoc(contentType).blocks);
  const entryId = randomUUID();
  const revisionId = randomUUID();
  const now = new Date().toISOString();
  try {
    withTx(db, () => {
      run(
        db,
        `INSERT INTO entries (id, site_id, content_type_id, locale_id, slug, status, published_revision_id, created_by, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, 'draft', NULL, ?, ?, ?, NULL)`,
        entryId,
        input.siteId,
        contentType.id,
        locale.id,
        slug,
        actor.id,
        now,
        now,
      );
      insertRevision(db, {
        id: revisionId,
        entryId,
        number: 1,
        schemaVersion: contentType.schema_version,
        fields,
        blocks,
        actorId: actor.id,
        now,
      });
    });
  } catch (error) {
    if (isUniqueConstraint(error)) throw new AppError(409, 'conflict', 'Slug already exists for this site and locale');
    throw error;
  }
  return { entryId, revisionId };
}

function insertRevision(
  db: DB,
  input: {
    id: string;
    entryId: string;
    number: number;
    schemaVersion: number;
    fields: Record<string, unknown>;
    blocks: Block[];
    actorId: string;
    now: string;
  },
): void {
  run(
    db,
    `INSERT INTO revisions (id, entry_id, revision_number, schema_version, fields_json, blocks_json, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    input.id,
    input.entryId,
    input.number,
    input.schemaVersion,
    JSON.stringify(input.fields),
    JSON.stringify(input.blocks),
    input.actorId,
    input.now,
  );
}

export function saveRevision(
  db: DB,
  actor: User,
  entryId: string,
  input: { fields: unknown; blocks: unknown },
): RevisionRow {
  requirePermission(actor, 'entry.write');
  const entry = entryById(db, entryId);
  requireSite(db, actor, entry.site_id);
  if (entry.status === 'archived') throw new AppError(409, 'archived', 'Unarchive by rolling back before editing');
  const contentType = typeById(db, entry.content_type_id);
  const fields = validateFields(parseDoc(contentType), input.fields, refsFor(db, entry.site_id));
  const blocks = validateBlocks(input.blocks, refsFor(db, entry.site_id), parseDoc(contentType).blocks);
  const latest = must(
    get<{ n: number }>(db, 'SELECT MAX(revision_number) AS n FROM revisions WHERE entry_id = ?', entryId),
    'Entry has no revision',
    500,
    'internal_error',
  );
  const revisionId = randomUUID();
  const now = new Date().toISOString();
  withTx(db, () => {
    insertRevision(db, {
      id: revisionId,
      entryId,
      number: Number(latest.n) + 1,
      schemaVersion: contentType.schema_version,
      fields,
      blocks,
      actorId: actor.id,
      now,
    });
    run(db, 'UPDATE entries SET updated_at = ? WHERE id = ?', now, entryId);
  });
  return revisionById(db, revisionId);
}

export function approveRevision(db: DB, actor: User, revisionId: string, now: Date): void {
  requirePermission(actor, 'approve');
  const revision = revisionById(db, revisionId);
  const entry = entryById(db, revision.entry_id);
  requireSite(db, actor, entry.site_id);
  try {
    withTx(db, () => {
      run(
        db,
        'INSERT INTO approvals (id, revision_id, approved_by, approved_at) VALUES (?, ?, ?, ?)',
        randomUUID(),
        revisionId,
        actor.id,
        now.toISOString(),
      );
      run(
        db,
        'INSERT INTO audit_events (id, entry_id, actor_id, event_type, revision_id, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        randomUUID(),
        entry.id,
        actor.id,
        'approve',
        revisionId,
        '{}',
        now.toISOString(),
      );
    });
  } catch (error) {
    if (isUniqueConstraint(error)) throw new AppError(409, 'already_approved', 'This revision is already approved');
    throw error;
  }
}

type PublicationKind = 'publish' | 'schedule' | 'rollback';

function writePublication(
  db: DB,
  actor: User,
  entry: EntryRow,
  revision: RevisionRow,
  eventType: PublicationKind,
  jobId: string | null,
  nowIso: string,
  detail: Record<string, unknown>,
): { publicationId: string; eventId: string } {
  if (revision.entry_id !== entry.id) throw new AppError(400, 'invalid_revision', 'Revision does not belong to this entry');
  const approval = get(db, 'SELECT id FROM approvals WHERE revision_id = ?', revision.id);
  if (!approval) throw new AppError(409, 'not_approved', 'Publish the approved revision, not an unapproved draft');
  if (eventType === 'rollback') {
    const prior = get(
      db,
      'SELECT id FROM publications WHERE entry_id = ? AND revision_id = ?',
      entry.id,
      revision.id,
    );
    if (!prior) throw new AppError(409, 'not_published_before', 'Rollback requires a revision that was published before');
  }
  const publicationId = randomUUID();
  const eventId = randomUUID();
  const site = siteById(db, entry.site_id);
  const locale = localeById(db, entry.locale_id);
  const payload = publicationEventPayload({
    eventId,
    createdAt: nowIso,
    publicationId,
    entryId: entry.id,
    revisionId: revision.id,
    site: site.slug,
    locale: locale.code,
    slug: entry.slug,
    eventType,
  });
  run(
    db,
    `INSERT INTO publications (id, entry_id, revision_id, actor_id, event_type, job_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    publicationId,
    entry.id,
    revision.id,
    actor.id,
    eventType,
    jobId,
    nowIso,
  );
  run(
    db,
    `UPDATE entries SET published_revision_id = ?, status = 'published', archived_at = NULL, updated_at = ? WHERE id = ?`,
    revision.id,
    nowIso,
    entry.id,
  );
  run(
    db,
    'INSERT INTO audit_events (id, entry_id, actor_id, event_type, revision_id, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    randomUUID(),
    entry.id,
    actor.id,
    eventType,
    revision.id,
    JSON.stringify(detail),
    nowIso,
  );
  run(
    db,
    'INSERT INTO webhook_events (id, site_id, publication_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    eventId,
    entry.site_id,
    publicationId,
    'entry.published',
    payload,
    nowIso,
  );
  const endpoints = all<{ id: string }>(
    db,
    'SELECT id FROM webhook_endpoints WHERE site_id = ? AND enabled = 1',
    entry.site_id,
  );
  for (const endpoint of endpoints) {
    run(
      db,
      `INSERT INTO webhook_outbox (id, event_id, endpoint_id, status, attempts, next_attempt_at, last_error, last_response_status)
       VALUES (?, ?, ?, 'pending', 0, ?, NULL, NULL)`,
      randomUUID(),
      eventId,
      endpoint.id,
      nowIso,
    );
  }
  return { publicationId, eventId };
}

export function publishEntryRevision(db: DB, actor: User, entryId: string, revisionId: string, now: Date): { publicationId: string } {
  requirePermission(actor, 'publish');
  const entry = entryById(db, entryId);
  requireSite(db, actor, entry.site_id);
  const revision = revisionById(db, revisionId);
  const result = withTx(db, () =>
    writePublication(db, actor, entry, revision, 'publish', null, now.toISOString(), { source: 'manual' }),
  );
  return { publicationId: result.publicationId };
}

export function archiveEntry(db: DB, actor: User, entryId: string, now: Date): void {
  requirePermission(actor, 'archive');
  const entry = entryById(db, entryId);
  requireSite(db, actor, entry.site_id);
  if (entry.status === 'archived') throw new AppError(409, 'archived', 'Entry is already archived');
  const nowIso = now.toISOString();
  withTx(db, () => {
    run(db, `UPDATE entries SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?`, nowIso, nowIso, entry.id);
    run(
      db,
      'INSERT INTO audit_events (id, entry_id, actor_id, event_type, revision_id, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      randomUUID(),
      entry.id,
      actor.id,
      'archive',
      entry.published_revision_id,
      JSON.stringify({ previousStatus: entry.status }),
      nowIso,
    );
  });
}

export function rollbackEntry(db: DB, actor: User, entryId: string, revisionId: string, now: Date): { publicationId: string } {
  requirePermission(actor, 'rollback');
  const entry = entryById(db, entryId);
  requireSite(db, actor, entry.site_id);
  const revision = revisionById(db, revisionId);
  const result = withTx(db, () =>
    writePublication(db, actor, entry, revision, 'rollback', null, now.toISOString(), {
      previousStatus: entry.status,
      previousArchivedAt: entry.archived_at,
      previousPublishedRevisionId: entry.published_revision_id,
    }),
  );
  return { publicationId: result.publicationId };
}

export function scheduleRevision(
  db: DB,
  actor: User,
  entryId: string,
  revisionId: string,
  localInput: string,
  timeZone: string,
  now: Date,
): { jobId: string; runAt: string } {
  requirePermission(actor, 'schedule');
  const entry = entryById(db, entryId);
  requireSite(db, actor, entry.site_id);
  if (entry.status === 'archived') throw new AppError(409, 'archived', 'Archived entries cannot be scheduled');
  const revision = revisionById(db, revisionId);
  if (revision.entry_id !== entry.id) throw new AppError(400, 'invalid_revision', 'Revision does not belong to this entry');
  if (!get(db, 'SELECT id FROM approvals WHERE revision_id = ?', revision.id)) {
    throw new AppError(409, 'not_approved', 'Schedule an approved revision');
  }
  const runAt = zonedLocalToUtc(localInput, timeZone);
  const jobId = randomUUID();
  const nowIso = now.toISOString();
  run(
    db,
    `INSERT INTO scheduled_jobs (
      id, entry_id, revision_id, run_at, timezone, local_input, status, attempts, max_attempts, not_before, created_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, 5, ?, ?, ?)`,
    jobId,
    entry.id,
    revision.id,
    runAt.toISOString(),
    timeZone,
    localInput,
    nowIso,
    actor.id,
    nowIso,
  );
  return { jobId, runAt: runAt.toISOString() };
}

class LeaseLost extends Error {}

export function processDueJob(
  db: DB,
  options: { now: Date; workerId: string; leaseMs?: number; backoffMs?: (attempt: number) => number },
): { jobId: string; outcome: string } | null {
  const nowIso = options.now.toISOString();
  const leaseUntil = new Date(options.now.getTime() + (options.leaseMs ?? 30_000)).toISOString();
  const claimToken = randomUUID();
  const job = withTx(db, () => {
    const changes = run(
      db,
      `UPDATE scheduled_jobs
       SET status = 'claimed', claimed_by = ?, claimed_at = ?, lease_until = ?, claim_token = ?, attempts = attempts + 1
       WHERE id = (
         SELECT id FROM scheduled_jobs
         WHERE run_at <= ? AND not_before <= ? AND attempts < max_attempts
           AND (status = 'pending' OR (status = 'claimed' AND lease_until <= ?))
         ORDER BY run_at ASC, id ASC LIMIT 1
       )
       AND run_at <= ? AND not_before <= ? AND attempts < max_attempts
       AND (status = 'pending' OR (status = 'claimed' AND lease_until <= ?))`,
      options.workerId,
      nowIso,
      leaseUntil,
      claimToken,
      nowIso,
      nowIso,
      nowIso,
      nowIso,
      nowIso,
      nowIso,
    );
    if (changes !== 1) return null;
    const claimed = must(
      get<JobRow>(db, 'SELECT * FROM scheduled_jobs WHERE claim_token = ?', claimToken),
      'Claimed job disappeared',
      500,
      'internal_error',
    );
    run(
      db,
      `UPDATE job_attempts SET outcome = 'expired_lease', finished_at = ? WHERE job_id = ? AND outcome IS NULL`,
      nowIso,
      claimed.id,
    );
    run(
      db,
      `INSERT INTO job_attempts (id, job_id, attempt, worker_id, started_at, finished_at, outcome, error)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)`,
      randomUUID(),
      claimed.id,
      claimed.attempts,
      options.workerId,
      nowIso,
    );
    return claimed;
  });
  if (!job) return null;
  try {
    return finishJob(db, job, options.now);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown failure';
    const terminal = error instanceof AppError;
    const attempt = job.attempts;
    const giveUp = terminal || attempt >= job.max_attempts;
    const backoff = options.backoffMs?.(attempt) ?? Math.min(60_000, 1000 * 2 ** attempt);
    const next = new Date(options.now.getTime() + backoff).toISOString();
    withTx(db, () => {
      if (giveUp) {
        run(
          db,
          `UPDATE scheduled_jobs SET status = 'failed', last_error = ?, finished_at = ? WHERE id = ? AND claim_token = ?`,
          message,
          nowIso,
          job.id,
          job.claim_token,
        );
      } else {
        run(
          db,
          `UPDATE scheduled_jobs
           SET status = 'pending', last_error = ?, not_before = ?, claim_token = NULL, claimed_by = NULL, lease_until = NULL
           WHERE id = ? AND claim_token = ?`,
          message,
          next,
          job.id,
          job.claim_token,
        );
      }
      run(
        db,
        `UPDATE job_attempts SET finished_at = ?, outcome = ?, error = ? WHERE job_id = ? AND attempt = ? AND outcome IS NULL`,
        nowIso,
        giveUp ? 'failed' : 'retry',
        message,
        job.id,
        attempt,
      );
    });
    return { jobId: job.id, outcome: giveUp ? 'failed' : 'retry' };
  }
}

function finishJob(db: DB, job: JobRow, now: Date): { jobId: string; outcome: string } {
  const entry = entryById(db, job.entry_id);
  const scheduler = get<User>(db, 'SELECT id, email, name, role FROM users WHERE id = ?', job.created_by);
  if (!scheduler || (scheduler.role !== 'publisher' && scheduler.role !== 'administrator') || !canAccessSite(db, scheduler, entry.site_id)) {
    throw new AppError(403, 'forbidden', 'Scheduler no longer has permission to publish this site');
  }
  if (entry.status === 'archived') throw new AppError(409, 'archived', 'Entry is archived');
  const revision = revisionById(db, job.revision_id);
  if (!get(db, 'SELECT id FROM approvals WHERE revision_id = ?', revision.id)) {
    throw new AppError(409, 'not_approved', 'Scheduled revision is no longer approved');
  }
  const nowIso = now.toISOString();
  try {
    withTx(db, () => {
      const changes = run(
        db,
        `UPDATE scheduled_jobs SET status = 'succeeded', finished_at = ?, last_error = NULL WHERE id = ? AND claim_token = ? AND status = 'claimed'`,
        nowIso,
        job.id,
        job.claim_token,
      );
      if (changes !== 1) throw new LeaseLost();
      writePublication(db, scheduler, entry, revision, 'schedule', job.id, nowIso, { jobId: job.id });
      run(
        db,
        `UPDATE job_attempts SET finished_at = ?, outcome = 'succeeded' WHERE job_id = ? AND attempt = ? AND outcome IS NULL`,
        nowIso,
        job.id,
        job.attempts,
      );
    });
  } catch (error) {
    if (error instanceof LeaseLost) return { jobId: job.id, outcome: 'skipped' };
    if (isUniqueConstraint(error)) {
      run(
        db,
        `UPDATE scheduled_jobs SET status = 'succeeded', finished_at = ?, last_error = NULL WHERE id = ? AND claim_token = ?`,
        nowIso,
        job.id,
        job.claim_token,
      );
      return { jobId: job.id, outcome: 'succeeded' };
    }
    throw error;
  }
  return { jobId: job.id, outcome: 'succeeded' };
}

export function mintPreview(db: DB, actor: User, revisionId: string, now: Date, ttlMs = 15 * 60 * 1000): { token: string; expiresAt: string } {
  requirePermission(actor, 'preview');
  const revision = revisionById(db, revisionId);
  const entry = entryById(db, revision.entry_id);
  requireSite(db, actor, entry.site_id);
  const token = newToken();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  run(
    db,
    `INSERT INTO preview_tokens (id, token_hash, revision_id, site_id, locale_id, expires_at, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    randomUUID(),
    sha256(token),
    revision.id,
    entry.site_id,
    entry.locale_id,
    expiresAt,
    actor.id,
    now.toISOString(),
  );
  return { token, expiresAt };
}

export function readPreview(db: DB, token: string, now: Date, expectedRevisionId?: string): PublicEntry {
  const row = get<{ revision_id: string; site_id: string; locale_id: string; expires_at: string }>(
    db,
    'SELECT revision_id, site_id, locale_id, expires_at FROM preview_tokens WHERE token_hash = ?',
    sha256(token),
  );
  if (!row) throw new AppError(401, 'invalid_preview', 'Preview token is invalid');
  if (row.expires_at <= now.toISOString()) throw new AppError(401, 'expired_preview', 'Preview token is expired');
  if (expectedRevisionId && expectedRevisionId !== row.revision_id) {
    throw new AppError(403, 'preview_scope', 'Preview token is for a different revision');
  }
  const revision = revisionById(db, row.revision_id);
  const entry = entryById(db, revision.entry_id);
  if (entry.site_id !== row.site_id || entry.locale_id !== row.locale_id) {
    throw new AppError(403, 'preview_scope', 'Preview token does not match this entry');
  }
  return serializeEntry(db, entry, revision, entry.locale_id, false, revision.created_at);
}

export function getPublicEntry(db: DB, siteSlug: string, slug: string, localeCode?: string): PublicEntry | null {
  const site = get<SiteRow>(db, 'SELECT id, name, slug FROM sites WHERE slug = ?', siteSlug);
  if (!site) return null;
  const locales = all<LocaleRow>(db, 'SELECT * FROM locales WHERE site_id = ?', site.id);
  const requested = localeCode ? locales.find((locale) => locale.code === localeCode) : locales.find((locale) => locale.is_default === 1);
  if (!requested) return null;
  for (const locale of fallbackChain(db, requested)) {
    const entry = get<EntryRow>(
      db,
      'SELECT * FROM entries WHERE site_id = ? AND locale_id = ? AND slug = ?',
      site.id,
      locale.id,
      slug,
    );
    if (!entry || entry.status !== 'published' || !entry.published_revision_id || entry.archived_at) continue;
    const revision = revisionById(db, entry.published_revision_id);
    const publication = get<{ created_at: string }>(
      db,
      'SELECT created_at FROM publications WHERE entry_id = ? AND revision_id = ? ORDER BY created_at DESC LIMIT 1',
      entry.id,
      revision.id,
    );
    return serializeEntry(db, entry, revision, requested.id, locale.id !== requested.id, publication?.created_at ?? revision.created_at);
  }
  return null;
}

export function listPublicEntries(db: DB, siteSlug: string, localeCode?: string, typeKey?: string): PublicSummary[] {
  const site = get<SiteRow>(db, 'SELECT id, name, slug FROM sites WHERE slug = ?', siteSlug);
  if (!site) return [];
  const locales = all<LocaleRow>(db, 'SELECT * FROM locales WHERE site_id = ?', site.id);
  const requested = localeCode ? locales.find((locale) => locale.code === localeCode) : locales.find((locale) => locale.is_default === 1);
  if (!requested) return [];
  const rows = all<{
    id: string;
    slug: string;
    api_key: string;
    fields_json: string;
    published_at: string;
  }>(
    db,
    `SELECT e.id, e.slug, ct.api_key, r.fields_json, p.created_at AS published_at
     FROM entries e
     JOIN content_types ct ON ct.id = e.content_type_id
     JOIN revisions r ON r.id = e.published_revision_id
     JOIN publications p ON p.id = (
       SELECT id FROM publications WHERE entry_id = e.id AND revision_id = r.id ORDER BY created_at DESC LIMIT 1
     )
     WHERE e.site_id = ? AND e.locale_id = ? AND e.status = 'published' AND e.archived_at IS NULL
       AND (? IS NULL OR ct.api_key = ?)
     ORDER BY p.created_at DESC`,
    site.id,
    requested.id,
    typeKey ?? null,
    typeKey ?? null,
  );
  return rows.map((row) => {
    const fields = JSON.parse(row.fields_json) as Record<string, unknown>;
    return {
      id: row.id,
      slug: row.slug,
      contentType: row.api_key,
      locale: requested.code,
      title: typeof fields.title === 'string' ? fields.title : row.slug,
      publishedAt: row.published_at,
    };
  });
}

function serializeEntry(
  db: DB,
  entry: EntryRow,
  revision: RevisionRow,
  requestedLocaleId: string,
  fallback: boolean,
  publishedAt: string,
): PublicEntry {
  const site = siteById(db, entry.site_id);
  const served = localeById(db, entry.locale_id);
  const requested = localeById(db, requestedLocaleId);
  const contentType = typeById(db, entry.content_type_id);
  const doc = parseDoc(contentType);
  const fields = JSON.parse(revision.fields_json) as Record<string, unknown>;
  const blocks = JSON.parse(revision.blocks_json) as Block[];
  const references: Record<string, PublicReference> = {};
  for (const field of doc.fields) {
    const value = fields[field.key];
    if (field.type === 'reference' && typeof value === 'string') {
      references[field.key] = resolveReference(db, entry.site_id, value);
    }
  }
  for (const entryId of collectReferenceIds(fields, blocks).entries) {
    references[`block:${entryId}`] = resolveReference(db, entry.site_id, entryId);
  }
  const title =
    (typeof fields.seoTitle === 'string' && fields.seoTitle) ||
    (typeof fields.title === 'string' && fields.title) ||
    entry.slug;
  const description =
    (typeof fields.seoDescription === 'string' && fields.seoDescription) ||
    (typeof fields.summary === 'string' && fields.summary) ||
    '';
  return {
    id: entry.id,
    site: site.slug,
    localeRequested: requested.code,
    localeServed: served.code,
    fallback,
    slug: entry.slug,
    contentType: contentType.api_key,
    revisionId: revision.id,
    publishedAt,
    fields,
    blocks,
    meta: { title, description },
    references,
  };
}

function resolveReference(db: DB, siteId: string, entryId: string): PublicReference {
  const entry = get<EntryRow>(db, 'SELECT * FROM entries WHERE id = ?', entryId);
  if (!entry || entry.site_id !== siteId || entry.status !== 'published' || !entry.published_revision_id || entry.archived_at) {
    return { status: 'unavailable' };
  }
  const revision = revisionById(db, entry.published_revision_id);
  const fields = JSON.parse(revision.fields_json) as Record<string, unknown>;
  const locale = localeById(db, entry.locale_id);
  const contentType = typeById(db, entry.content_type_id);
  return {
    status: 'published',
    id: entry.id,
    slug: entry.slug,
    locale: locale.code,
    contentType: contentType.api_key,
    title: typeof fields.title === 'string' ? fields.title : entry.slug,
  };
}

export function compareRevisions(db: DB, actor: User, entryId: string, leftId: string, rightId: string) {
  requirePermission(actor, 'entry.read');
  const entry = entryById(db, entryId);
  requireSite(db, actor, entry.site_id);
  const left = revisionById(db, leftId);
  const right = revisionById(db, rightId);
  if (left.entry_id !== entry.id || right.entry_id !== entry.id) {
    throw new AppError(400, 'invalid_revision', 'Both revisions must belong to the entry');
  }
  return {
    fields: diffFields(JSON.parse(left.fields_json), JSON.parse(right.fields_json)),
    blocks: diffBlocks(JSON.parse(left.blocks_json), JSON.parse(right.blocks_json)),
  };
}

const redirectPath = /^\/[a-z0-9][a-z0-9/._-]{0,160}$/;

function assertPath(value: string): string {
  if (!redirectPath.test(value) || value.includes('//') || value.includes('..') || value.includes('\\') || value.includes(':')) {
    throw new AppError(400, 'invalid_redirect', 'Use a site path such as /ferry');
  }
  return value;
}

export function createRedirect(
  db: DB,
  actor: User,
  input: { siteId: string; localeId: string; fromPath: string; toPath: string; statusCode: number },
): void {
  requirePermission(actor, 'redirect.write');
  requireSite(db, actor, input.siteId);
  const locale = localeById(db, input.localeId);
  if (locale.site_id !== input.siteId) throw new AppError(400, 'invalid_redirect', 'Locale is on another site');
  const fromPath = assertPath(input.fromPath);
  const toPath = assertPath(input.toPath);
  if (fromPath === toPath) throw new AppError(400, 'invalid_redirect', 'Redirect cannot point at itself');
  if (input.statusCode !== 301 && input.statusCode !== 302) {
    throw new AppError(400, 'invalid_redirect', 'Status must be 301 or 302');
  }
  if (redirectLoops(db, input.siteId, locale.id, fromPath, toPath)) {
    throw new AppError(400, 'invalid_redirect', 'Redirect would loop');
  }
  try {
    run(
      db,
      `INSERT INTO redirects (id, site_id, locale_id, from_path, to_path, status_code, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      randomUUID(),
      input.siteId,
      locale.id,
      fromPath,
      toPath,
      input.statusCode,
      new Date().toISOString(),
    );
  } catch (error) {
    if (isUniqueConstraint(error)) throw new AppError(409, 'conflict', 'A redirect already exists for that path');
    throw error;
  }
}

function redirectLoops(db: DB, siteId: string, localeId: string, fromPath: string, toPath: string): boolean {
  const seen = new Set<string>([fromPath]);
  let cursor = toPath;
  for (let hop = 0; hop < 5; hop += 1) {
    if (seen.has(cursor)) return true;
    seen.add(cursor);
    const next = get<{ to_path: string }>(
      db,
      'SELECT to_path FROM redirects WHERE site_id = ? AND locale_id = ? AND from_path = ?',
      siteId,
      localeId,
      cursor,
    );
    if (!next) return false;
    cursor = next.to_path;
  }
  return true;
}

export function resolveRedirect(
  db: DB,
  siteSlug: string,
  localeCode: string | undefined,
  fromPath: string,
): { to: string; statusCode: number } | { loop: true } | null {
  const site = get<SiteRow>(db, 'SELECT id, name, slug FROM sites WHERE slug = ?', siteSlug);
  if (!site) return null;
  const locales = all<LocaleRow>(db, 'SELECT * FROM locales WHERE site_id = ?', site.id);
  const locale = localeCode ? locales.find((item) => item.code === localeCode) : locales.find((item) => item.is_default === 1);
  if (!locale) return null;
  const seen = new Set<string>();
  let cursor = fromPath;
  let statusCode = 301;
  for (let hop = 0; hop < 5; hop += 1) {
    if (seen.has(cursor)) return { loop: true };
    seen.add(cursor);
    const row = get<{ to_path: string; status_code: number }>(
      db,
      'SELECT to_path, status_code FROM redirects WHERE site_id = ? AND locale_id = ? AND from_path = ?',
      site.id,
      locale.id,
      cursor,
    );
    if (!row) return hop === 0 ? null : { to: cursor, statusCode };
    statusCode = row.status_code;
    cursor = row.to_path;
  }
  return { loop: true };
}

export function saveMedia(
  db: DB,
  actor: User,
  mediaRoot: string,
  input: { siteId: string; bytes: Buffer; originalName: string; alt: string },
): { id: string } {
  requirePermission(actor, 'media.write');
  requireSite(db, actor, input.siteId);
  const detected = detectImage(input.bytes);
  if (!detected) throw new AppError(400, 'invalid_media', 'Upload a PNG, JPEG, GIF, or WebP file of 2 MB or less');
  const alt = input.alt.trim();
  if (!alt || alt.length > 300) throw new AppError(400, 'invalid_media', 'Alt text is required and must be 300 characters or less');
  const id = randomUUID();
  const storageKey = `${id}.${detected.ext}`;
  const destination = resolveMediaPath(mediaRoot, storageKey);
  fs.mkdirSync(mediaRoot, { recursive: true });
  fs.writeFileSync(destination, input.bytes);
  try {
    run(
      db,
      `INSERT INTO media (id, site_id, storage_key, original_name, mime, size_bytes, alt, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.siteId,
      storageKey,
      safeDisplayName(input.originalName),
      detected.mime,
      input.bytes.length,
      alt,
      actor.id,
      new Date().toISOString(),
    );
  } catch (error) {
    fs.rmSync(destination, { force: true });
    throw error;
  }
  return { id };
}

export function resolveMediaPath(mediaRoot: string, storageKey: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$/.test(storageKey)) {
    throw new AppError(400, 'invalid_media', 'Invalid media key');
  }
  const root = path.resolve(mediaRoot);
  const full = path.resolve(root, storageKey);
  if (!full.startsWith(root + path.sep)) throw new AppError(400, 'invalid_media', 'Invalid media key');
  return full;
}

export function publicMedia(db: DB, mediaId: string, mediaRoot: string): { file: string; mime: string; alt: string } | null {
  if (!/^[0-9a-f-]{36}$/i.test(mediaId)) return null;
  const media = get<{ id: string; site_id: string; storage_key: string; mime: string; alt: string }>(
    db,
    'SELECT id, site_id, storage_key, mime, alt FROM media WHERE id = ?',
    mediaId,
  );
  if (!media) return null;
  const visible = get(
    db,
    `SELECT r.id FROM revisions r
     JOIN entries e ON e.published_revision_id = r.id
     WHERE e.site_id = ? AND e.status = 'published' AND e.archived_at IS NULL
       AND (r.fields_json LIKE ? OR r.blocks_json LIKE ?)
     LIMIT 1`,
    media.site_id,
    `%${media.id}%`,
    `%${media.id}%`,
  );
  if (!visible) return null;
  const file = resolveMediaPath(mediaRoot, media.storage_key);
  if (!fs.existsSync(file)) return null;
  return { file, mime: media.mime, alt: media.alt };
}

export function previewMedia(
  db: DB,
  token: string,
  mediaId: string,
  mediaRoot: string,
  now: Date,
): { file: string; mime: string } | null {
  const preview = readPreview(db, token, now);
  const blob = JSON.stringify({ fields: preview.fields, blocks: preview.blocks });
  if (!blob.includes(mediaId)) return null;
  const media = get<{ storage_key: string; mime: string }>(db, 'SELECT storage_key, mime FROM media WHERE id = ?', mediaId);
  if (!media) return null;
  const file = resolveMediaPath(mediaRoot, media.storage_key);
  if (!fs.existsSync(file)) return null;
  return { file, mime: media.mime };
}

export async function createWebhookEndpoint(
  db: DB,
  actor: User,
  input: { siteId: string; url: string },
  lookup?: DnsLookup,
): Promise<{ id: string; secret: string }> {
  requirePermission(actor, 'webhook.write');
  requireSite(db, actor, input.siteId);
  await validateWebhookDestination(input.url, lookup);
  const id = randomUUID();
  const secret = randomBytes(32).toString('hex');
  run(
    db,
    'INSERT INTO webhook_endpoints (id, site_id, url, secret, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)',
    id,
    input.siteId,
    input.url,
    secret,
    new Date().toISOString(),
  );
  return { id, secret };
}

export async function deliverDueWebhooks(
  db: DB,
  now: Date,
  transport: Transport,
  lookup?: DnsLookup,
  backoffMs: (attempt: number) => number = (attempt) => [1000, 5000, 15000][Math.min(attempt - 1, 2)] ?? 15000,
): Promise<number> {
  const due = all<{
    id: string;
    attempts: number;
    event_id: string;
    payload_json: string;
    url: string;
    secret: string;
    enabled: number;
  }>(
    db,
    `SELECT o.id, o.attempts, e.id AS event_id, e.payload_json, ep.url, ep.secret, ep.enabled
     FROM webhook_outbox o
     JOIN webhook_events e ON e.id = o.event_id
     JOIN webhook_endpoints ep ON ep.id = o.endpoint_id
     WHERE o.status = 'pending' AND o.next_attempt_at <= ?
     ORDER BY o.next_attempt_at ASC
     LIMIT 10`,
    now.toISOString(),
  );
  let handled = 0;
  for (const item of due) {
    const lease = new Date(now.getTime() + 2 * 60 * 1000).toISOString();
    const claimed = run(
      db,
      `UPDATE webhook_outbox SET attempts = attempts + 1, next_attempt_at = ? WHERE id = ? AND status = 'pending' AND attempts = ?`,
      lease,
      item.id,
      item.attempts,
    );
    if (claimed !== 1) continue;
    const attempt = item.attempts + 1;
    if (!item.enabled) {
      settleWebhook(db, item.id, attempt, 'terminal', 'endpoint disabled', null, now);
      handled += 1;
      continue;
    }
    try {
      await validateWebhookDestination(item.url, lookup);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unsafe destination';
      settleWebhook(db, item.id, attempt, 'terminal', message, null, now);
      handled += 1;
      continue;
    }
    try {
      const response = await transport({
        url: item.url,
        body: item.payload_json,
        headers: webhookHeaders(item.secret, item.event_id, item.payload_json, now),
      });
      if (response.status >= 200 && response.status < 300) {
        settleWebhook(db, item.id, attempt, 'delivered', null, response.status, now);
      } else if (response.status >= 300 && response.status < 400) {
        settleWebhook(db, item.id, attempt, attempt >= 3 ? 'terminal' : 'pending', 'redirect rejected', response.status, now, backoffMs(attempt));
      } else {
        settleWebhook(db, item.id, attempt, attempt >= 3 ? 'terminal' : 'pending', `HTTP ${response.status}`, response.status, now, backoffMs(attempt));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'delivery failed';
      settleWebhook(db, item.id, attempt, attempt >= 3 ? 'terminal' : 'pending', message, null, now, backoffMs(attempt));
    }
    handled += 1;
  }
  return handled;
}

function settleWebhook(
  db: DB,
  outboxId: string,
  attempt: number,
  status: 'pending' | 'delivered' | 'terminal',
  error: string | null,
  responseStatus: number | null,
  now: Date,
  backoff = 0,
): void {
  const next = new Date(now.getTime() + backoff).toISOString();
  run(
    db,
    `UPDATE webhook_outbox SET status = ?, last_error = ?, last_response_status = ?, next_attempt_at = ? WHERE id = ?`,
    status,
    error,
    responseStatus,
    next,
    outboxId,
  );
  run(
    db,
    `INSERT INTO webhook_attempts (id, outbox_id, attempt, response_status, error, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    randomUUID(),
    outboxId,
    attempt,
    responseStatus,
    error,
    now.toISOString(),
  );
}

export function listJobs(db: DB, actor: User, siteId: string) {
  requirePermission(actor, 'schedule');
  requireSite(db, actor, siteId);
  return all(
    db,
    `SELECT j.id, j.status, j.run_at, j.timezone, j.local_input, j.attempts, j.last_error, j.revision_id, e.slug
     FROM scheduled_jobs j JOIN entries e ON e.id = j.entry_id
     WHERE e.site_id = ? ORDER BY j.run_at DESC`,
    siteId,
  );
}

export function listWebhookDeliveries(db: DB, actor: User, siteId: string) {
  requirePermission(actor, 'webhook.write');
  requireSite(db, actor, siteId);
  return all(
    db,
    `SELECT o.id, o.status, o.attempts, o.last_error, o.last_response_status, o.next_attempt_at, ep.url, e.payload_json
     FROM webhook_outbox o
     JOIN webhook_events e ON e.id = o.event_id
     JOIN webhook_endpoints ep ON ep.id = o.endpoint_id
     WHERE e.site_id = ?
     ORDER BY e.created_at DESC`,
    siteId,
  );
}

export function dashboardData(db: DB, actor: User, siteId: string) {
  requireSite(db, actor, siteId);
  return {
    site: siteById(db, siteId),
    locales: all<LocaleRow>(db, 'SELECT * FROM locales WHERE site_id = ? ORDER BY is_default DESC, code', siteId),
    types: all(db, 'SELECT id, api_key, name, schema_version, schema_json FROM content_types WHERE site_id = ? ORDER BY name', siteId),
    entries: all(
      db,
      `SELECT e.*, ct.api_key, ct.name AS type_name, l.code AS locale_code,
              (SELECT revision_number FROM revisions WHERE entry_id = e.id ORDER BY revision_number DESC LIMIT 1) AS latest_number,
              (SELECT id FROM revisions WHERE entry_id = e.id ORDER BY revision_number DESC LIMIT 1) AS latest_id,
              (SELECT revision_number FROM revisions WHERE id = e.published_revision_id) AS published_number
       FROM entries e
       JOIN content_types ct ON ct.id = e.content_type_id
       JOIN locales l ON l.id = e.locale_id
       WHERE e.site_id = ?
       ORDER BY e.updated_at DESC`,
      siteId,
    ),
    media: all(db, 'SELECT id, original_name, alt, mime, size_bytes, created_at FROM media WHERE site_id = ? ORDER BY created_at DESC', siteId),
    redirects: all(
      db,
      `SELECT r.id, r.from_path, r.to_path, r.status_code, l.code AS locale_code
       FROM redirects r JOIN locales l ON l.id = r.locale_id WHERE r.site_id = ?`,
      siteId,
    ),
    endpoints: actor.role === 'administrator'
      ? all(db, 'SELECT id, url, enabled, created_at FROM webhook_endpoints WHERE site_id = ?', siteId)
      : [],
  };
}

export function entryEditorData(db: DB, actor: User, entryId: string) {
  requirePermission(actor, 'entry.read');
  const entry = entryById(db, entryId);
  requireSite(db, actor, entry.site_id);
  const contentType = typeById(db, entry.content_type_id);
  const revisions = all<RevisionRow>(db, 'SELECT * FROM revisions WHERE entry_id = ? ORDER BY revision_number DESC', entry.id);
  const approvals = all<{ revision_id: string; approved_at: string }>(
    db,
    `SELECT a.revision_id, a.approved_at FROM approvals a
     JOIN revisions r ON r.id = a.revision_id WHERE r.entry_id = ?`,
    entry.id,
  );
  const publications = all(
    db,
    'SELECT id, revision_id, event_type, actor_id, created_at, job_id FROM publications WHERE entry_id = ? ORDER BY created_at DESC',
    entry.id,
  );
  return {
    entry,
    contentType,
    document: parseDoc(contentType),
    revisions,
    approvals,
    publications,
    locale: localeById(db, entry.locale_id),
    media: all<{ id: string; alt: string; original_name: string }>(
      db,
      'SELECT id, alt, original_name FROM media WHERE site_id = ? ORDER BY created_at DESC',
      entry.site_id,
    ),
    entryChoices: all<{ id: string; slug: string; locale_code: string }>(
      db,
      `SELECT e.id, e.slug, l.code AS locale_code FROM entries e JOIN locales l ON l.id = e.locale_id
       WHERE e.site_id = ? AND e.id != ? ORDER BY e.slug`,
      entry.site_id,
      entry.id,
    ),
  };
}

export function sitesFor(db: DB, actor: User): SiteRow[] {
  if (actor.role === 'administrator') return all(db, 'SELECT id, name, slug FROM sites ORDER BY name');
  return all(
    db,
    `SELECT s.id, s.name, s.slug FROM sites s JOIN user_sites us ON us.site_id = s.id WHERE us.user_id = ? ORDER BY s.name`,
    actor.id,
  );
}
