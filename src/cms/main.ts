import { serve } from '@hono/node-server';
import { openDatabase, migrate } from '../db/db.ts';
import { createCmsApp } from '../http/cms-app.ts';

const databasePath = process.env.DATABASE_PATH ?? './data/cms.sqlite';
const mediaRoot = process.env.MEDIA_ROOT ?? './data/media';
const port = Number(process.env.CMS_PORT ?? 8787);
const db = openDatabase(databasePath);
migrate(db);

const app = createCmsApp({
  db,
  mediaRoot,
  secureCookies: process.env.COOKIE_SECURE === '1',
});

serve({ fetch: app.fetch, port }, () => {
  console.log(JSON.stringify({ event: 'cms_listen', port, databasePath }));
});
