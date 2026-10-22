import fs from 'node:fs';
import { Hono } from 'hono';
import type { PublicEntry, PublicSummary } from '../contract/public.ts';
import { cmsGet } from './client.ts';
import { renderPublicPage } from './page.ts';

export function createWebApp(options: { cmsOrigin: string; siteSlug: string; banner?: string; linkMode?: 'root' | 'html' }) {
  const app = new Hono();
  const link = (slug: string) => {
    if (options.linkMode === 'html') return slug === 'home' ? './index.html' : `./${slug}.html`;
    return slug === 'home' ? '/' : `/${slug}`;
  };
  const mediaSrc = (id: string) => (options.linkMode === 'html' ? `./media/${id}` : `/media/${id}`);

  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Frame-Options', 'DENY');
    c.header('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
    if (!c.res.headers.get('Cache-Control')) c.header('Cache-Control', 'no-store');
  });

  app.get('/favicon.ico', (c) => c.body(null, 204));
  app.get('/assets/site.css', (c) => {
    const css = fs.readFileSync(new URL('../ui/site.css', import.meta.url), 'utf8');
    return c.body(css, 200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' });
  });

  app.get('/media/:id', async (c) => {
    const id = c.req.param('id');
    if (!/^[0-9a-f-]{36}$/i.test(id)) return c.text('Not found', 404);
    const upstream = await fetch(new URL(`/media/${id}`, options.cmsOrigin), { redirect: 'manual' });
    if (!upstream.ok) return c.text('Not found', 404);
    const bytes = Buffer.from(await upstream.arrayBuffer());
    return new Response(bytes, {
      status: 200,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'",
      },
    });
  });

  app.get('/', (c) => renderPath(c, options, '', link, mediaSrc));
  app.get('/l/:locale', (c) => renderPath(c, options, '', link, mediaSrc, c.req.param('locale')));
  app.get('/l/:locale/:slug', (c) => renderPath(c, options, c.req.param('slug'), link, mediaSrc, c.req.param('locale')));
  app.get('/:slug', (c) => renderPath(c, options, c.req.param('slug'), link, mediaSrc));
  return app;
}

type PageContext = {
  html: (body: string, status?: 200 | 404) => Response | Promise<Response>;
  redirect: (location: string, status?: 301 | 302) => Response | Promise<Response>;
};

async function renderPath(
  c: PageContext,
  options: { cmsOrigin: string; siteSlug: string; banner?: string },
  slug: string,
  link: (slug: string) => string,
  mediaSrc: (id: string) => string,
  locale?: string,
): Promise<Response> {
  const path = slug ? `/${slug}` : '/home';
  const localeQuery = locale ? `&locale=${encodeURIComponent(locale)}` : '';
  const redirect = await cmsGet(
    options.cmsOrigin,
    `/api/public/${options.siteSlug}/redirect?path=${encodeURIComponent(path)}${localeQuery}`,
  );
  if (redirect.status === 200) {
    const payload = JSON.parse(redirect.body) as { to?: string; statusCode?: number };
    if (payload.to && payload.to.startsWith('/') && !payload.to.startsWith('//')) {
      const destination = payload.to === '/home' ? '/' : payload.to;
      return await c.redirect(destination, payload.statusCode === 302 ? 302 : 301);
    }
  }
  const navResponse = await cmsGet(options.cmsOrigin, `/api/public/${options.siteSlug}/entries?type=page${localeQuery}`);
  const nav = navResponse.status === 200 ? ((JSON.parse(navResponse.body) as { items: PublicSummary[] }).items ?? []) : [];
  const target = slug || 'home';
  const entryResponse = await cmsGet(
    options.cmsOrigin,
    `/api/public/${options.siteSlug}/entries/${encodeURIComponent(target)}${locale ? `?locale=${encodeURIComponent(locale)}` : ''}`,
  );
  if (entryResponse.status !== 200) {
    return await c.html(
      renderPublicPage({ nav, link, mediaSrc, banner: options.banner, message: 'That page is not published.' }),
      404,
    );
  }
  const entry = JSON.parse(entryResponse.body) as PublicEntry;
  return await c.html(renderPublicPage({ entry, nav, link, mediaSrc, banner: options.banner }));
}
