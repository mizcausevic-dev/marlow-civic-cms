import { serve } from '@hono/node-server';
import { createWebApp } from './app.ts';

const port = Number(process.env.WEB_PORT ?? 8788);
const cmsOrigin = process.env.CMS_ORIGIN ?? 'http://127.0.0.1:8787';
const siteSlug = process.env.SITE_SLUG ?? 'marlow';
const app = createWebApp({ cmsOrigin, siteSlug });

serve({ fetch: app.fetch, port }, () => {
  console.log(JSON.stringify({ event: 'web_listen', port, cmsOrigin, siteSlug }));
});
