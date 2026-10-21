import { makePool } from './db';
import { runPipeline } from './ingest/pipeline';
import { createPressNoteConnector } from './ingest/pressnotes';
import { llmStatus } from './ingest/llm';
import { geocoderFromEnv } from './ingest/geocode';

if (!process.env.CRAWLER_CONTACT) { console.error('Set CRAWLER_CONTACT (an email address or URL) in .env: the crawler must identify itself to the sites it visits.'); process.exit(1); }
console.error(llmStatus().message);
const pool = makePool();
try { console.log(JSON.stringify(await runPipeline(pool, [createPressNoteConnector({ maxPages: 1 })], {}, llmStatus().adapter, 'manual', geocoderFromEnv()), null, 2)); }
finally { await pool.end(); }
