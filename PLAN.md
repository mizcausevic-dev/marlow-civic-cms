# Plan

Started: 2026-10-20T18:20:32Z (from `date -u` in this environment).

## Product

Marlow Civic Desk is a local-first newsroom CMS. Editors model content types, compose pages from an allowlisted block registry, preview an exact revision, approve that revision, and publish it. A separate frontend renders only the public content API.

Business goal: prove a reliable editorial publishing path. Page goal: an editor can publish a composed page and a reader can see that exact revision. KPIs for this build are acceptance scenarios, not analytics events. No GA4 container is wired.

## Stack

- Node.js 22 with built-in `node:sqlite` (no external database).
- Hono for two HTTP entry points: CMS and public frontend.
- Zod for content-type and input schemas.
- `tsx` to run TypeScript directly.
- One worker process for scheduled publication and webhook delivery.

## Milestones

1. Foundation: schema, migrations, seed, auth, authorization. Done.
2. Core slice: types, entries, blocks, immutable revisions, preview, approval, atomic publish, public API, frontend. Done.
3. Reliability: durable scheduler, comparison, archive, rollback, workflow tests. Done.
4. Supporting modules: sites and locales, media, signed webhooks, redirects, metadata. Done.
5. Acceptance run and static export. Done. GitHub push was blocked by missing credentials.

## Priority cuts

If execution stops early, Priority 1 must already be runnable. Priority 3 can be labeled incomplete. The publishing and authorization model does not get weakened to widen the feature list.

## Out of scope

Paid hosting, production deploy, public cache CDN, and exactly-once webhook delivery to third parties.
