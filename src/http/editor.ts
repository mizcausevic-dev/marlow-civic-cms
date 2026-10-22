import { randomBytes } from 'node:crypto';
import { compilePlainText, type Block, type RichNode } from '../domain/content.ts';
import { AppError } from '../domain/errors.ts';

export type Draft = {
  id: string;
  type: string;
  props: Record<string, string>;
  columns?: Draft[][];
};

const TYPES = new Set(['hero', 'richText', 'image', 'quote', 'cta', 'reference', 'columns']);

function nid(): string {
  return randomBytes(4).toString('hex');
}

function sourceFromNodes(nodes: RichNode[]): string {
  return nodes
    .map((node) => {
      if (node.kind === 'h2') return `## ${node.text}`;
      if (node.kind === 'h3') return `### ${node.text}`;
      if (node.kind === 'quote') return `> ${node.text}`;
      return node.text;
    })
    .join('\n\n');
}

function fromBlock(block: Block): Draft {
  if (block.type === 'columns') {
    return { id: nid(), type: 'columns', props: {}, columns: block.props.columns.map((column) => column.map(fromBlock)) };
  }
  if (block.type === 'richText') {
    return { id: nid(), type: 'richText', props: { source: sourceFromNodes(block.props.nodes) } };
  }
  const props: Record<string, string> = {};
  for (const [key, value] of Object.entries(block.props)) props[key] = String(value ?? '');
  return { id: nid(), type: block.type, props };
}

export function draftsFromBlocks(blocks: Block[]): Draft[] {
  return blocks.map(fromBlock);
}

export function emptyDraft(type: string): Draft {
  if (!TYPES.has(type)) throw new AppError(400, 'unknown_block', 'Unsupported block');
  if (type === 'columns') {
    return {
      id: nid(),
      type,
      props: {},
      columns: [
        [emptyDraft('richText')],
        [emptyDraft('richText')],
      ],
    };
  }
  return { id: nid(), type, props: {} };
}

function shapeOf(drafts: Draft[]): unknown[] {
  return drafts.map((draft) => ({
    id: draft.id,
    type: draft.type,
    columns: draft.columns?.map((column) => shapeOf(column)),
  }));
}

export function shapeJson(drafts: Draft[]): string {
  return JSON.stringify(shapeOf(drafts));
}

function readProps(form: Record<string, string>, id: string): Record<string, string> {
  const prefix = `p_${id}_`;
  const props: Record<string, string> = {};
  for (const [key, value] of Object.entries(form)) {
    if (key.startsWith(prefix)) props[key.slice(prefix.length)] = value;
  }
  return props;
}

function hydrate(node: { id?: unknown; type?: unknown; columns?: unknown }, form: Record<string, string>): Draft {
  if (typeof node.id !== 'string' || !/^[a-f0-9]{8}$/.test(node.id) || typeof node.type !== 'string' || !TYPES.has(node.type)) {
    throw new AppError(400, 'invalid_blocks', 'The block list was not understood. Reload the editor.');
  }
  const draft: Draft = { id: node.id, type: node.type, props: readProps(form, node.id) };
  if (node.type === 'columns') {
    if (!Array.isArray(node.columns)) throw new AppError(400, 'invalid_blocks', 'Columns block is malformed');
    draft.columns = node.columns.map((column) => {
      if (!Array.isArray(column)) throw new AppError(400, 'invalid_blocks', 'Columns block is malformed');
      return column.map((child) => hydrate(child as { id?: unknown; type?: unknown; columns?: unknown }, form));
    });
  }
  return draft;
}

export function readDrafts(form: Record<string, string>): Draft[] {
  const raw = form.shape || '[]';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AppError(400, 'invalid_blocks', 'The block list was not understood. Reload the editor.');
  }
  if (!Array.isArray(parsed)) throw new AppError(400, 'invalid_blocks', 'The block list was not understood. Reload the editor.');
  return parsed.map((node) => hydrate(node as { id?: unknown; type?: unknown }, form));
}

function findParent(drafts: Draft[], id: string): { list: Draft[]; index: number } | null {
  const index = drafts.findIndex((draft) => draft.id === id);
  if (index >= 0) return { list: drafts, index };
  for (const draft of drafts) {
    if (!draft.columns) continue;
    for (const column of draft.columns) {
      const found = findParent(column, id);
      if (found) return found;
    }
  }
  return null;
}

export function applyIntent(drafts: Draft[], intent: string): Draft[] {
  const next = structuredClone(drafts);
  if (intent.startsWith('add:')) {
    next.push(emptyDraft(intent.slice(4)));
    return next;
  }
  const nested = intent.match(/^addnested:([a-f0-9]{8}):(\d+):([a-zA-Z]+)$/);
  if (nested) {
    const parent = findParent(next, nested[1] ?? '');
    const draft = parent?.list[parent.index];
    const colIndex = Number(nested[2]);
    if (!draft?.columns || !draft.columns[colIndex] || nested[3] === 'columns') {
      throw new AppError(400, 'invalid_blocks', 'Cannot add that nested block');
    }
    draft.columns[colIndex].push(emptyDraft(nested[3] ?? 'richText'));
    return next;
  }
  const move = intent.match(/^move:([a-f0-9]{8}):(up|down)$/);
  if (move) {
    const parent = findParent(next, move[1] ?? '');
    if (!parent) return next;
    const target = move[2] === 'up' ? parent.index - 1 : parent.index + 1;
    if (target < 0 || target >= parent.list.length) return next;
    const [item] = parent.list.splice(parent.index, 1);
    if (item) parent.list.splice(target, 0, item);
    return next;
  }
  const remove = intent.match(/^remove:([a-f0-9]{8})$/);
  if (remove) {
    const parent = findParent(next, remove[1] ?? '');
    if (parent) parent.list.splice(parent.index, 1);
    return next;
  }
  throw new AppError(400, 'invalid_action', 'Unknown editor action');
}

export function draftsToBlocks(drafts: Draft[]): unknown[] {
  return drafts.map(toUnknown);
}

function toUnknown(draft: Draft): unknown {
  if (draft.type === 'columns') {
    return { type: 'columns', props: { columns: (draft.columns ?? []).map((column) => column.map(toUnknown)) } };
  }
  if (draft.type === 'richText') {
    return { type: 'richText', props: { nodes: compilePlainText(draft.props.source ?? '') } };
  }
  return { type: draft.type, props: { ...draft.props } };
}
