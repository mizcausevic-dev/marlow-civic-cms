# Progress

Start: 2026-10-20T18:20:32Z (`date -u` at inspection).
Latest check: 2026-10-20T19:03:01Z (`date -u` after export).

Elapsed wall clock at that check: 42 minutes 29 seconds. This is a measured difference, not an estimate. Work stopped when the core and supporting scenarios were implemented and verified. Time was not padded.

## Environment

- Empty workspace. Node.js v22.23.3 with `node:sqlite`. npm 10.9.9.
- `gh auth status` reported logged out. No `GH_TOKEN` was present. GitHub push and GitHub Pages were not completed.

## Completed

- CMS, public frontend, and worker.
- Migrations, seed, role checks, revisions, preview, publish, schedule, archive, rollback, media, redirects, locales, and signed webhooks.
- Automated scenarios 1-19. See `ACCEPTANCE-Cursor.md`.
- Browser pass of sign-in, revision save, rejected editor approval, publisher approval, confirmed publish, public render, redirect, and preview.
- Static export in `docs/` from the public frontend calling the content API.

## Fixes from verification

- Removed inline styles that the content security policy blocked.
- Public pages now show the published summary field.
- `/favicon.ico` returns 204.

## Not done

- Push to GitHub.
- Enabling GitHub Pages. `docs/` is the artifact that would be published.
