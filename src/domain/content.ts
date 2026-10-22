import { z } from 'zod';
import { AppError } from './errors.ts';

export const MAX_BLOCKS = 40;
export const MAX_DEPTH = 3;
export const MAX_PAYLOAD_BYTES = 200_000;

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const fieldKey = /^[a-z][a-zA-Z0-9]{0,40}$/;

export const fieldSchema = z.object({
  key: z.string().regex(fieldKey),
  label: z.string().min(1).max(80),
  type: z.enum(['string', 'text', 'number', 'boolean', 'url', 'richtext', 'media', 'reference', 'select']),
  required: z.boolean(),
  maxLength: z.number().int().positive().max(20_000).optional(),
  options: z.array(z.string().min(1).max(80)).max(50).optional(),
  targetType: z.string().regex(slugPattern).optional(),
});

export const contentTypeDocumentSchema = z
  .object({
    version: z.literal(1),
    blocks: z.boolean(),
    fields: z.array(fieldSchema).min(1).max(40),
  })
  .superRefine((doc, ctx) => {
    const seen = new Set<string>();
    for (const field of doc.fields) {
      if (seen.has(field.key)) ctx.addIssue({ code: 'custom', message: `Duplicate field ${field.key}` });
      seen.add(field.key);
      if (field.type === 'select' && (!field.options || field.options.length === 0)) {
        ctx.addIssue({ code: 'custom', message: `Field ${field.key} requires options` });
      }
    }
  });

export type FieldDef = z.infer<typeof fieldSchema>;
export type ContentTypeDocument = z.infer<typeof contentTypeDocumentSchema>;

export type RichNode = { kind: 'p' | 'h2' | 'h3' | 'quote'; text: string };

export type Block =
  | { type: 'hero'; props: { heading: string; subheading: string; ctaLabel: string; ctaHref: string } }
  | { type: 'richText'; props: { nodes: RichNode[] } }
  | { type: 'image'; props: { mediaId: string; alt: string; caption: string } }
  | { type: 'quote'; props: { text: string; attribution: string } }
  | { type: 'cta'; props: { heading: string; body: string; label: string; href: string } }
  | { type: 'reference'; props: { entryId: string } }
  | { type: 'columns'; props: { columns: Block[][] } };

export type RefLookup = {
  entryOnSite: (id: string) => boolean;
  mediaOnSite: (id: string) => boolean;
};

export function parseContentTypeDocument(input: unknown): ContentTypeDocument {
  const parsed = contentTypeDocumentSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError(400, 'invalid_schema', parsed.error.issues.map((issue) => issue.message).join('; '));
  }
  return parsed.data;
}

export function assertCompatibleChange(previous: ContentTypeDocument, next: ContentTypeDocument): void {
  if (previous.blocks && !next.blocks) {
    throw new AppError(409, 'incompatible_schema', 'Cannot disable blocks while entries may contain them');
  }
  const oldFields = new Map(previous.fields.map((field) => [field.key, field]));
  const nextFields = new Map(next.fields.map((field) => [field.key, field]));
  for (const [key, oldField] of oldFields) {
    const updated = nextFields.get(key);
    if (!updated) throw new AppError(409, 'incompatible_schema', `Cannot remove field ${key}`);
    if (updated.type !== oldField.type) {
      throw new AppError(409, 'incompatible_schema', `Cannot change type of field ${key}`);
    }
    if (!oldField.required && updated.required) {
      throw new AppError(409, 'incompatible_schema', `Cannot make field ${key} required`);
    }
    if (oldField.maxLength && updated.maxLength && updated.maxLength < oldField.maxLength) {
      throw new AppError(409, 'incompatible_schema', `Cannot shorten field ${key}`);
    }
    if (oldField.targetType && updated.targetType !== oldField.targetType) {
      throw new AppError(409, 'incompatible_schema', `Cannot retarget field ${key}`);
    }
    if (oldField.type === 'select') {
      for (const option of oldField.options ?? []) {
        if (!(updated.options ?? []).includes(option)) {
          throw new AppError(409, 'incompatible_schema', `Cannot remove option ${option} from ${key}`);
        }
      }
    }
  }
  for (const field of next.fields) {
    if (!oldFields.has(field.key) && field.required) {
      throw new AppError(409, 'incompatible_schema', `New field ${field.key} must be optional`);
    }
  }
}

export function assertSlug(value: string, label = 'Slug'): string {
  if (!slugPattern.test(value) || value.length > 80) {
    throw new AppError(400, 'invalid_slug', `${label} must be lowercase words separated by hyphens`);
  }
  return value;
}

