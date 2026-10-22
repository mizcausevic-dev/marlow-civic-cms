import type { User } from '../domain/authz.ts';
import type { ContentTypeDocument } from '../domain/content.ts';
import { esc } from '../render/blocks.ts';
import { shapeJson, type Draft } from './editor.ts';

export function layout(input: { title: string; user: User | null; csrf: string; siteSlug?: string; body: string }): string {
  const nav = input.user
    ? `<nav>
        <strong>Marlow Civic Desk</strong>
        <span>${esc(input.user.name)} · ${esc(input.user.role)}</span>
        <a href="/admin">Entries</a>
        <a href="/admin/types">Content types</a>
        <a href="/admin/media">Media</a>
        <a href="/admin/redirects">Redirects</a>
        <a href="/admin/jobs">Schedule</a>
        ${input.user.role === 'administrator' ? '<a href="/admin/webhooks">Webhooks</a><a href="/admin/sites">Sites</a>' : ''}
        <form method="post" action="/admin/logout"><input type="hidden" name="_csrf" value="${esc(input.csrf)}" /><button class="ghost" type="submit">Sign out</button></form>
      </nav>`
    : '<nav><strong>Marlow Civic Desk</strong><span>Local editorial CMS</span></nav>';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="csrf-token" content="${esc(input.csrf)}" />
  <meta name="referrer" content="no-referrer" />
  <title>${esc(input.title)}</title>
  <link rel="stylesheet" href="/assets/admin.css" />
</head>
<body>
  <a class="skip" href="#main">Skip to content</a>
  <div class="shell">${nav}<main id="main">${input.body}</main></div>
</body>
</html>`;
}

export function loginPage(csrf: string, error?: string): string {
  return layout({
    title: 'Sign in',
    user: null,
    csrf,
    body: `<h1>Sign in</h1>
      <p class="muted">Development accounts are local only. They are not production credentials.</p>
      ${error ? `<div class="panel errors"><p>${esc(error)}</p></div>` : ''}
      <form class="panel stack" method="post" action="/admin/login">
        <input type="hidden" name="_csrf" value="${esc(csrf)}" />
        <label for="email">Email</label>
        <input id="email" name="email" type="email" autocomplete="username" required />
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required />
        <button type="submit">Sign in</button>
      </form>`,
  });
}

function fieldControl(field: ContentTypeDocument['fields'][number], value: string, choices: { media: { id: string; alt: string }[]; entries: { id: string; slug: string; locale_code: string }[] }): string {
  const id = `field_${field.key}`;
  if (field.type === 'text' || field.type === 'richtext') {
    return `<label for="${id}">${esc(field.label)}</label><textarea id="${id}" name="${id}">${esc(value)}</textarea>`;
  }
  if (field.type === 'boolean') {
    return `<label for="${id}">${esc(field.label)}</label><select id="${id}" name="${id}"><option value="">Unset</option><option value="true" ${value === 'true' ? 'selected' : ''}>True</option><option value="false" ${value === 'false' ? 'selected' : ''}>False</option></select>`;
  }
  if (field.type === 'media') {
    const options = choices.media.map((item) => `<option value="${esc(item.id)}" ${item.id === value ? 'selected' : ''}>${esc(item.alt)}</option>`).join('');
    return `<label for="${id}">${esc(field.label)}</label><select id="${id}" name="${id}"><option value="">None</option>${options}</select>`;
  }
  if (field.type === 'reference') {
    const options = choices.entries.map((item) => `<option value="${esc(item.id)}" ${item.id === value ? 'selected' : ''}>${esc(item.slug)} (${esc(item.locale_code)})</option>`).join('');
    return `<label for="${id}">${esc(field.label)}</label><select id="${id}" name="${id}"><option value="">None</option>${options}</select>`;
  }
  if (field.type === 'select') {
    const options = (field.options ?? []).map((option) => `<option value="${esc(option)}" ${option === value ? 'selected' : ''}>${esc(option)}</option>`).join('');
    return `<label for="${id}">${esc(field.label)}</label><select id="${id}" name="${id}"><option value="">Choose</option>${options}</select>`;
  }
  const type = field.type === 'number' ? 'number' : field.type === 'url' ? 'url' : 'text';
  return `<label for="${id}">${esc(field.label)}</label><input id="${id}" name="${id}" type="${type}" value="${esc(value)}" />`;
}

function blockFields(draft: Draft, choices: { media: { id: string; alt: string }[]; entries: { id: string; slug: string; locale_code: string }[] }): string {
  const prop = (key: string, label: string, multiline = false) => {
    const name = `p_${draft.id}_${key}`;
    const value = draft.props[key] ?? '';
    if (key === 'mediaId') {
      const options = choices.media.map((item) => `<option value="${esc(item.id)}" ${item.id === value ? 'selected' : ''}>${esc(item.alt)}</option>`).join('');
      return `<label for="${name}">Image</label><select id="${name}" name="${name}"><option value="">Choose</option>${options}</select>`;
    }
    if (key === 'entryId') {
      const options = choices.entries.map((item) => `<option value="${esc(item.id)}" ${item.id === value ? 'selected' : ''}>${esc(item.slug)} (${esc(item.locale_code)})</option>`).join('');
      return `<label for="${name}">Entry</label><select id="${name}" name="${name}"><option value="">Choose</option>${options}</select>`;
    }
    if (multiline || key === 'source' || key === 'body' || key === 'text') {
      return `<label for="${name}">${esc(label)}</label><textarea id="${name}" name="${name}">${esc(value)}</textarea>`;
    }
    return `<label for="${name}">${esc(label)}</label><input id="${name}" name="${name}" value="${esc(value)}" />`;
  };
  switch (draft.type) {
    case 'hero':
      return prop('heading', 'Heading') + prop('subheading', 'Subheading', true) + prop('ctaLabel', 'Button label') + prop('ctaHref', 'Button link');
    case 'richText':
      return `${prop('source', 'Text', true)}<p class="muted">Blank line starts a new paragraph. Start a line with ##, ###, or &gt; for a heading or quote.</p>`;
    case 'image':
      return prop('mediaId', 'Image') + prop('alt', 'Alt text') + prop('caption', 'Caption');
    case 'quote':
      return prop('text', 'Quote', true) + prop('attribution', 'Attribution');
    case 'cta':
      return prop('heading', 'Heading') + prop('body', 'Body', true) + prop('label', 'Button label') + prop('href', 'Button link');
    case 'reference':
      return prop('entryId', 'Entry');
    default:
      return '';
  }
}

