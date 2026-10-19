const filters = ['city', 'category', 'verification', 'sourceType', 'from', 'to', 'q', 'locality', 'bbox'].map((name) => ({
  name, in: 'query', required: false, schema: { type: 'string' },
  description: { bbox: 'minLng,minLat,maxLng,maxLat', from: 'YYYY-MM-DD, event date, IST', to: 'YYYY-MM-DD, event date, IST, inclusive', sourceType: 'official_police | news' }[name as string] ?? undefined,
}));
const get = (summary: string, extra: object = {}) => ({ get: { summary, responses: { '200': { description: 'OK' }, '400': { description: 'Invalid request' } }, ...extra } });
const id = [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }];

export const openapi = {
  openapi: '3.0.3',
  info: { title: 'CrimeLens API', version: '0.1.0', description: 'Read-only public API. Incidents are reports collected from police and news sources; coverage is incomplete and counts are not crime rates. Admin endpoints are not implemented yet.' },
  paths: {
    '/api/health': get('Service and database health'),
    '/api/cities': get('Supported cities'),
    '/api/sources': get('Source registry (descriptors, terms notes, parser status)'),
    '/api/sources/status': get('Per-source availability, last check, last success, last published item'),
    '/api/incidents': get('Published incidents, filtered and paginated', { parameters: [...filters, { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 } }, { name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } }] }),
    '/api/incidents/{id}': get('One published incident', { parameters: id }),
    '/api/incidents/{id}/sources': get('Source reports for an incident', { parameters: id }),
    '/api/incidents/{id}/timeline': get('Developments and corrections for an incident', { parameters: id }),
    '/api/map/incidents': get('GeoJSON points for located incidents (max 2000)', { parameters: filters }),
    '/api/map/clusters': get('Grid clusters for a viewport', { parameters: [...filters, { name: 'zoom', in: 'query', schema: { type: 'number', minimum: 0, maximum: 20 } }] }),
  },
};

const body = { requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } } };
const post = (summary: string, extra: object = {}) => ({ post: { summary, security: [{ bearer: [] }], responses: { '200': { description: 'OK' }, '400': { description: 'Invalid request' }, '401': { description: 'Unauthorized' }, '403': { description: 'Forbidden' }, '409': { description: 'Evidence does not support the requested status' } }, ...body, ...extra } });
Object.assign(openapi.paths, {
  '/api/analytics/summary': get('Counts of collected incidents with provenance, period and caveats; reports are counted separately from incidents', { parameters: filters }),
  '/api/analytics/categories': get('Incidents by category', { parameters: filters }),
  '/api/analytics/timeline': get('Incidents by day, week or month (IST)', { parameters: [...filters, { name: 'bucket', in: 'query', schema: { type: 'string', enum: ['day', 'week', 'month'] } }] }),
  '/api/analytics/areas': get('Incidents by area, alphabetical, never ranked', { parameters: filters }),
  '/api/admin/login': { post: { summary: 'Exchange email and password for a bearer token (rate limited)', ...body, responses: { '200': { description: 'OK' }, '401': { description: 'Invalid credentials' } } } },
  '/api/admin/ingestion-runs': { get: { summary: 'Recent ingestion runs (admin or reviewer)', security: [{ bearer: [] }], responses: { '200': { description: 'OK' }, '401': { description: 'Unauthorized' } } } },
  '/api/admin/ingest': post('Run connectors now (admin only)'),
  '/api/admin/incidents/{id}/review': post('Set verification status with an explanation; optionally publish', { parameters: id }),
  '/api/admin/incidents/{id}/correct': post('Correct headline, summary or category, with a recorded note', { parameters: id }),
  '/api/admin/incidents/{id}/archive': post('Archive an incident; remove:true (admin only) takes it down', { parameters: id }),
});
(openapi as any).components = { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } };

Object.assign(openapi.paths, {
  '/api/admin/candidates': { get: { summary: 'Extraction candidates awaiting review', security: [{ bearer: [] }], responses: { '200': { description: 'OK' } } } },
  '/api/admin/candidates/{id}/accept': post('Create a draft incident, or merge into mergeIntoIncidentId; likely duplicates return 409 until resolved'),
  '/api/admin/candidates/{id}/reject': post('Reject a candidate with a reason'),
});

Object.assign(openapi.paths, {
  '/api/admin/incidents': { get: { summary: 'Incidents by publication status (default draft), for reviewers', security: [{ bearer: [] }], parameters: [{ name: 'status', in: 'query', schema: { type: 'string', enum: ['draft', 'published', 'archived', 'removed'] } }], responses: { '200': { description: 'OK' }, '401': { description: 'Unauthorized' } } } },
  '/api/admin/incidents/{id}/merge': post('Merge a duplicate incident into another; the duplicate is archived and its sources and timeline move across', { parameters: id }),
});
