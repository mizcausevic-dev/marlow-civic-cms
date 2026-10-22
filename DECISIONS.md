# Decisions

## D1. Local SQLite, two processes, one worker

The session starts from an empty workspace and core scenarios must run without paid services. `node:sqlite` is built into the available Node.js 22 runtime, so the CMS, the public frontend, and the worker share a file database through SQL rather than a hosted Postgres instance. Tradeoff: SQLite is a single-writer database. Scheduled jobs use a claim token and a lease so concurrent workers do not both publish.

## D2. Session cookies and scrypt, not a homegrown cipher

Passwords use Node.js `crypto.scryptSync`. Session and preview tokens are 32 random bytes stored only as SHA-256 hashes. CSRF tokens are bound to the session. This uses maintained platform cryptography rather than a custom cipher. Development accounts exist only after `npm run seed`, are rejected when `NODE_ENV=production`, and are documented as local-only.

## D3. Immutable revisions, approval bound to the revision id

SQLite triggers abort updates and deletes on revisions, approvals, publications, audit events, and webhook events. A save after approval inserts a new revision and does not copy the approval. Publication points `entries.published_revision_id` at one revision inside the same transaction as the publication row and the webhook outbox.

## D4. Public cache policy is no-store

There is no shared cache in this implementation. Public API and public HTML responses send `Cache-Control: no-store`. Preview responses send `Cache-Control: private, no-store` plus `X-Robots-Tag: noindex, nofollow`. The maximum stale window inside this system is zero. Downstream caches that ignore `no-store` are outside this system and were not tested.

## D5. Webhook delivery does not bypass SSRF for local tests

Destination checks reject non-HTTPS URLs, non-443 ports, credentials in the URL, local names, and unsafe resolved addresses. DNS lookup is injectable so tests can prove a public hostname resolving to a private address is rejected. The production path has no localhost allowlist. Tests capture signed payloads with an injected transport only after validation returns a public address. Redirects are not followed. Delivery is at-least-once from the outbox. Exactly-once delivery to receivers is not claimed.

## D6. Locale and site scope

Slug uniqueness is `(site, locale, slug)`. Translations are separate entries that share a slug across locales. Fallback walks `locales.fallback_locale_id`, stops on cycles, and never returns a draft or archived entry. Roles are global, and editors and publishers also need a `user_sites` row. Administrators can access every site. This is the supported multi-site subset.

## D7. Reference expansion

Public responses expand a reference only when the target is on the same site, published, and not archived. Missing, draft, archived, and cross-site targets all serialize as `{ "status": "unavailable" }` with no title or body. Editorial saves may point at a same-site draft. They may not point at a missing id or another site.

## D8. Content-type changes

Stored schema document version stays at 1. `content_types.schema_version` increments on an accepted change. Removing a field, changing a field type, making a field required, narrowing limits, removing select options, or disabling blocks is rejected while entries exist. Adding an optional field is allowed. Existing revisions stay readable. New saves validate against the current schema.

## D9. Archive and rollback

Archive removes the entry from the public API, frontend routes, reference expansion, and metadata. Publication history is kept. Rollback selects a revision that already has a publication event, writes a new `rollback` publication, and points the entry at that revision. If the entry was archived, rollback clears the current archive flag and records the previous `archived_at` in an append-only audit event. Editors cannot archive or roll back.

## D10. Scheduled jobs publish the selected revision

A job stores `revision_id` at schedule time. The worker does not look up the latest draft. At execution it rechecks that the revision is still approved, the scheduling user still has publisher or administrator rights on the site, and the entry is not archived. Archived entries fail the job. A lease plus `publications.job_id` uniqueness prevents two workers from writing two publication events for one job.

## D11. GitHub Pages is a static export

The dynamic CMS cannot run on GitHub Pages. `npm run export:pages` renders the public frontend, which reads the CMS over HTTP, into `docs/`. That export is the only Pages artifact. It is not a live CMS.

## D12. Instruction conflicts

The mission names `PLAN.md`, `PROGRESS.md`, `DECISIONS.md`, and `README.md`, so those files do not use a `-Cursor` suffix. Other authored reports do. The seven-theme dashboard preference is not applied. The mission says not to spend the session polishing a dashboard while publishing is unfinished. One architecture visualization is included instead.

## D13. Preview lives on the CMS

Preview tokens are bearer capabilities bound to one revision, site, and locale. They are set as an HttpOnly cookie on `/preview` or sent as a `Preview` authorization header. They are not put in the query string. The public frontend refuses any path outside `/api/public/` and `/media/`.