export function isSafeUrl(value: string): boolean {
  if (value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') && !value.includes('://')) {
    return !value.includes('..');
  }
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function cleanString(value: unknown, path: string, max: number, required: boolean): string {
  if (typeof value !== 'string') throw new AppError(400, 'invalid_field', `${path} must be a string`);
  const trimmed = value.trim();
  if (required && trimmed.length === 0) throw new AppError(400, 'invalid_field', `${path} is required`);
  if (trimmed.length > max) throw new AppError(400, 'invalid_field', `${path} exceeds ${max} characters`);
  return trimmed;
}

export function validateRichText(value: unknown, path: string): RichNode[] {
  if (!Array.isArray(value)) throw new AppError(400, 'invalid_field', `${path} must be a list of text nodes`);
  if (value.length > 30) throw new AppError(400, 'invalid_field', `${path} has too many paragraphs`);
  return value.map((node, index) => {
    if (!node || typeof node !== 'object') throw new AppError(400, 'invalid_field', `${path}[${index}] is invalid`);
    const kind = (node as { kind?: unknown }).kind;
    if (kind !== 'p' && kind !== 'h2' && kind !== 'h3' && kind !== 'quote') {
      throw new AppError(400, 'invalid_field', `${path}[${index}] has an unsupported text kind`);
    }
    return { kind, text: cleanString((node as { text?: unknown }).text, `${path}[${index}].text`, 4000, false) };
  });
}

export function compilePlainText(source: string): RichNode[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const nodes: RichNode[] = [];
  const buffer: string[] = [];
  const flush = () => {
    const text = buffer.join('\n').trim();
    buffer.length = 0;
    if (!text) return;
    let kind: RichNode['kind'] = 'p';
    let body = text;
    if (text.startsWith('### ')) {
      kind = 'h3';
      body = text.slice(4).trim();
    } else if (text.startsWith('## ')) {
      kind = 'h2';
      body = text.slice(3).trim();
    } else if (text.startsWith('> ')) {
      kind = 'quote';
      body = text.slice(2).trim();
    }
    nodes.push({ kind, text: body });
  };
  for (const line of lines) {
    if (line.trim() === '') flush();
    else buffer.push(line);
  }
  flush();
  return validateRichText(nodes, 'richtext');
}

export function validateFields(
  doc: ContentTypeDocument,
  input: unknown,
  refs: RefLookup,
): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError(400, 'invalid_field', 'Fields must be an object');
  }
  const source = input as Record<string, unknown>;
  const allowed = new Set(doc.fields.map((field) => field.key));
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) throw new AppError(400, 'invalid_field', `Unknown field ${key}`);
  }
  const out: Record<string, unknown> = Object.create(null);
  for (const field of doc.fields) {
    const raw = source[field.key];
    const missing = raw === undefined || raw === null || raw === '';
    if (missing) {
      if (field.required) throw new AppError(400, 'invalid_field', `${field.key} is required`);
      continue;
    }
    out[field.key] = validateFieldValue(field, raw, refs);
  }
  return out;
}

function validateFieldValue(field: FieldDef, raw: unknown, refs: RefLookup): unknown {
  const max = field.maxLength ?? (field.type === 'text' || field.type === 'richtext' ? 8000 : 500);
  switch (field.type) {
    case 'string':
    case 'text':
      return cleanString(raw, field.key, max, field.required);
    case 'number': {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        throw new AppError(400, 'invalid_field', `${field.key} must be a finite number`);
      }
      return raw;
    }
    case 'boolean': {
      if (typeof raw !== 'boolean') throw new AppError(400, 'invalid_field', `${field.key} must be true or false`);
      return raw;
    }
    case 'url': {
      const url = cleanString(raw, field.key, 2000, true);
      if (!isSafeUrl(url)) throw new AppError(400, 'invalid_field', `${field.key} must be an http(s) or site path`);
      return url;
    }
    case 'richtext':
      return validateRichText(raw, field.key);
    case 'select': {
      const value = cleanString(raw, field.key, 80, true);
      if (!(field.options ?? []).includes(value)) {
        throw new AppError(400, 'invalid_field', `${field.key} is not an allowed option`);
      }
      return value;
    }
    case 'media': {
      const id = cleanString(raw, field.key, 80, true);
      if (!refs.mediaOnSite(id)) throw new AppError(400, 'invalid_reference', `${field.key} media is not on this site`);
      return id;
    }
    case 'reference': {
      const id = cleanString(raw, field.key, 80, true);
      if (!refs.entryOnSite(id)) throw new AppError(400, 'invalid_reference', `${field.key} entry is missing or on another site`);
      return id;
    }
    default:
      throw new AppError(400, 'invalid_field', `Unsupported field type`);
  }
}

export function validateBlocks(input: unknown, refs: RefLookup, blocksEnabled: boolean): Block[] {
  const encoded = JSON.stringify(input ?? null);
  if (Buffer.byteLength(encoded) > MAX_PAYLOAD_BYTES) {
    throw new AppError(413, 'payload_too_large', 'Block payload exceeds the size limit');
  }
  if (!Array.isArray(input)) throw new AppError(400, 'invalid_blocks', 'Blocks must be an array');
  if (!blocksEnabled && input.length > 0) {
    throw new AppError(400, 'invalid_blocks', 'This content type does not allow blocks');
  }
  const acc = { count: 0 };
  return input.map((block, index) => validateBlock(block, 1, acc, refs, `blocks[${index}]`));
}

