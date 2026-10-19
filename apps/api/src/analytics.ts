import express from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { CATEGORY_LABELS } from '@crimelens/shared';
import { FROM_SQL, FilterQuery, buildWhere, type Filter } from './query';

const CAVEATS = [
  'Counts are incidents CrimeLens collected from the listed sources. They are not official crime statistics.',
  'Coverage is incomplete and uneven across sources, areas and time. More collected reports does not mean more crime.',
  'No population or reporting-rate denominator is available, so areas are listed alphabetically and are not ranked or compared.',
];
const envelope = (f: Filter, data: unknown, extra: object = {}) => ({
  provenance: { kind: 'collected_reports', description: 'Distinct published incidents from police and news reports collected by CrimeLens', period: { from: f.from ?? null, to: f.to ?? null, dateBasis: 'event_date', timezone: 'Asia/Kolkata' } },
  caveats: CAVEATS, ...extra, data });

export function analyticsRouter(pool: pg.Pool) {
  const r = express.Router();
  const wrap = (fn: (req: express.Request, res: express.Response) => Promise<unknown>): express.RequestHandler => (req, res, next) => { fn(req, res).catch(next); };

  r.get('/summary', wrap(async (req, res) => {
    const f = FilterQuery.parse(req.query); const { where, params } = buildWhere(f);
    const row = (await pool.query(`WITH m AS (SELECT i.id, i.verification_status ${FROM_SQL} WHERE ${where})
      SELECT (SELECT count(*)::int FROM m) AS incidents,
             (SELECT count(DISTINCT document_id)::int FROM incident_sources WHERE incident_id IN (SELECT id FROM m)) AS articles,
             (SELECT COALESCE(json_object_agg(verification_status, n), '{}') FROM (SELECT verification_status, count(*)::int AS n FROM m GROUP BY 1) v) AS by_verification`, params)).rows[0];
    res.json(envelope(f, { incidents: row.incidents, sourceDocumentsLinked: row.articles, byVerification: row.by_verification },
      { officialStatistics: { available: false, note: 'No official aggregate statistics (for example NCRB) have been imported yet.' },
        notes: ['sourceDocumentsLinked counts reports, not incidents, and must not be used as an estimate of crimes.'] }));
  }));

  r.get('/categories', wrap(async (req, res) => {
    const f = FilterQuery.parse(req.query); const { where, params } = buildWhere(f);
    const { rows } = await pool.query(`SELECT i.category_code AS code, count(*)::int AS incidents ${FROM_SQL} WHERE ${where} GROUP BY 1 ORDER BY 2 DESC, 1`, params);
    res.json(envelope(f, rows.map((x) => ({ code: x.code, label: CATEGORY_LABELS[x.code as keyof typeof CATEGORY_LABELS], incidents: x.incidents }))));
  }));

  r.get('/timeline', wrap(async (req, res) => {
    const q = FilterQuery.extend({ bucket: z.enum(['day', 'week', 'month']).default('day') }).strict().parse(req.query);
    const { bucket, ...f } = q; const { where, params } = buildWhere(f);
    const { rows } = await pool.query(`SELECT to_char(date_trunc($${params.length + 1}, i.event_start AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD') AS bucket, count(*)::int AS incidents
      ${FROM_SQL} WHERE ${where} AND i.event_start IS NOT NULL GROUP BY 1 ORDER BY 1`, [...params, bucket]);
    const undated = (await pool.query(`SELECT count(*)::int AS n ${FROM_SQL} WHERE ${where} AND i.event_start IS NULL`, params)).rows[0].n;
    res.json(envelope(f, rows, { bucket, undatedIncidents: undated }));
  }));

  r.get('/areas', wrap(async (req, res) => {
    const f = FilterQuery.parse(req.query); const { where, params } = buildWhere(f);
    const { rows } = await pool.query(`SELECT COALESCE(a.name, 'Unknown area') AS area, count(*)::int AS incidents ${FROM_SQL} WHERE ${where} GROUP BY 1 ORDER BY 1`, params);
    res.json(envelope(f, rows, { notes: ['Listed alphabetically on purpose. Raw counts must not be read as how dangerous an area is.'] }));
  }));
  return r;
}
