import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { openDatabase, migrate } from './db.ts';
import { solidPng } from '../domain/media.ts';
import { createContentType, createEntry, createLocale, createRedirect, createSite, createUser, publishEntryRevision, approveRevision, saveMedia, addSiteMember } from '../services/cms.ts';
import type { User } from '../domain/authz.ts';

const pageDoc = {
  version: 1 as const,
  blocks: true,
  fields: [
    { key: 'title', label: 'Title', type: 'string' as const, required: true, maxLength: 140 },
    { key: 'summary', label: 'Summary', type: 'text' as const, required: false },
    { key: 'seoTitle', label: 'SEO title', type: 'string' as const, required: false, maxLength: 70 },
    { key: 'seoDescription', label: 'SEO description', type: 'text' as const, required: false, maxLength: 160 },
  ],
};

const articleDoc = {
  ...pageDoc,
  fields: [
    ...pageDoc.fields,
    { key: 'dek', label: 'Dek', type: 'text' as const, required: false, maxLength: 240 },
  ],
};

const placeDoc = {
  ...pageDoc,
  fields: [
    ...pageDoc.fields,
    { key: 'address', label: 'Address', type: 'string' as const, required: false, maxLength: 200 },
    { key: 'website', label: 'Website', type: 'url' as const, required: false },
  ],
};

