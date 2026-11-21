import { makePool } from './db';
import { revokeAutoPublished } from './ingest/auto';

// The undo button for automatic mode. Run from apps/api:  npx tsx --env-file-if-exists=../../.env src/auto-revoke.ts
const pool = makePool();
try { console.log(`Took ${await revokeAutoPublished(pool)} automatically published incident(s) off the map (they are drafts again; nothing was deleted).`); }
finally { await pool.end(); }
