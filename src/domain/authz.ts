import type { DB } from '../db/db.ts';
import { get } from '../db/db.ts';
import { AppError } from './errors.ts';

export type Role = 'editor' | 'publisher' | 'administrator';

export type User = {
  id: string;
  email: string;
  name: string;
  role: Role;
};

const editor = ['entry.read', 'entry.write', 'preview', 'media.write', 'type.read', 'redirect.read'] as const;
const publisher = [...editor, 'redirect.write', 'approve', 'publish', 'schedule', 'archive', 'rollback'] as const;
const administrator = [...publisher, 'type.write', 'site.write', 'webhook.write', 'member.write'] as const;

export type Permission =
  | (typeof editor)[number]
  | (typeof publisher)[number]
  | (typeof administrator)[number];

const grants: Record<Role, readonly Permission[]> = { editor, publisher, administrator };

export function can(role: Role, permission: Permission): boolean {
  return grants[role].includes(permission);
}

export function requirePermission(user: User, permission: Permission): void {
  if (!can(user.role, permission)) {
    throw new AppError(403, 'forbidden', `Role ${user.role} cannot ${permission}`);
  }
}

export function canAccessSite(db: DB, user: User, siteId: string): boolean {
  if (user.role === 'administrator') return true;
  return Boolean(get(db, 'SELECT 1 AS ok FROM user_sites WHERE user_id = ? AND site_id = ?', user.id, siteId));
}

export function requireSite(db: DB, user: User, siteId: string): void {
  if (!canAccessSite(db, user, siteId)) {
    throw new AppError(403, 'forbidden', 'No access to this site');
  }
}
