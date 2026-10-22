# Publish one revision, not the latest draft

**Slug:** `publish-one-revision-not-the-latest-draft`

**Meta description:** A schema-driven CMS should approve and publish an exact revision. Drafts, previews, webhooks, and the public site each need a hard boundary of their own.

---

A publish button that means "whatever is newest" will eventually ship the wrong paragraph. The safer model is smaller and stricter: an editor saves an immutable revision, a publisher approves that revision id, and the public site renders only the revision that publication pointed at.

That is the rule I built into Marlow Civic Desk, a local newsroom CMS with a constrained block editor and a separate public frontend. The source is at [github.com/mizcausevic-dev/marlow-civic-cms](https://github.com/mizcausevic-dev/marlow-civic-cms). It is a working local system, not a production hosting claim. The interesting part is the boundary between draft, approval, and what a reader can see.

## What breaks when publish means the latest draft?

Editors do not work in a straight line. They save, get a note, save again, and leave a half-finished dek in the box while the previous version is the one that was actually approved. If the publisher's job, or a scheduled job, resolves "latest" at execution time, the half-finished dek goes live.

I have watched that failure in editorial tools that treat the entry as one mutable document. The status pill says published. The body says something nobody approved. The audit log, if it exists, says a person published "the entry" and cannot name the bytes.

Marlow refuses that shortcut. A save inserts a new revision row. Database triggers abort updates and deletes on revisions, approvals, publication events, and webhook events. Approval is a row tied to one revision id. The next save does not copy the approval. The public pointer, `published_revision_id`, moves only inside the same transaction that writes a publication event.

So the question "what is live?" has a boring answer: this revision id, written at this time, by this actor, as this event type. Publish, schedule, and rollback are all events. None of them rewrite history.

## How should approval bind to a revision?

Bind it to the id, not to the entry and not to a version number you recompute later.

In this CMS the roles are small on purpose.

- An editor can draft and preview.
- A publisher can approve, publish, schedule, archive, and roll back.
- An administrator can also change content types, sites, locales, and webhooks.

Editors and publishers also need a site membership. Administrators can reach every site. The checks live in the service that writes data, not only in the buttons. An editor who posts the approve route gets a 403. An anonymous request for a draft does not get the draft.

The approval screen is a confirmation, not a toast. Publishing asks the publisher to confirm that this exact revision becomes the public one, and that the previous public revision stays in history. That sentence is the product. If the interface hides the revision id, people will assume publish means "current."

Rollback follows the same rule. It may only select a revision that already appears in the publication log. It appends a new rollback event and moves the pointer. If the entry was archived, rollback records the old archive timestamp on the audit event and clears the current archive flag. It does not delete the earlier publication rows.

Archive is the other half. Archived entries disappear from the public API, the public routes, reference expansion, and metadata. The history stays. A public reference to an archived target comes back as `unavailable`, with no title and no body, so the absence does not leak the draft.

## Why must the public site never read the CMS database?

Because the database is full of things readers must not see. Drafts, unapproved rewrites, preview tokens, webhook secrets, and password hashes all sit next to the published row. A frontend that imports the database client will eventually query one join too far.

Marlow runs two HTTP processes. The CMS owns SQLite, sessions, and the public JSON API. The public frontend is a separate process. Its HTTP client refuses any path that is not `/api/public/` or `/media/`. A test reads the frontend source and fails if that code imports the database or the CMS service layer.

The public read is dull on purpose. Look up the site, walk the locale fallback chain, and return the first published, non-archived entry for that slug. Fallback stops on cycles and never returns a draft. A Spanish request for a slug that only has an English published page gets the English page and says so. A Spanish draft with the same slug is skipped. Lists do not fall back. A list that silently fills gaps from another locale will mix languages and, worse, can be tempted to fill from unpublished rows.

Media has the same boundary. A file is public only when some published revision references it. The server checks the file signature, rejects SVG and HTML, caps the size, and serves images with `nosniff` and a content security policy of `default-src 'none'`. The original filename is a label. The storage key is generated.

## What does a safe preview token look like?

A preview is a capability, not a public URL.

The CMS mints 32 random bytes, stores only the SHA-256, and binds that hash to one revision, one site, and one locale. The browser gets an HttpOnly cookie scoped to `/preview`, or a caller sends `Authorization: Preview`. The token is not placed in the query string, so it does not land in access logs that record the path, and it does not leak through a normal referrer. The response sends `Cache-Control: private, no-store` and `X-Robots-Tag: noindex, nofollow`.

Expired tokens, tampered tokens, and tokens presented for a different revision are rejected. That last case matters. A token for revision A must not render revision B just because the same person is logged in.

There is still a residual risk, and it should be written down. Any log that records the `Cookie` or `Authorization` header will capture the token. This app does not log those headers. If you put the same design behind a proxy that does, fix the proxy.

Do not point preview links at the public frontend. The public app has no draft route. In Marlow, a reference inside a preview shows the title when the target is already public and otherwise says the linked entry is not public. It does not fetch the draft through a side door.

## How do you schedule a publish without guessing later?

Store the revision id when the editor schedules the job. Store the UTC instant. Store the timezone name they picked, and show that name next to the UTC time. Do not convert "Thursday at 4" into "whatever the entry looks like on Thursday."

The worker claims due jobs with a token and a lease. If the process dies after the claim, another worker can take the job when the lease expires. The publication row has a unique job id, so two workers cannot write two publication events for the same scheduled operation. That is idempotent publication inside this system. It is not exactly-once delivery to somebody else's server.

At execution time the worker rechecks the facts that could have changed. Is this revision still approved? Does the person who scheduled it still have publisher or administrator rights on the site? Is the entry archived? An archived entry fails the job and records the error. It does not publish anyway.

I tested this by starting a worker, killing it while the job was still pending, and starting another worker. The test then moved the due time into the past so it did not sit for the original delay. One schedule event was written. A second pair of workers processing the same job still produced one publication.

## What should a webhook receiver verify?

Sign the exact bytes you send, and write those bytes in the same database transaction as the publication. Marlow inserts a webhook event and one outbox row per enabled endpoint before the transaction commits. The worker delivers later. If delivery fails, the publication is already recorded and the failure is visible.

The signature headers are:

- `Webhook-Id`, the stable event id
- `Webhook-Timestamp`, unix seconds
- `Webhook-Signature`, `v1=` plus HMAC-SHA256 of `timestamp + "." + rawBody`

A receiver should reject timestamps skewed more than five minutes and dedupe on the event id. Compare the HMAC with a constant-time function. Do not re-serialize the JSON and sign your own rendering of it. Key order and whitespace are part of the signature.

The sender also has a duty not to become an open proxy. Destinations must be `https` on port 443, with no username or password in the URL. The worker resolves DNS and rejects loopback, private, link-local, and other non-public addresses, including a public name that resolves to a private address. Redirects are not followed. Tests inject the DNS lookup and the HTTP transport. There is no localhost allowlist hiding in production. Retries are capped, and a blocked destination becomes a terminal outbox row with an error string an administrator can read.

Do not describe that as exactly-once delivery. The outbox is at-least-once. The receiver's dedupe is what makes the business action once.

## How do blocks stay documents instead of code?

Let authors compose a page. Do not let them import a component, write a template, or sneak in a script.

Marlow's registry is `hero`, `richText`, `image`, `quote`, `cta`, `reference`, and `columns`. Unknown types are rejected. Props are checked on the server. Nesting stops at depth 3. A page stops at 40 blocks. The JSON payload stops at 200 KB. Rich text is a list of paragraphs, headings, and quotes, escaped when rendered. Links must be `http`, `https`, or a same-site path.

Content type changes get the same suspicion. Adding an optional field is allowed. Removing a field, changing its type, making it required, shortening it, or turning blocks off is rejected once entries exist. Old revisions stay readable under the schema version they were saved with. Silent migration is how you corrupt a year of stories.

Slug uniqueness is site plus locale. Two sites may use the same slug. Two locales on one site may use the same slug, because those are translations, not the same row. A cross-site reference is invalid at save time.

## What should you cache, and what should you refuse to cache?

If you do not have a shared cache, say so. Marlow sends `Cache-Control: no-store` on public API responses, public HTML, and media. Previews send `private, no-store`. The stale window inside this system is zero. I did not test a CDN, because there is no CDN in the setup. A downstream cache that ignores `no-store` is outside the claim.

That choice is slower and honest. It also keeps a draft preview from ever sharing a cache entry with the public page. If you add a cache later, the key has to include site, locale, slug, and the published revision id, and the preview route has to stay out of it.

## FAQ

### Does this replace a hosted headless CMS?

No. Marlow runs on Node.js and a SQLite file on a machine you control. It is a reference implementation of the publishing rules, with tests for the editorial path. It is not a multi-tenant host, and the seeded logins are development accounts that the seed script refuses to create when `NODE_ENV=production`.

### Can a scheduled job publish a newer draft if the editor keeps typing?

No. The job stores the revision id that was approved when it was scheduled. Later saves create unapproved revisions and do not change the job.

### What does the public site do with a missing translation?

For a single entry, it walks the locale fallback chain, skips unpublished and archived rows, and returns the first public match. It tells the client which locale it served. Entry lists stay in the requested locale.

### How do I know a webhook was not forged?

Recompute HMAC-SHA256 over the raw body you received, using the timestamp header and the shared secret. Reject old timestamps and ids you have already applied.

### Where are the screenshots?

The running CMS and the public frontend are not hosted on GitHub Pages. Screenshot previews of the homepage, the ferry article, sign-in, the entry list, and the block editor are published from the `livepages` branch of the repository.

## What to do with this

If you are designing an editorial tool, write down one sentence before you pick a framework: publish moves a pointer to an immutable revision, and the public site can only read through that pointer.

Then test the sentence. Save after approval and prove the public body did not change. Open a preview with a token for the wrong revision and prove it fails. Kill the scheduler and prove the job still publishes once. Point a webhook at a private address and prove the request never leaves.

Marlow is one way to hold that line. The code, the role table, and the setup commands are in the repository. Read the publication path before you read the CSS.