export function seed(databasePath: string, mediaRoot: string): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed development accounts when NODE_ENV=production');
  }
  const db = openDatabase(databasePath);
  migrate(db);
  const existing = db.prepare('SELECT id FROM sites WHERE slug = ?').get('marlow');
  if (existing) {
    db.close();
    throw new Error('Marlow is already seeded. Delete the database file to start over.');
  }
  const admin = createUser(db, {
    email: 'cam.admin@marlow.test',
    name: 'Cam Admin',
    password: 'local-admin-pass',
    role: 'administrator',
  });
  const editor = createUser(db, {
    email: 'ada.editor@marlow.test',
    name: 'Ada Editor',
    password: 'local-editor-pass',
    role: 'editor',
  });
  const publisher = createUser(db, {
    email: 'ben.publisher@marlow.test',
    name: 'Ben Publisher',
    password: 'local-publisher-pass',
    role: 'publisher',
  });
  const site = createSite(db, admin, { name: 'Marlow Civic Desk', slug: 'marlow' });
  for (const user of [admin, editor, publisher]) addSiteMember(db, admin, site.id, user.id);
  const english = db.prepare('SELECT id FROM locales WHERE site_id = ? AND code = ?').get(site.id, 'en') as { id: string };
  const spanish = createLocale(db, admin, {
    siteId: site.id,
    code: 'es',
    name: 'Español',
    fallbackLocaleId: english.id,
    isDefault: false,
  });
  const page = createContentType(db, admin, { siteId: site.id, apiKey: 'page', name: 'Page', document: pageDoc });
  const article = createContentType(db, admin, { siteId: site.id, apiKey: 'article', name: 'Article', document: articleDoc });
  const place = createContentType(db, admin, { siteId: site.id, apiKey: 'place', name: 'Place', document: placeDoc });
  const media = saveMedia(db, admin, mediaRoot, {
    siteId: site.id,
    bytes: solidPng(64, 40, [15, 110, 106, 255]),
    originalName: 'harbor-dawn.png',
    alt: 'Marlow harbor from the east pier at dawn',
  });

  const articleEntry = makeEntry(db, admin, {
    siteId: site.id,
    contentTypeId: article.id,
    localeId: english.id,
    slug: 'ferry-schedule',
    fields: {
      title: 'Ferry schedule cut to six crossings',
      summary: 'The Thursday harbor vote will decide whether the last boat stays at 7:10 p.m.',
      dek: 'Crew, commuters, and the market vendors who miss the late boat.',
      seoTitle: 'Ferry schedule cut to six crossings',
      seoDescription: 'Marlow is considering a six-crossing ferry day. The vote is Thursday.',
    },
    blocks: [
      { type: 'hero', props: { heading: 'Six crossings, if the vote holds', subheading: 'The 9:40 p.m. boat is the one the market vendors use.', ctaLabel: '', ctaHref: '' } },
      { type: 'richText', props: { nodes: [{ kind: 'p', text: 'Harbor Master Lina Ortiz posted the trial schedule on the pier office door Monday.' }] } },
      { type: 'image', props: { mediaId: media.id, alt: 'Marlow harbor from the east pier at dawn', caption: 'East pier, Monday morning.' } },
    ],
  });
  const placeEntry = makeEntry(db, admin, {
    siteId: site.id,
    contentTypeId: place.id,
    localeId: english.id,
    slug: 'harbor-market',
    fields: {
      title: 'Harbor Market',
      summary: 'Saturday stalls along the east pier.',
      address: '1 Pier Walk, Marlow',
      website: 'https://example.com/harbor-market',
      seoTitle: 'Harbor Market',
      seoDescription: 'Saturday stalls on the east pier in Marlow.',
    },
    blocks: [{ type: 'richText', props: { nodes: [{ kind: 'p', text: 'The market opens at 8 and packs out when the afternoon ferry leaves.' }] } }],
  });
  makeEntry(db, admin, {
    siteId: site.id,
    contentTypeId: page.id,
    localeId: english.id,
    slug: 'home',
    fields: {
      title: 'Marlow Civic Desk',
      summary: 'Harbor news for a town that still argues in person.',
      seoTitle: 'Marlow Civic Desk',
      seoDescription: 'Ferry changes, the Thursday vote, and the east pier market.',
    },
    blocks: [
      { type: 'hero', props: { heading: 'The harbor vote is Thursday', subheading: 'Six crossings on the trial card, and a market that wants the late boat back.', ctaLabel: 'Read the ferry brief', ctaHref: '/ferry-schedule' } },
      { type: 'richText', props: { nodes: [{ kind: 'p', text: 'This desk publishes approved revisions only. A draft can sit in the CMS without ever reaching this page.' }] } },
      { type: 'reference', props: { entryId: articleEntry.entryId } },
      { type: 'columns', props: { columns: [
        [{ type: 'quote', props: { text: 'If the 7:10 is the last boat, the fish stall closes in daylight.', attribution: 'Ned Alvarez, stall 12' } }],
        [{ type: 'cta', props: { heading: 'Where to stand', body: 'The east pier market is the public meeting point.', label: 'Harbor Market', href: '/harbor-market' } }],
      ] } },
    ],
  });
  makeEntry(db, admin, {
    siteId: site.id,
    contentTypeId: page.id,
    localeId: english.id,
    slug: 'about',
    fields: {
      title: 'About the desk',
      summary: 'One editor, one publisher, and a record of what was public.',
      seoTitle: 'About Marlow Civic Desk',
      seoDescription: 'How this small desk publishes.',
    },
    blocks: [{ type: 'richText', props: { nodes: [{ kind: 'p', text: 'Ada drafts. Ben approves a specific revision. Cam can change the schema. Readers only see the published revision.' }] } }],
  });
  makeEntry(db, admin, {
    siteId: site.id,
    contentTypeId: page.id,
    localeId: english.id,
    slug: 'transit-desk',
    fields: {
      title: 'Transit desk',
      summary: 'Ferry, pier, and market links.',
      seoTitle: 'Transit desk',
      seoDescription: 'Ferry and market references from the transit desk.',
    },
    blocks: [{ type: 'reference', props: { entryId: placeEntry.entryId } }],
  });
  makeEntry(db, editor, {
    siteId: site.id,
    contentTypeId: page.id,
    localeId: spanish.id,
    slug: 'home',
    fields: {
      title: 'Mesa cívica de Marlow',
      summary: 'Noticias del puerto para un pueblo que todavía discute en persona.',
      seoTitle: 'Mesa cívica de Marlow',
      seoDescription: 'El voto del jueves y el ferry de la tarde.',
    },
    blocks: [{ type: 'hero', props: { heading: 'La votación del puerto es el jueves', subheading: 'Seis cruces en la tarjeta de prueba.', ctaLabel: 'Leer el ferry', ctaHref: '/ferry-schedule' } }],
  });
  const spanishDraft = createEntry(db, editor, {
    siteId: site.id,
    contentTypeId: article.id,
    localeId: spanish.id,
    slug: 'ferry-schedule',
    fields: { title: 'Borrador que no debe publicarse', summary: 'Este texto no es público.' },
    blocks: [],
  });
  void spanishDraft;
  createRedirect(db, publisher, { siteId: site.id, localeId: english.id, fromPath: '/ferry', toPath: '/ferry-schedule', statusCode: 301 });
  fs.mkdirSync(mediaRoot, { recursive: true });
  db.close();
}

function makeEntry(
  db: Parameters<typeof createEntry>[0],
  actor: User,
  input: Parameters<typeof createEntry>[2],
): { entryId: string; revisionId: string } {
  const created = createEntry(db, actor, input);
  approveRevision(db, actor.role === 'editor' ? mustPublisher(db) : actor, created.revisionId, new Date());
  publishEntryRevision(db, actor.role === 'editor' ? mustPublisher(db) : actor, created.entryId, created.revisionId, new Date());
  return created;
}

function mustPublisher(db: Parameters<typeof createEntry>[0]): User {
  const row = db.prepare('SELECT id, email, name, role FROM users WHERE email = ?').get('ben.publisher@marlow.test') as User;
  return row;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  seed(process.env.DATABASE_PATH ?? './data/cms.sqlite', process.env.MEDIA_ROOT ?? './data/media');
  console.log(JSON.stringify({
    event: 'seeded',
    note: 'Development accounts only. Not for production.',
    accounts: ['ada.editor@marlow.test', 'ben.publisher@marlow.test', 'cam.admin@marlow.test'],
  }));
}
