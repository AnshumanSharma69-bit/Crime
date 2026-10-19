import type pg from 'pg';
import { fetchDocumentBodies } from './documents';
import { extractCandidates, type ExtractionAdapter } from './extract';
import { geocodeIncidents, type Geocoder } from './geocode';
import { runAll } from './run';
import type { Connector, RunDeps } from './types';

/** Listing fetch, then PDF text, then candidate extraction, then approximate locations for drafts. Everything ends in the review queue; nothing is published. */
export async function runPipeline(pool: pg.Pool, connectors: Connector[], deps: RunDeps, adapter: ExtractionAdapter | null, triggeredBy = 'schedule', geocoder: Geocoder | null = null) {
  const results = await runAll(pool, connectors, deps, triggeredBy);
  const bodies = await fetchDocumentBodies(pool, deps, { limit: 10 });
  const extraction = await extractCandidates(pool, adapter, 10);
  const geocoding = await geocodeIncidents(pool, geocoder, { limit: 10 });
  return { results, bodies, extraction, geocoding };
}
