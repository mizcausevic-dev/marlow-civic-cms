import type { Block, RichNode } from '../domain/content.ts';
import { isSafeUrl } from '../domain/content.ts';
import type { PublicReference } from '../contract/public.ts';

export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function href(value: string): string {
  return isSafeUrl(value) ? esc(value) : '#';
}

function rich(nodes: RichNode[]): string {
  return nodes
    .map((node) => {
      const text = esc(node.text);
      if (node.kind === 'h2') return `<h2>${text}</h2>`;
      if (node.kind === 'h3') return `<h3>${text}</h3>`;
      if (node.kind === 'quote') return `<blockquote><p>${text}</p></blockquote>`;
      return `<p>${text}</p>`;
    })
    .join('');
}

export function renderBlocks(
  blocks: Block[],
  options: {
    mediaSrc: (mediaId: string) => string;
    entryHref: (slug: string) => string;
    references: Record<string, PublicReference>;
  },
): string {
  return blocks.map((block) => renderBlock(block, options)).join('');
}

function renderBlock(
  block: Block,
  options: {
    mediaSrc: (mediaId: string) => string;
    entryHref: (slug: string) => string;
    references: Record<string, PublicReference>;
  },
): string {
  switch (block.type) {
    case 'hero': {
      const cta =
        block.props.ctaLabel && block.props.ctaHref
          ? `<a class="button" href="${href(block.props.ctaHref)}">${esc(block.props.ctaLabel)}</a>`
          : '';
      return `<section class="block hero"><p class="kicker">Marlow Civic Desk</p><h1>${esc(block.props.heading)}</h1><p class="dek">${esc(block.props.subheading)}</p>${cta}</section>`;
    }
    case 'richText':
      return `<section class="block prose">${rich(block.props.nodes)}</section>`;
    case 'image':
      return `<figure class="block"><img src="${esc(options.mediaSrc(block.props.mediaId))}" alt="${esc(block.props.alt)}" /><figcaption>${esc(block.props.caption)}</figcaption></figure>`;
    case 'quote':
      return `<blockquote class="block pull"><p>${esc(block.props.text)}</p><footer>${esc(block.props.attribution)}</footer></blockquote>`;
    case 'cta':
      return `<section class="block cta"><h2>${esc(block.props.heading)}</h2><p>${esc(block.props.body)}</p><a class="button" href="${href(block.props.href)}">${esc(block.props.label)}</a></section>`;
    case 'reference': {
      const ref = options.references[`block:${block.props.entryId}`] ?? options.references[block.props.entryId];
      if (!ref || ref.status !== 'published') {
        return `<aside class="block missing">Linked entry is not public.</aside>`;
      }
      return `<aside class="block related"><a href="${esc(options.entryHref(ref.slug))}">${esc(ref.title)}</a><p>${esc(ref.contentType)} · ${esc(ref.locale)}</p></aside>`;
    }
    case 'columns':
      return `<section class="block columns">${block.props.columns
        .map((column) => `<div>${column.map((child) => renderBlock(child, options)).join('')}</div>`)
        .join('')}</section>`;
    default:
      return '';
  }
}
