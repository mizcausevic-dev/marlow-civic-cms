# Marlow Civic Desk

Schema-driven newsroom CMS with immutable revisions, a constrained block editor, and a separate public frontend. The frontend reads the content API over HTTP. It does not open the CMS database.

This is a local editorial tool. It is not a production deployment.

## What you need

- Node.js 22.13 or newer. This workspace was verified on v22.23.3.
- npm 10 or newer.

No external database, account, or paid service is required.

## Setup

```bash
npm install
npm run migrate
npm run seed
```

`npm run seed` creates a SQLite file at `data/cms.sqlite`, writes media under `data/media`, and inserts development accounts. It refuses to run when `NODE_ENV=production`. Delete `data/cms.sqlite` to seed again.

Development accounts, local only:

| Email | Password | Role |
| --- | --- | --- |
| ada.editor@marlow.test | local-editor-pass | editor |
| ben.publisher@marlow.test | local-publisher-pass | publisher |
| cam.admin@marlow.test | local-admin-pass | administrator |

## Run

Use three terminals:

```bash
npm run cms
npm run web
npm run worker
```

- CMS: http://127.0.0.1:8787/admin
- Public site: http://127.0.0.1:8788/
- Worker: polls `data/cms.sqlite` for due publication jobs and webhook deliveries.

Environment variables are listed in `.env.example`. Set `COOKIE_SECURE=1` when the CMS is served over HTTPS.

## Test and typecheck

```bash
npm test
npm run typecheck
```

`npm test` sets `SCRYPT_N=4096` so password hashing in tests stays on scrypt without the production cost. The default outside tests is 16384.

## Static preview

```bash
npm run export:pages
```

This seeds a disposable database, renders the public frontend through the content API, and writes `docs/`. That folder is a static snapshot for GitHub Pages. It is not a running CMS.

## Roles

| Action | Editor | Publisher | Administrator |
| --- | --- | --- | --- |
| Edit entries and preview | yes | yes | yes |
| Approve, publish, schedule, archive, roll back | no | yes | yes |
| Content types, sites, locales, webhooks | no | no | yes |

Editors and publishers also need a row in `user_sites`. Administrators can access every site.

## GitHub

Repository: https://github.com/mizcausevic-dev/marlow-civic-cms

About: Schema-driven newsroom CMS with immutable revisions, a constrained block editor, and a separate public frontend.

Topics: `cms`, `block-editor`, `typescript`, `sqlite`, `publishing`, `webhooks`, `content-modeling`, `editorial-workflow`, `hono`

Screenshot previews live on the `livepages` branch and in `preview/index.html`. GitHub Actions publishes that gallery. The dynamic CMS still runs locally with the commands above. `docs/` is a separate static export of the published example site.
