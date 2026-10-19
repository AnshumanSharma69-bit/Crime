import { readFileSync } from 'node:fs';
import { makePool } from './db';
import { importRecords, parseImport } from './ingest/import';
const [file, ...flags] = process.argv.slice(2);
if (!file || !/\.(csv|json)$/i.test(file)) { console.error('usage: npm run import -w @crimelens/api -- <file.csv|file.json> [--dry-run]'); process.exit(1); }
const pool = makePool();
const res = await importRecords(pool, parseImport(readFileSync(file, 'utf8'), file.toLowerCase().endsWith('.csv') ? 'csv' : 'json'), { dryRun: flags.includes('--dry-run') });
console.log(JSON.stringify(res, null, 2)); await pool.end(); process.exit(res.errors.length ? 2 : 0);
