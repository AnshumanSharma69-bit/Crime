import { createHash } from 'node:crypto';
import type pg from 'pg';
import { FetchError, type Connector, type RunDeps } from './types';

export type RunResult = { slug: string; outcome: 'success' | 'failed' | 'skipped'; found?: number; created?: number; updated?: number; reason?: string };
const hash = (...p: (string | null)[]) => createHash('sha256').update(p.map((x) => x ?? '').join('\u0000')).digest('hex');

/** One source, one run. A source runs only if enabled AND a human has recorded a robots/terms review. */
export async function runSource(pool: pg.Pool, c: Connector, deps: RunDeps = {}, triggeredBy = 'schedule'): Promise<RunResult> {
  const now = deps.now ?? (() => new Date()); const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const src = (await pool.query('SELECT id, enabled, robots_checked_at FROM sources WHERE slug = $1', [c.slug])).rows[0];
  if (!src) return { slug: c.slug, outcome: 'skipped', reason: 'unknown_source' };
  if (!src.enabled) return { slug: c.slug, outcome: 'skipped', reason: 'not_enabled' };
  if (!src.robots_checked_at) return { slug: c.slug, outcome: 'skipped', reason: 'robots_not_reviewed' };

  const runId = (await pool.query('INSERT INTO source_fetch_runs (source_id, triggered_by, started_at) VALUES ($1,$2,$3) RETURNING id', [src.id, triggeredBy, now()])).rows[0].id;
  const finish = (outcome: string, error: string | null, n = { found: 0, created: 0, updated: 0 }, attempt = 1) => pool.query(
    'UPDATE source_fetch_runs SET finished_at=$2, outcome=$3, error=$4, items_found=$5, items_new=$6, items_updated=$7, attempt=$8 WHERE id=$1',
    [runId, now(), outcome, error, n.found, n.created, n.updated, attempt]);
  const fail = async (error: string, attempt: number): Promise<RunResult> => {
    await finish('failed', error, undefined, attempt);
    await pool.query(`UPDATE sources SET status='temporarily_unavailable', last_checked_at=$2 WHERE id=$1`, [src.id, now()]);
    return { slug: c.slug, outcome: 'failed', reason: error };
  };

  const max = deps.maxAttempts ?? 3; let items; let attempt = 0;
  for (;;) {
    attempt++;
    try { items = await c.fetchItems(deps); break; }
    catch (e) {
      const retryable = e instanceof FetchError ? e.retryable : true;
      if (!retryable || attempt >= max) return fail(e instanceof FetchError ? e.message : (e as Error).name || 'ConnectorError', attempt);
      await sleep((deps.baseDelayMs ?? 1000) * 2 ** (attempt - 1));
    }
  }
  if (items.length === 0) return fail('parser_found_no_items', attempt);   // an empty parse is treated as a failure, never as success

  let created = 0, updated = 0; let latest: Date | null = null;
  for (const it of items) {
    const h = hash(it.title, it.publishedAt?.toISOString() ?? null, it.bodyText);
    const prev = (await pool.query('SELECT content_hash FROM source_documents WHERE source_id=$1 AND canonical_url=$2', [src.id, it.canonicalUrl])).rows[0];
    if (!prev) created++; else if (prev.content_hash !== h) updated++;
    await pool.query(
      `INSERT INTO source_documents (source_id, canonical_url, external_id, title, published_at, language, body_text, content_hash, status, first_fetched_at, last_fetched_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
       ON CONFLICT (source_id, canonical_url) DO UPDATE SET last_fetched_at = EXCLUDED.last_fetched_at, title = EXCLUDED.title, published_at = EXCLUDED.published_at,
         body_text = COALESCE(EXCLUDED.body_text, source_documents.body_text), language = COALESCE(EXCLUDED.language, source_documents.language), content_hash = EXCLUDED.content_hash,
         status = CASE WHEN source_documents.content_hash IS DISTINCT FROM EXCLUDED.content_hash THEN 'updated' ELSE source_documents.status END`,
      [src.id, it.canonicalUrl, it.externalId, it.title, it.publishedAt, it.language, it.bodyText, h, it.incidentBearing ? 'new' : 'ignored', now()]);
    if (it.publishedAt && (!latest || it.publishedAt > latest)) latest = it.publishedAt;
  }
  await finish('success', null, { found: items.length, created, updated }, attempt);
  await pool.query(`UPDATE sources SET status='connected', last_checked_at=$2, last_success_at=$2, last_published_at=GREATEST(last_published_at, $3) WHERE id=$1`, [src.id, now(), latest]);
  return { slug: c.slug, outcome: 'success', found: items.length, created, updated };
}

/** A failing connector never stops the others. */
export async function runAll(pool: pg.Pool, connectors: Connector[], deps: RunDeps = {}, triggeredBy = 'schedule'): Promise<RunResult[]> {
  const out: RunResult[] = [];
  for (const c of connectors) {
    try { out.push(await runSource(pool, c, deps, triggeredBy)); }
    catch (e) { console.error('connector crashed', c.slug, e); out.push({ slug: c.slug, outcome: 'failed', reason: 'internal_error' }); }
  }
  return out;
}
