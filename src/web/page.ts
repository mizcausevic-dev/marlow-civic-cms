import type { PublicEntry, PublicSummary } from '../contract/public.ts';
import { esc, renderBlocks } from '../render/blocks.ts';

export function renderPublicPage(input: {
  entry?: PublicEntry;
  nav: PublicSummary[];
  link: (slug: string) => string;
  mediaSrc: (id: string) => string;
  banner?: string;
  status?: number;
  message?: string;
}): string {
  const nav = input.nav
    .filter((item) => item.contentType === 'page')
    .map((item) => `<a href="${esc(input.link(item.slug))}">${esc(item.title)}</a>`)
    .join('');
  const entry = input.entry;
  const summary = entry && typeof entry.fields.summary === 'string' ? entry.fields.summary : '';
  const main = entry
    ? `${entry.fallback ? `<p class="kicker">Showing ${esc(entry.localeServed)} because ${esc(entry.localeRequested)} is not published</p>` : ''}
       ${summary ? `<p class="dek">${esc(summary)}</p>` : ''}
       ${renderBlocks(entry.blocks, {
         mediaSrc: input.mediaSrc,
         entryHref: input.link,
         references: entry.references,
       })}`
    : `<h1>Not on the desk</h1><p>${esc(input.message ?? 'That page is not published.')}</p>`;
  const title = entry?.meta.title ?? 'Marlow Civic Desk';
  const description = entry?.meta.description ?? 'Published pages from the Marlow Civic Desk.';
  const jsonLd = entry
    ? JSON.stringify({
        '@context': 'https://schema.org',
        '@type': entry.contentType === 'article' ? 'NewsArticle' : 'WebPage',
        headline: entry.meta.title,
        description: entry.meta.description,
        datePublished: entry.publishedAt,
        inLanguage: entry.localeServed,
        publisher: { '@type': 'Organization', name: 'Marlow Civic Desk' },
      })
    : '';
  return `<!doctype html>
<html lang="${esc(entry?.localeServed ?? 'en')}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}" />
  <link rel="stylesheet" href="/assets/site.css" />
  ${jsonLd ? `<script type="application/ld+json">${jsonLd.replace(/</g, '\\u003c')}</script>` : ''}
</head>
<body>
  <a class="skip" href="#main">Skip to content</a>
  <header class="mast"><div class="wrap"><div class="brand"><a href="${esc(input.link('home'))}">Marlow Civic Desk</a></div><nav>${nav}</nav></div></header>
  <article class="wrap" id="main">
    ${input.banner ? `<p class="kicker">${esc(input.banner)}</p>` : ''}
    ${main}
  </article>
  <footer><div class="wrap">Published through the content API. Drafts are not on this site.</div></footer>
</body>
</html>`;
}
