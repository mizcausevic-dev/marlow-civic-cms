import type { Block } from '../domain/content.ts';

export type PublicReference =
  | { status: 'unavailable' }
  | {
      status: 'published';
      id: string;
      slug: string;
      locale: string;
      contentType: string;
      title: string;
    };

export type PublicEntry = {
  id: string;
  site: string;
  localeRequested: string;
  localeServed: string;
  fallback: boolean;
  slug: string;
  contentType: string;
  revisionId: string;
  publishedAt: string;
  fields: Record<string, unknown>;
  blocks: Block[];
  meta: { title: string; description: string };
  references: Record<string, PublicReference>;
};

export type PublicSummary = {
  id: string;
  slug: string;
  contentType: string;
  locale: string;
  title: string;
  publishedAt: string;
};