function renderDraft(draft: Draft, choices: { media: { id: string; alt: string }[]; entries: { id: string; slug: string; locale_code: string }[] }, depth: number): string {
  const nested = (draft.columns ?? [])
    .map((column, index) => {
      const inner = column.map((child) => renderDraft(child, choices, depth + 1)).join('');
      const adder = ['richText', 'quote', 'image', 'cta', 'reference']
        .map((type) => `<button class="ghost" name="intent" value="addnested:${draft.id}:${index}:${type}" type="submit">Add ${type}</button>`)
        .join('');
      return `<div class="panel"><h3>Column ${index + 1}</h3>${inner || '<p class="muted">Empty column.</p>'}<div class="row">${adder}</div></div>`;
    })
    .join('');
  return `<fieldset class="panel">
    <legend class="status">${esc(draft.type)}</legend>
    ${blockFields(draft, choices)}
    ${nested}
    <div class="row">
      <button class="ghost" type="submit" name="intent" value="move:${draft.id}:up">Move up</button>
      <button class="ghost" type="submit" name="intent" value="move:${draft.id}:down">Move down</button>
      <button class="danger" type="submit" name="intent" value="remove:${draft.id}">Remove</button>
    </div>
  </fieldset>`;
}

export function editorPage(input: {
  user: User;
  csrf: string;
  entryId: string;
  slug: string;
  locale: string;
  status: string;
  typeName: string;
  document: ContentTypeDocument;
  fieldValues: Record<string, string>;
  drafts: Draft[];
  revisions: { id: string; revision_number: number; created_at: string; approved: boolean; published: boolean }[];
  errors: string[];
  media: { id: string; alt: string }[];
  entries: { id: string; slug: string; locale_code: string }[];
}): string {
  const choices = { media: input.media, entries: input.entries };
  const fields = input.document.fields.map((field) => fieldControl(field, input.fieldValues[field.key] ?? '', choices)).join('');
  const blocks = input.document.blocks ? input.drafts.map((draft) => renderDraft(draft, choices, 1)).join('') : '<p>This type has no blocks.</p>';
  const adders = ['hero', 'richText', 'image', 'quote', 'cta', 'reference', 'columns']
    .map((type) => `<button class="ghost" type="submit" name="intent" value="add:${type}">Add ${type}</button>`)
    .join('');
  const history = input.revisions
    .map((revision) => `<li>Revision ${revision.revision_number}
      <span class="status ${revision.approved ? 'ok' : 'warn'}">${revision.approved ? 'approved' : 'unapproved'}</span>
      ${revision.published ? '<span class="status ok">public</span>' : ''}
      <a href="/admin/entries/${esc(input.entryId)}/publish?revision=${esc(revision.id)}">Publish</a>
      <a href="/admin/entries/${esc(input.entryId)}/schedule?revision=${esc(revision.id)}">Schedule</a>
      <a href="/admin/entries/${esc(input.entryId)}/rollback?revision=${esc(revision.id)}">Rollback</a>
      <form class="inline" method="post" action="/admin/revisions/${esc(revision.id)}/approve"><input type="hidden" name="_csrf" value="${esc(input.csrf)}" /><button class="ghost" type="submit">Approve</button></form>
      <form class="inline" method="post" action="/admin/entries/${esc(input.entryId)}/preview"><input type="hidden" name="_csrf" value="${esc(input.csrf)}" /><input type="hidden" name="revisionId" value="${esc(revision.id)}" /><button class="ghost" type="submit">Preview</button></form>
    </li>`)
    .join('');
  return layout({
    title: input.slug,
    user: input.user,
    csrf: input.csrf,
    body: `<p class="status ${input.status === 'published' ? 'ok' : input.status === 'archived' ? 'bad' : 'warn'}">${esc(input.status)}</p>
      <h1>${esc(input.slug)}</h1>
      <p class="muted">${esc(input.typeName)} · ${esc(input.locale)}</p>
      ${input.errors.length ? `<div class="panel errors" role="alert">${input.errors.map((error) => `<p>${esc(error)}</p>`).join('')}</div>` : ''}
      <form method="post" action="/admin/entries/${esc(input.entryId)}/edit">
        <input type="hidden" name="_csrf" value="${esc(input.csrf)}" />
        <input type="hidden" name="shape" value="${esc(shapeJson(input.drafts))}" />
        <section class="panel"><h2>Fields</h2>${fields}</section>
        <section><h2>Blocks</h2>${blocks}<div class="row">${adders}<button type="submit" name="intent" value="save">Save revision</button></div></section>
      </form>
      <section class="panel"><h2>Revisions</h2><ul>${history || '<li>No revisions yet.</li>'}</ul>
        <p><a href="/admin/entries/${esc(input.entryId)}/compare">Compare revisions</a>
        · <a href="/admin/entries/${esc(input.entryId)}/archive">Archive</a></p>
      </section>`,
  });
}

export function confirmPage(input: { user: User; csrf: string; title: string; action: string; hidden: Record<string, string>; message: string }): string {
  const hidden = Object.entries(input.hidden)
    .map(([key, value]) => `<input type="hidden" name="${esc(key)}" value="${esc(value)}" />`)
    .join('');
  return layout({
    title: input.title,
    user: input.user,
    csrf: input.csrf,
    body: `<h1>${esc(input.title)}</h1>
      <form class="panel stack" method="post" action="${esc(input.action)}">
        <input type="hidden" name="_csrf" value="${esc(input.csrf)}" />
        ${hidden}
        <p>${esc(input.message)}</p>
        <label><input type="checkbox" name="confirm" value="yes" /> I understand this changes what readers can see.</label>
        <button type="submit">Confirm</button>
      </form>`,
  });
}
