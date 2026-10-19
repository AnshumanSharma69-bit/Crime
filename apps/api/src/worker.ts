import { makePool } from './db';
import { runPipeline } from './ingest/pipeline';
import { adapterFromEnv } from './ingest/llm';
import { geocoderFromEnv } from './ingest/geocode';
import { createPressNoteConnector } from './ingest/pressnotes';

if (!process.env.CRAWLER_CONTACT) { console.error('Set CRAWLER_CONTACT (an email address or URL) in .env: the crawler must identify itself to the sites it visits.'); process.exit(1); }
const pool = makePool(); const adapter = adapterFromEnv(); const geocoder = geocoderFromEnv(); const everyMs = Number(process.env.INGEST_INTERVAL_MINUTES ?? 30) * 60_000; let running = false;
async function tick() {
  if (running) return; running = true;
  try { console.log(JSON.stringify(await runPipeline(pool, [createPressNoteConnector()], {}, adapter, 'schedule', geocoder))); } finally { running = false; }
}
void tick(); setInterval(() => void tick(), everyMs);
