import type { Block } from './content.ts';

export type FieldDiff = {
  key: string;
  change: 'added' | 'removed' | 'changed' | 'same';
  before: unknown;
  after: unknown;
};

export function diffFields(before: Record<string, unknown>, after: Record<string, unknown>): FieldDiff[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.map((key) => {
    const left = before[key];
    const right = after[key];
    const same = JSON.stringify(left) === JSON.stringify(right);
    if (same) return { key, change: 'same' as const, before: left, after: right };
    if (left === undefined) return { key, change: 'added' as const, before: left, after: right };
    if (right === undefined) return { key, change: 'removed' as const, before: left, after: right };
    return { key, change: 'changed' as const, before: left, after: right };
  });
}

export type BlockDiff = {
  index: number;
  change: 'added' | 'removed' | 'changed' | 'same';
  beforeType?: string;
  afterType?: string;
};

export function diffBlocks(before: Block[], after: Block[]): BlockDiff[] {
  const length = Math.max(before.length, after.length);
  const diffs: BlockDiff[] = [];
  for (let index = 0; index < length; index += 1) {
    const left = before[index];
    const right = after[index];
    if (!left && right) diffs.push({ index, change: 'added', afterType: right.type });
    else if (left && !right) diffs.push({ index, change: 'removed', beforeType: left.type });
    else if (left && right) {
      const same = JSON.stringify(left) === JSON.stringify(right);
      diffs.push({
        index,
        change: same ? 'same' : 'changed',
        beforeType: left.type,
        afterType: right.type,
      });
    }
  }
  return diffs;
}