function validateBlock(input: unknown, depth: number, acc: { count: number }, refs: RefLookup, path: string): Block {
  if (depth > MAX_DEPTH) throw new AppError(400, 'invalid_blocks', `${path} exceeds nesting depth ${MAX_DEPTH}`);
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError(400, 'invalid_blocks', `${path} is not a block`);
  }
  acc.count += 1;
  if (acc.count > MAX_BLOCKS) throw new AppError(400, 'invalid_blocks', `A page can contain at most ${MAX_BLOCKS} blocks`);
  const type = (input as { type?: unknown }).type;
  const props = (input as { props?: unknown }).props;
  if (typeof type !== 'string' || !props || typeof props !== 'object' || Array.isArray(props)) {
    throw new AppError(400, 'invalid_blocks', `${path} is missing a type or props`);
  }
  const bag = props as Record<string, unknown>;
  switch (type) {
    case 'hero': {
      const ctaLabel = cleanString(bag.ctaLabel ?? '', `${path}.ctaLabel`, 80, false);
      const ctaHref = cleanString(bag.ctaHref ?? '', `${path}.ctaHref`, 2000, false);
      if ((ctaLabel && !ctaHref) || (ctaHref && !ctaLabel)) {
        throw new AppError(400, 'invalid_blocks', `${path} needs both a label and a link, or neither`);
      }
      if (ctaHref && !isSafeUrl(ctaHref)) throw new AppError(400, 'invalid_blocks', `${path}.ctaHref is not an allowed URL`);
      return {
        type,
        props: {
          heading: cleanString(bag.heading, `${path}.heading`, 140, true),
          subheading: cleanString(bag.subheading ?? '', `${path}.subheading`, 300, false),
          ctaLabel,
          ctaHref,
        },
      };
    }
    case 'richText':
      return { type, props: { nodes: validateRichText(bag.nodes, `${path}.nodes`) } };
    case 'image': {
      const mediaId = cleanString(bag.mediaId, `${path}.mediaId`, 80, true);
      if (!refs.mediaOnSite(mediaId)) throw new AppError(400, 'invalid_reference', `${path} media is not on this site`);
      return {
        type,
        props: {
          mediaId,
          alt: cleanString(bag.alt, `${path}.alt`, 300, true),
          caption: cleanString(bag.caption ?? '', `${path}.caption`, 300, false),
        },
      };
    }
    case 'quote':
      return {
        type,
        props: {
          text: cleanString(bag.text, `${path}.text`, 1000, true),
          attribution: cleanString(bag.attribution ?? '', `${path}.attribution`, 160, false),
        },
      };
    case 'cta': {
      const href = cleanString(bag.href, `${path}.href`, 2000, true);
      if (!isSafeUrl(href)) throw new AppError(400, 'invalid_blocks', `${path}.href is not an allowed URL`);
      return {
        type,
        props: {
          heading: cleanString(bag.heading, `${path}.heading`, 140, true),
          body: cleanString(bag.body ?? '', `${path}.body`, 500, false),
          label: cleanString(bag.label, `${path}.label`, 80, true),
          href,
        },
      };
    }
    case 'reference': {
      const entryId = cleanString(bag.entryId, `${path}.entryId`, 80, true);
      if (!refs.entryOnSite(entryId)) {
        throw new AppError(400, 'invalid_reference', `${path} target is missing or on another site`);
      }
      return { type, props: { entryId } };
    }
    case 'columns': {
      if (depth >= MAX_DEPTH) throw new AppError(400, 'invalid_blocks', `${path} cannot nest another columns block here`);
      if (!Array.isArray(bag.columns) || bag.columns.length < 2 || bag.columns.length > 3) {
        throw new AppError(400, 'invalid_blocks', `${path} must contain two or three columns`);
      }
      const columns = bag.columns.map((column, columnIndex) => {
        if (!Array.isArray(column)) throw new AppError(400, 'invalid_blocks', `${path}.columns[${columnIndex}] is invalid`);
        return column.map((child, childIndex) =>
          validateBlock(child, depth + 1, acc, refs, `${path}.columns[${columnIndex}][${childIndex}]`),
        );
      });
      return { type, props: { columns } };
    }
    default:
      throw new AppError(400, 'unknown_block', `${path} uses unsupported block ${type}`);
  }
}

export function collectReferenceIds(fields: Record<string, unknown>, blocks: Block[]): { entries: string[]; media: string[] } {
  const entries = new Set<string>();
  const media = new Set<string>();
  for (const value of Object.values(fields)) {
    if (typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value)) {
      // Field ids are classified by the caller. This helper only walks blocks.
    }
  }
  const walk = (list: Block[]) => {
    for (const block of list) {
      if (block.type === 'reference') entries.add(block.props.entryId);
      if (block.type === 'image') media.add(block.props.mediaId);
      if (block.type === 'columns') block.props.columns.forEach(walk);
    }
  };
  walk(blocks);
  return { entries: [...entries], media: [...media] };
}
