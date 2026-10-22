# Architecture

Marlow Civic Desk is three processes over one SQLite file.

```text
editor browser
    |
    | cookie session, CSRF
    v
CMS process (src/cms/main.ts)
    |-- admin HTML and JSON
    |-- preview tokens
    |-- public JSON API /api/public
    |-- public media, only if a published revision references it
    |
    +--> SQLite (migrations/001_init.sql)
            ^
            | claim token + lease
worker (src/worker/main.ts)
    |-- scheduled publication
    |-- webhook outbox delivery

public browser
    |
    v
web process (src/web/main.ts)
    |
    | HTTP GET /api/public and /media only
    v
CMS public API
```

The web process imports render helpers and the public contract. It does not import the database or the CMS service layer.

## Publication

A save inserts a new row in `revisions`. Triggers reject updates and deletes. Approval is a row in `approvals` for that revision id. A later save does not copy the approval.

`publishEntryRevision` runs in one transaction:

1. Require an approval for the exact revision.
2. Insert a `publications` row (`publish`, `schedule`, or `rollback`).
3. Point `entries.published_revision_id` at that revision and set status to `published`.
4. Insert an audit event.
5. Insert a webhook event and one outbox row per enabled endpoint.

Rollback requires the chosen revision to already appear in `publications`. It appends a new `rollback` event. It does not delete older events. If the entry was archived, rollback clears the current archive flag and stores the previous `archived_at` on the audit event.

Archive sets `entries.status` to `archived`. Public queries treat that as missing. History stays.

## References

Slug uniqueness is `(site_id, locale_id, slug)`. A reference field or reference block must point at an entry on the same site. Draft targets are allowed in the editor. The public serializer returns `{ "status": "unavailable" }` with no title or body when the target is missing, draft, archived, or on another site. Expansion is one level.

Locale fallback walks `fallback_locale_id`, stops at five steps, and stops if a locale repeats. It skips unpublished and archived entries. Entry lists do not fall back. A single entry read does.

## Previews

`POST` mints 32 random bytes, stores only the SHA-256, and binds the hash to one revision, site, and locale. The browser receives an HttpOnly cookie on `/preview` or an `Authorization: Preview` header. The token is not placed in the query string. Responses use `Cache-Control: private, no-store` and `X-Robots-Tag: noindex, nofollow`. Residual exposure: the cookie is sent to `/preview` on this origin, and server access logs that record `Cookie` would capture it. This app's request log does not record cookies or the header.

## Authorization

Passwords use Node.js `crypto.scryptSync`. Sessions are random tokens stored as SHA-256 hashes, with a CSRF secret checked on POST. Permissions are enforced in the service layer for reads, writes, preview, approval, and publication. See the role table in `README.md`.

## Caching

There is no shared cache. Public API, public HTML, and media responses send `Cache-Control: no-store`. Preview responses send `private, no-store`. The stale window inside this system is zero. A downstream cache that ignores `no-store` was not tested because none is configured.

## Webhooks

The publication transaction writes the canonical JSON body into `webhook_events` and the outbox. The worker signs the exact bytes:

```text
Webhook-Id: <event id>
Webhook-Timestamp: <unix seconds>
Webhook-Signature: v1=<hex HMAC-SHA256(secret, timestamp + "." + rawBody)>
```

Receivers should reject timestamps skewed more than five minutes and dedupe `id`. Delivery retries up to three times. Redirects are not followed. Destinations must be `https` on port 443, without credentials. The worker resolves DNS and rejects loopback, private, link-local, and other non-public addresses, including a public name that resolves to a private address. Tests inject the lookup and the transport. Production has no localhost allowlist. Delivery to receivers is at-least-once. Exactly-once delivery is not claimed.

## Scheduling

A job stores the approved revision id, the UTC instant, and the IANA timezone the editor selected. The worker does not load the latest draft. Before publishing it checks that the revision is still approved, the scheduling user is still a publisher or administrator on that site, and the entry is not archived. A claim token and lease let a restarted worker pick up an expired claim. `publications.job_id` is unique, so two workers cannot insert two publication events for one job.

## Blocks and schema changes

The registry is `hero`, `richText`, `image`, `quote`, `cta`, `reference`, and `columns`. Unknown types, invalid props, more than 40 blocks, depth greater than 3, and payloads over 200 KB are rejected. Rich text is a structured list of paragraphs, headings, and quotes, escaped on render. URLs must be `http`, `https`, or a same-site path.

Adding an optional field is allowed. Removing a field, changing its type, making it required, shortening it, or turning blocks off is rejected once entries exist. Old revisions remain readable.
