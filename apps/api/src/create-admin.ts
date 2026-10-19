import { makePool } from './db';
import { hashPassword } from './auth';
const [email, role] = process.argv.slice(2); const pw = process.env.ADMIN_PASSWORD ?? '';
if (!email || !['admin', 'reviewer'].includes(role) || pw.length < 12) {
  console.error('usage: ADMIN_PASSWORD=<12+ chars> npm run admin:create -w @crimelens/api -- <email> <admin|reviewer>'); process.exit(1);
}
const pool = makePool();
await pool.query(`INSERT INTO admin_users (email, password_hash, role) VALUES ($1,$2,$3) ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role`, [email.toLowerCase(), hashPassword(pw), role]);
console.log(`saved ${role} ${email.toLowerCase()}`); await pool.end();
