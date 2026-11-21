import type pg from 'pg';
import { fetchDocumentBodies } from './documents';
import { autoAcceptCandidates, autoEnabled, autoPublishDrafts, policyFromEnv } from './auto';
import { extractCandidates, type ExtractionAdapter } from './extract';
import { geocodeIncidents, type Geocoder } from './geocode';
import { runAll } from './run';
import type { Connector, RunDeps } from './types';

/**
 * Listing fetch, PDF text, candidate extraction, approximate locations. By default everything ends in the review queue and nothing is published.
 * With AUTO_PUBLISH=true, candidates that pass the strict rules in auto.ts are accepted before geocoding and published after it.
 */
export async function runPipeline(pool: pg.Pool, connectors: Connector[], deps: RunDeps, adapter: ExtractionAdapter | null, triggeredBy = 'schedule', geocoder: Geocoder | null = null) {
  const results = await runAll(pool, connectors, deps, triggeredBy);
  const bodies = await fetchDocumentBodies(pool, deps, { limit: 10 });
  const extraction = await extractCandidates(pool, adapter, 10, { pauseMs: Number(process.env.LLM_PAUSE_MS ?? 4000) });
  const auto = autoEnabled() ? await autoAcceptCandidates(pool, policyFromEnv()) : null;
  const geocoding = await geocodeIncidents(pool, geocoder, { limit: 10 });
  const published = autoEnabled() ? await autoPublishDrafts(pool) : null;
  return { results, bodies, extraction, auto, geocoding, published };
}
