import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db/db.ts';
import { seed } from '../src/db/seed.ts';
import { createCmsApp } from '../src/http/cms-app.ts';
import { createWebApp } from '../src/web/app.ts';
import { listen } from '../test/helpers.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marlow-export-'));
const databasePath = path.join(dir, 'cms.sqlite');
const mediaRoot = path.join(dir, 'media');
seed(databasePath, mediaRoot);
const db = openDatabase(databasePath);
const cms = await listen(createCmsApp({ db, mediaRoot }));
const web = await listen(
  createWebApp({
    cmsOrigin: cms.origin,
    siteSlug: 'marlow',
    linkMode: 'html',
    banner: 'Static export of published pages. The CMS, database, and worker are not hosted here.',
  }),
);

const pages: Array<[string, string]> = [
  ['/', 'index.html'],
  ['/about', 'about.html'],
  ['/ferry-schedule', 'ferry-schedule.html'],
  ['/harbor-market', 'harbor-market.html'],
  ['/transit-desk', 'transit-desk.html'],
  ['/l/es', 'es.html'],
];

const out = path.resolve('docs');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'assets'), { recursive: true });
fs.mkdirSync(path.join(out, 'media'), { recursive: true });
fs.writeFileSync(path.join(out, '.nojekyll'), '');

function relativize(html: string): string {
  return html
    .replaceAll('href="/assets/', 'href="./assets/')
    .replaceAll('src="/media/', 'src="./media/')
    .replaceAll('href="/"', 'href="./index.html"')
    .replace(/href="\/([a-z0-9-]+)"/g, 'href="./$1.html"');
}

for (const [route, file] of pages) {
  const response = await fetch(`${web.origin}${route}`);
  if (!response.ok) throw new Error(`${route} returned ${response.status}`);
  fs.writeFileSync(path.join(out, file), relativize(await response.text()));
}

const css = await fetch(`${web.origin}/assets/site.css`);
if (!css.ok) throw new Error('stylesheet export failed');
fs.writeFileSync(path.join(out, 'assets', 'site.css'), await css.text());

const ids = new Set<string>();
for (const [, file] of pages) {
  const html = fs.readFileSync(path.join(out, file), 'utf8');
  for (const match of html.matchAll(/(?:\.\/|\/)media\/([0-9a-f-]{36})/g)) {
    if (match[1]) ids.add(match[1]);
  }
}
for (const id of ids) {
  const response = await fetch(`${web.origin}/media/${id}`);
  if (!response.ok) throw new Error(`media ${id} returned ${response.status}`);
  fs.writeFileSync(path.join(out, 'media', id), Buffer.from(await response.arrayBuffer()));
}

await web.close();
await cms.close();
db.close();
console.log(JSON.stringify({ event: 'exported', directory: 'docs', pages: pages.map(([, file]) => file), media: ids.size }));
