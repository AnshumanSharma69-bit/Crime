import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makePool } from './db';
import { redactForExternalApi } from './ingest/redact';

// Writes exactly what WOULD be sent to an external AI service. Nothing is sent anywhere by this command.
const limit = Math.min(10, Math.max(1, Number(process.argv[2] ?? 3)));
const pool = makePool();
try {
  const rows = (await pool.query(`SELECT id, title, body_text FROM source_documents WHERE body_text IS NOT NULL ORDER BY published_at DESC NULLS LAST, id DESC LIMIT $1`, [limit])).rows;
  if (!rows.length) { console.log('No documents with text yet. Run npm run ingest:once first.'); process.exit(0); }
  const dir = fileURLToPath(new URL('../../../previews/', import.meta.url)); mkdirSync(dir, { recursive: true });
  for (const d of rows) {
    const r = redactForExternalApi(d.body_text); const file = `${dir}redacted-${d.id}.txt`;
    writeFileSync(file, '\uFEFF' + r.text);
    console.log(`document ${d.id}: replaced ${r.counts.names} names, ${r.counts.addresses} addresses, ${r.counts.numbers} numbers, ${r.counts.vehicles} vehicle numbers, ${r.counts.emails} e-mails  ->  ${file}`);
  }
  console.log('\nOpen the files and search them (Ctrl+F) for names and places you can still see. Anything left would be sent. Nothing was sent anywhere.');
} finally { await pool.end(); }
