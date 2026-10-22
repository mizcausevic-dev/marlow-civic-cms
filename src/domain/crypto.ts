import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

function scryptN(): number {
  const n = Number(process.env.SCRYPT_N ?? 16384);
  if (!Number.isInteger(n) || n < 1024 || n > 1_048_576) {
    throw new Error('SCRYPT_N must be a power-of-two integer between 1024 and 1048576');
  }
  return n;
}

export function hashPassword(password: string): string {
  const n = scryptN();
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N: n, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  return `scrypt$${n}$8$1$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const saltHex = parts[4];
  const hashHex = parts[5];
  if (!saltHex || !hashHex || !Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  if (salt.length < 16 || expected.length < 16) return false;
  const actual = scryptSync(password, salt, expected.length, { N: n, r, p, maxmem: 128 * 1024 * 1024 });
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function signPayload(secret: string, timestamp: string, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
