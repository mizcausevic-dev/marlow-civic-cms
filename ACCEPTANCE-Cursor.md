# Acceptance results

Command:

```bash
SCRYPT_N=4096 npx tsx --test --test-concurrency=1 test/*.test.ts
```

Observed result: 5 passed, 0 failed, exit 0. Typecheck `npx tsc --noEmit` also exited 0. These runs used disposable SQLite files. They are separate from the browser checks below.

Automated test count: 5 passed, 0 failed.
Scenario count: 19 executed, 19 pass, 0 fail, 0 not run, 0 not implemented.

| Scenario | Result | Where it was executed |
| --- | --- | --- |
| 1. Typed content type, invalid values rejected | PASS | `test/core.test.ts` returned 400 for an unknown field |
| 2. Entry composed from registered blocks | PASS | API save of hero and rich text. Browser editor rendered hero, text, columns, quote, and call to action |
| 3. Draft absent from the public API | PASS | Public GET returned 404 and the draft title was not in the body |
| 4. Preview of an exact revision | PASS | `Authorization: Preview` returned the revision heading with `Cache-Control: private, no-store` |
| 5. Expired, tampered, and wrongly scoped tokens | PASS | 401, 401, and 403 |
| 6. Approve one revision and publish it | PASS | Public API revision id matched the approved revision |
| 7. Separate frontend renders the API | PASS | `test/frontend.test.ts` started both servers. Browser opened `/` and `/ferry-schedule` |
| 8. Edit after approval | PASS | New revision had no approval row. Public revision id stayed on the approved one |
| 9. Unauthorized draft, approval, and publication | PASS | Editor received 403 for approve and publish. Anonymous admin GET redirected 302. Browser approve as editor returned 403 |
| 10. Unknown blocks, invalid props, nesting, bad references | PASS | Each request returned 400 |
| 11. Durable schedule across worker restart | PASS | Worker was sent SIGKILL while the job was still pending. A new worker published one `schedule` event. The test then set `run_at` to the past so it did not wait out the original 60 second delay |
| 12. Concurrent processing without a duplicate event | PASS | Two `worker:once` processes produced one publication. Reclaiming an expired claim did not insert another |
| 13. Rollback writes a new audit event | PASS | `rollback` row appended, public pointer returned to the earlier revision, editor received 403 |
| 14. Archive | PASS | Public GET 404. A published reference became `unavailable` and did not include the title. Publication rows remained |
| 15. Cache policy and preview isolation | PASS | Public `no-store`. Preview `private, no-store`. Preview text was absent from the public response |
| 16. Sites, fallback, slug collisions | PASS | Duplicate slug 409. `locale=es` served English and skipped a Spanish draft. Unassigned editor received 403. The other site's public URL returned 404 |
| 17. Media | PASS | PNG upload redirected 302. HTML and a file over 2 MB returned 400 |
| 18. Webhooks | PASS | HMAC matched the raw body. A 500 was retried and then delivered. `http://127.0.0.1` was rejected. A lookup returning `10.1.2.3` marked the outbox terminal and did not call the transport |
| 19. Redirects and metadata | PASS | `/ferry` resolved 301 to `/about`. An external target and a loop returned 400. Public metadata came from the published revision |

## Browser checks

These are manual and separate from the five automated tests. Playwright drove `http://127.0.0.1:8787` and `http://127.0.0.1:8788` after `npm run seed` on a disposable database.

- Editor signed in, changed the home summary, and saved revision 2 as unapproved.
- The public API still served revision 1 until the publisher approved and confirmed publication.
- After publication, the public API and the public homepage showed the new summary.
- The ferry article rendered its image alt text. `/ferry` on the public site returned 301 to `/ferry-schedule`.
- Private preview opened at `/preview` with the revision id in the page and not in the URL.
- A 390px wide viewport still exposed the heading, navigation, and article links.

## Fresh setup

`npm run migrate` and `npm run seed` were run against `/tmp/marlow-demo/cms.sqlite`. `npm run export:pages` created another disposable database and wrote `docs/`. The automated tests each open their own temporary database. A second machine with a wiped `node_modules` was not used.
