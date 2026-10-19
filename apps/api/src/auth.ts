import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import type pg from 'pg';

export type Role = 'admin' | 'reviewer';
export type Actor = { id: string; role: Role };
export const MIN_SECRET = 32;

export const hashPassword = (pw: string) => { const salt = randomBytes(16); return `scrypt$${salt.toString('hex')}$${scryptSync(pw, salt, 64).toString('hex')}`; };
export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, saltHex, hashHex] = stored.split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const want = Buffer.from(hashHex, 'hex');
  return timingSafeEqual(scryptSync(pw, Buffer.from(saltHex, 'hex'), want.length), want);
}
export const DUMMY_HASH = hashPassword('timing-equalizer-not-a-real-password');

export const signToken = (secret: string, u: Actor) => jwt.sign({}, secret, { subject: u.id, expiresIn: '8h', algorithm: 'HS256', issuer: 'crimelens' });

/** Verifies the bearer token, then re-reads the user's CURRENT role from the database, so demotion or deletion takes effect immediately. */
export function requireRole(pool: pg.Pool, secret: string | undefined, roles: Role[]): RequestHandler {
  return async (req, res, next) => {
    if (!secret || secret.length < MIN_SECRET) return void res.status(503).json({ error: 'admin_not_configured' });
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) return void res.status(401).json({ error: 'unauthorized' });
    try {
      const p = jwt.verify(h.slice(7), secret, { algorithms: ['HS256'], issuer: 'crimelens' }) as jwt.JwtPayload;
      const row = (await pool.query('SELECT id, role FROM admin_users WHERE id = $1 AND disabled_at IS NULL', [p.sub])).rows[0];
      if (!row) return void res.status(401).json({ error: 'unauthorized' });
      if (!roles.includes(row.role)) return void res.status(403).json({ error: 'forbidden' });
      (req as any).actor = { id: row.id, role: row.role } satisfies Actor;
      next();
    } catch { res.status(401).json({ error: 'unauthorized' }); }
  };
}
