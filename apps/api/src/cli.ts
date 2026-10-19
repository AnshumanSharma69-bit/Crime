import { makePool, migrate, seedSources } from './db';
const pool = makePool();
try {
  console.log('migrations applied:', await migrate(pool));
  console.log('sources upserted:', await seedSources(pool));
} finally { await pool.end(); }
