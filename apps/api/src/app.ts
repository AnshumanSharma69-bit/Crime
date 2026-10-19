import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { z, ZodError } from 'zod';
import type pg from 'pg';
import { ClusterQuery, FROM_SQL, FilterQuery, ListQuery, SELECT_INCIDENT, buildWhere, toDTO } from './query';
import { openapi } from './openapi';
import { adminRouter } from './admin';
import { analyticsRouter } from './analytics';
import { HttpError } from './errors';
import { createPressNoteConnector } from './ingest/pressnotes';
import { adapterFromEnv } from './ingest/llm';
import { geocoderFromEnv, type Geocoder } from './ingest/geocode';
import type { ExtractionAdapter } from './ingest/extract';
import type { Connector } from './ingest/types';

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => (req, res, next) => { fn(req, res).catch(next); };
const Uuid = z.string().uuid();

export function createApp(pool: pg.Pool, opts: { corsOrigin?: string; rateLimitPerMinute?: number; jwtSecret?: string; connectors?: Connector[]; loginLimit?: number; extractor?: ExtractionAdapter | null; geocoder?: Geocoder | null } = {}) {
  const app = express();
  app.disable('x-powered-by');
  const hops = Number(process.env.TRUST_PROXY_HOPS ?? 0);   // set to the number of reverse proxies in front of the API so rate limits see real client IPs
  if (hops > 0) app.set('trust proxy', hops);
  app.use(helmet());
  app.use(cors({ origin: opts.corsOrigin ?? process.env.CORS_ORIGIN ?? 'http://localhost:3000', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type', 'Authorization'] }));
  app.use(rateLimit({ windowMs: 60_000, limit: opts.rateLimitPerMinute ?? 120, standardHeaders: true, legacyHeaders: false }));
  app.use(express.json({ limit: '100kb' }));

  const getIncident = async (id: string) => {
    const { rows } = await pool.query(`${SELECT_INCIDENT} ${FROM_SQL} WHERE i.id = $1 AND i.publication_status = 'published'`, [id]);
    return rows[0] ? toDTO(rows[0]) : null;
  };

  app.get('/api/health', wrap(async (_req, res) => {
    try { await pool.query('SELECT 1'); res.json({ status: 'ok', database: 'ok' }); }
    catch { res.status(503).json({ status: 'degraded', database: 'unavailable' }); }
  }));
  app.get('/api/openapi.json', (_req, res) => { res.json(openapi); });

  app.get('/api/cities', wrap(async (_req, res) => {
    const { rows } = await pool.query(`SELECT slug, name, state, timezone, ST_Y(centroid::geometry) AS lat, ST_X(centroid::geometry) AS lng, boundary IS NOT NULL AS has_boundary FROM cities ORDER BY name`);
    res.json({ items: rows.map((r) => ({ slug: r.slug, name: r.name, state: r.state, timezone: r.timezone, centre: { lat: r.lat, lng: r.lng }, hasBoundary: r.has_boundary })) });
  }));

  app.get('/api/sources', wrap(async (_req, res) => {
    const { rows } = await pool.query(`SELECT slug, name, type, url, collection_method, terms_url, terms_notes, parser_status, enabled FROM sources ORDER BY name`);
    res.json({ items: rows.map((r) => ({ slug: r.slug, name: r.name, type: r.type, url: r.url, collectionMethod: r.collection_method, termsUrl: r.terms_url, termsNotes: r.terms_notes, parserStatus: r.parser_status, enabled: r.enabled })) });
  }));

  app.get('/api/sources/status', wrap(async (_req, res) => {
    const { rows } = await pool.query(`
      SELECT s.slug, s.name, s.status, s.parser_status, s.last_checked_at, s.last_success_at, s.last_published_at, r.outcome AS last_run_outcome
      FROM sources s LEFT JOIN LATERAL (SELECT outcome FROM source_fetch_runs WHERE source_id = s.id ORDER BY started_at DESC LIMIT 1) r ON true ORDER BY s.name`);
    res.json({ items: rows.map((r) => ({ slug: r.slug, name: r.name, status: r.status, parserStatus: r.parser_status, lastCheckedAt: r.last_checked_at, lastSuccessAt: r.last_success_at, lastPublishedAt: r.last_published_at, lastRunOutcome: r.last_run_outcome })) });
  }));

  app.get('/api/incidents', wrap(async (req, res) => {
    const q = ListQuery.parse(req.query);
    const { where, params } = buildWhere(q);
    const n = params.length;
    const { rows } = await pool.query(
      `${SELECT_INCIDENT}, COUNT(*) OVER() AS total ${FROM_SQL} WHERE ${where}
       ORDER BY COALESCE(i.event_start, s.published_at, i.created_at) DESC, i.id LIMIT $${n + 1} OFFSET $${n + 2}`,
      [...params, q.pageSize, (q.page - 1) * q.pageSize]);
    res.json({ items: rows.map(toDTO), total: rows.length ? Number(rows[0].total) : 0, page: q.page, pageSize: q.pageSize });
  }));

  app.get('/api/incidents/:id', wrap(async (req, res) => {
    const id = Uuid.parse(req.params.id);
    const inc = await getIncident(id);
    inc ? res.json(inc) : res.status(404).json({ error: 'not_found' });
  }));
  app.get('/api/incidents/:id/sources', wrap(async (req, res) => {
    const inc = await getIncident(Uuid.parse(req.params.id));
    inc ? res.json({ items: inc.sources }) : res.status(404).json({ error: 'not_found' });
  }));
  app.get('/api/incidents/:id/timeline', wrap(async (req, res) => {
    const inc = await getIncident(Uuid.parse(req.params.id));
    inc ? res.json({ items: inc.updates }) : res.status(404).json({ error: 'not_found' });
  }));

  app.get('/api/map/incidents', wrap(async (req, res) => {
    const { where, params } = buildWhere(FilterQuery.parse(req.query));
    const { rows } = await pool.query(
      `SELECT i.id, i.category_code, i.verification_status, i.location_precision, s.is_official, ST_X(i.location::geometry) AS lng, ST_Y(i.location::geometry) AS lat
       ${FROM_SQL} WHERE ${where} AND i.location IS NOT NULL LIMIT 2000`, params);
    res.json({ type: 'FeatureCollection', features: rows.map((r) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.lng, r.lat] },
      properties: { id: r.id, categoryCode: r.category_code, verificationStatus: r.verification_status, sourceType: r.is_official ? 'official_police' : 'news', approximate: r.location_precision !== 'street' } })) });
  }));

  app.get('/api/map/clusters', wrap(async (req, res) => {
    const q = ClusterQuery.parse(req.query);
    const { where, params } = buildWhere(q);
    const cell = (60 * 360) / (256 * 2 ** q.zoom);  // ~60px grid cells, in degrees
    const { rows } = await pool.query(
      `SELECT count(*)::int AS count, ST_X(ST_Centroid(ST_Collect(i.location::geometry))) AS lng, ST_Y(ST_Centroid(ST_Collect(i.location::geometry))) AS lat, (array_agg(i.id::text))[1] AS id
       ${FROM_SQL} WHERE ${where} AND i.location IS NOT NULL GROUP BY ST_SnapToGrid(i.location::geometry, $${params.length + 1}) LIMIT 2000`, [...params, cell]);
    res.json({ type: 'FeatureCollection', features: rows.map((r) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.lng, r.lat] },
      properties: r.count === 1 ? { count: 1, id: r.id } : { count: r.count } })) });
  }));

  app.use('/api/analytics', analyticsRouter(pool));
  app.use('/api/admin', adminRouter(pool, { secret: opts.jwtSecret ?? process.env.ADMIN_JWT_SECRET, connectors: opts.connectors ?? [createPressNoteConnector()], loginLimit: opts.loginLimit ?? 10, extractor: opts.extractor === undefined ? adapterFromEnv() : opts.extractor, geocoder: opts.geocoder === undefined ? geocoderFromEnv() : opts.geocoder }));

  app.use('/api', (_req, res) => { res.status(404).json({ error: 'not_found' }); });
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return void res.status(err.status).json({ error: err.code, ...(err.detail ? { detail: err.detail } : {}), ...(err.extra ?? {}) });
    if (err instanceof ZodError) return void res.status(400).json({ error: 'invalid_request', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    console.error('unhandled error', err);   // detail stays in server logs, never in the response
    res.status(500).json({ error: 'internal_error' });
  });
  return app;
}
