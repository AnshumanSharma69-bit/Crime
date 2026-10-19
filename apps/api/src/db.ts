import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(here, '../../../db/migrations');
const SOURCES_JSON = join(here, '../../../db/seed/sources.json');

export const makePool = (url = process.env.DATABASE_URL) => new pg.Pool({ connectionString: url, max: 10 });

/** Applies db/migrations/*.sql in filename order, once each, each in its own transaction. */
export async function migrate(pool: pg.Pool): Promise<string[]> {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const done = new Set((await pool.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const applied: string[] = [];
  for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(readFileSync(join(MIGRATIONS, f), 'utf8'));
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
      await c.query('COMMIT');
      applied.push(f);
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  return applied;
}

/** Upserts static source descriptors only; never overwrites status or fetch timestamps. */
export async function seedSources(pool: pg.Pool) {
  const list = JSON.parse(readFileSync(SOURCES_JSON, 'utf8')) as any[];
  for (const s of list) {
    await pool.query(
      `INSERT INTO sources (slug,name,type,url,city_id,collection_method,terms_notes,status,parser_status)
       VALUES ($1,$2,$3,$4,(SELECT id FROM cities WHERE slug=$5),$6,$7,$8,$9)
       ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name, url=EXCLUDED.url, terms_notes=EXCLUDED.terms_notes`,
      [s.slug, s.name, s.type, s.url, s.city, s.collectionMethod, s.termsNotes, s.status, s.parserStatus]);
  }
  return list.length;
}
