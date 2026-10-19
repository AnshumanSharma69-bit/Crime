import { makePool } from './db';
import { assertSafeToSeed, removeDevFixtures, seedDevFixtures } from './dev-seed';
const flags = process.argv.slice(2); const pool = makePool();
try {
  if (flags.includes('--remove')) console.log('removed fixture sources:', await removeDevFixtures(pool));
  else if (flags.includes('--yes-fake-data')) { assertSafeToSeed(process.env.DATABASE_URL, process.env.NODE_ENV); console.log('seeded fake fixtures:', await seedDevFixtures(pool)); }
  else { console.error('usage: npm run seed:dev   |   npm run seed:dev:remove   (development only; fake data)'); process.exitCode = 1; }
} catch (e) { console.error((e as Error).message); process.exitCode = 1; } finally { await pool.end(); }
