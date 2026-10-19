# CrimeLens

An interactive map of **reported** crime incidents, each linked to its original police or news source. First city: **Nagpur, Maharashtra**. The data model supports more cities.

CrimeLens is **not** an official police database and does **not** claim complete coverage. Counts are collected reports, not crime rates. See [docs/DATA_LIMITATIONS.md](docs/DATA_LIMITATIONS.md).

## What works today, and what does not

Working and covered by automated tests (143 tests):
- PostGIS schema and migrations; map workspace (clusters, filters stored in the URL, incident sidebar and detail panel, bounds filter, analytics overview, source-sync indicator).
- Read-only public API with OpenAPI JSON (`/api/openapi.json`), bounding-box and cluster queries, server-side pagination.
- Admin API: login with roles, review, correct, archive/remove, merge duplicates, candidate review, draft listing, manual ingestion, audit log.
- Admin web page `/admin/health` with three tabs: ingestion health; a **review queue** (accept, merge or reject candidates; review, publish or archive drafts; duplicate and evidence conflicts are shown, not hidden); and **published incidents** (correct, archive, merge duplicates, and, for admins only, remove).
- Light/dark theme toggle and a collapsible side panel.
- Approximate locations: drafts that have a place name but no coordinates can be geocoded (Nominatim, opt-in, cached, rate limited, results must fall near the city). Positions are rounded to about 1 km, marked neighbourhood precision and **low confidence**, apply to drafts only, and are audited, so a reviewer sees them before publishing.
- Ingestion framework: retries with backoff, run history, duplicate-safe re-runs, robots/terms gate, strict extraction schema, duplicate matching.
- CSV/JSON import as unpublished drafts.
- Document pipeline: listing fetch, then PDF download and text extraction (selectable-text PDFs only, size and page limits, same robots/terms gate), then optional LLM extraction of **several incidents per document** into the review queue. Everything ends as a candidate; nothing is published automatically.

**Not working or not built**
- **No incidents appear automatically, and that is intentional.** The pipeline can fetch the Nagpur Police listing, download press-note PDFs, convert and extract their text and (if you opt in) turn it into review candidates, but a person accepts each one. **What has and has not been checked against the real site** is in [docs/POLICE_SOURCE_NOTES.md](docs/POLICE_SOURCE_NOTES.md): the listing structure and one real PDF were examined (Marathi text in a legacy font, which CrimeLens now converts), the terms were read (they reserve all content as the department's copyright and are silent on automated access), `robots.txt` returned 404 on 18 Oct 2026 (no restrictions, and CrimeLens re-reads it on every run and obeys it), but **only one PDF was seen and the connector has never run against the live site**. Scans yield no text and OCR is not implemented.
- **Geocoding is opt-in and untested against the real service.** Set `GEOCODER_PROVIDER=nominatim` and `CRAWLER_CONTACT`; the public Nominatim service has a usage policy (identifying contact, at most 1 request per second, caching, low volume) that you must check yourself, or point `GEOCODER_URL` at your own instance. Place-name matches can be wrong, which is why they are low confidence and only ever neighbourhood level. Without a geocoder, drafts stay unmapped until a reviewer adds a location.
- **LLM extraction is off by default.** Turning it on (`LLM_EXTRACTION_ENABLED=true` plus `ANTHROPIC_API_KEY`) sends document text to the Anthropic API. Its output is schema-checked and treated as untrusted. Extraction quality on Marathi press notes is untested.
- No news connectors (no feed or terms have been verified). No official statistics (NCRB) have been imported.
- No public correction or tip form (intentionally; corrections come through the operator, see docs/CORRECTIONS_AND_RETENTION.md).
- Map colours and contrast were tuned by reasoning, not against a screenshot of the result; adjust the paint values in `apps/web/components/MapView.tsx`, or set `NEXT_PUBLIC_MAP_STYLE_URL` to a dark style you have rights to use.
- Docker images and the Windows process-stop path in `scripts/dev.mjs` were **not tested**. The map has not been checked in a real browser by the author.

## Architecture

```
apps/web     Next.js (App Router) + Tailwind + MapLibre GL JS      :3000
apps/api     Express + Zod + pg, REST + OpenAPI                     :4000
             src/ingest/  connectors, runner, extraction, import
             src/worker.ts  scheduled ingestion (default every 30 min)
packages/shared  taxonomies, Zod schemas, IST helpers
db/migrations    SQL migrations (PostGIS)      db/seed/sources.json  source registry
```
Source documents (reports) and incidents are separate tables, so many reports can support one incident. Times are stored in UTC and displayed in Asia/Kolkata. SQL is plain `pg` with bound parameters (no ORM).

## Requirements
Node.js **22.9 or newer**, npm, and PostgreSQL 16 with PostGIS 3 (Docker is the easiest way).

## Setup (bash)
```bash
npm install
cp .env.example .env
cp apps/web/.env.example apps/web/.env
npm run db:up          # PostGIS in Docker
npm run db:setup       # migrations + source registry (safe to re-run)
npm run dev            # API :4000 and web :3000
```
## Setup (PowerShell)
```powershell
npm install
Copy-Item .env.example .env
Copy-Item apps\web\.env.example apps\web\.env
npm run db:up
npm run db:setup
npm run dev
```
Open http://localhost:3000. With no data you will see an honest empty state, not placeholder incidents.

### Seeing markers locally (fake data, development only)
```bash
npm run seed:dev          # loads 9 clearly labelled FAKE incidents (all headlines start with "[DEV FIXTURE]")
npm run seed:dev:remove   # deletes them again
```
The fixtures cover every state: police and news reports, a corroborated incident with a timeline, a corrected one, street-level and approximate locations, a record with no location, and a cluster. The command refuses to run when `NODE_ENV=production` or when `DATABASE_URL` points to a non-local host, and the app shows an amber banner whenever fixture data is present. Never publish or screenshot these as real incidents.

## Tests
```bash
npm test
```
Needs PostgreSQL+PostGIS on `localhost:5432` with a superuser `crimelens` / `crimelens_dev_only` (what `npm run db:up` creates). Tests create and drop their own `crimelens_*_test` databases. Use `TEST_PG_BASE=postgresql://user:pass@host:port` to point elsewhere. External sources are mocked in tests only.

## Admin
```bash
# set ADMIN_JWT_SECRET in .env first: openssl rand -hex 32  (32+ characters, or the admin API answers 503)
ADMIN_PASSWORD='at-least-12-characters' npm run admin:create -w @crimelens/api -- you@example.org admin
```
```powershell
$env:ADMIN_PASSWORD = 'at-least-12-characters'
npm run admin:create -w "@crimelens/api" -- you@example.org admin
```
Roles: `admin` (everything, including ingestion and removal) and `reviewer` (review, correct, archive). Sign in at `/admin/health` to see sources and runs and to work through the review queue. Revoke access by setting `disabled_at` on the user; users are never deleted because the audit log references them.

## Sources and importing data
Set `CRAWLER_CONTACT` in `.env` (an email address or URL) first: the crawler identifies itself with it, and refuses to run without it.

`db/seed/sources.json` is the source registry (also shown at `/data-limitations`). A connector will not run until the source is enabled **and** someone has read the site's robots.txt and terms (CrimeLens also checks robots.txt itself on every run and obeys it):
```bash
npm run source:enable -w @crimelens/api -- nagpur-police-press-notes --reviewed-robots-and-terms
npm run ingest:once                      # run the whole pipeline once and print what happened
npm run worker -w @crimelens/api        # or keep running every 30 minutes
```
To load permitted records: `npm run import -w @crimelens/api -- records.csv --dry-run`, then without `--dry-run`. Columns: `sourceSlug,url,title,headline,summary,categoryCode` (+ optional `publishedAt,eventDate,locality,lat,lng,precision,confidence,city`). Imported incidents are **drafts**; a reviewer publishes them via `POST /api/admin/incidents/:id/review` with `"publish": true`. Street-level coordinates are refused for sensitive categories.

## Deployment (guidance, not yet exercised end to end)
1. **Database:** a managed PostgreSQL that supports PostGIS. Run `npm run db:setup` with its `DATABASE_URL`.
2. **API:** any Node 22 host. Build/install `npm ci`; start `npm run start -w @crimelens/api`. Set `DATABASE_URL`, `CORS_ORIGIN` (the web origin), `ADMIN_JWT_SECRET`, `TRUST_PROXY_HOPS` (number of proxies in front), `CRAWLER_CONTACT`.
3. **Worker:** the same code as a separate always-on process: `npm run worker -w @crimelens/api`.
4. **Web (Vercel):** project root `apps/web` with "include files outside the root directory" enabled (it imports `packages/shared`); set `NEXT_PUBLIC_API_URL` to the API's public URL, and optionally `NEXT_PUBLIC_MAP_STYLE_URL`. The default OpenStreetMap tiles are for development-scale use only; use a provider you have rights to for production.
5. **Docker alternative:** `docker compose --profile app up -d --build` (untested images).
Backups, retention and corrections: [docs/CORRECTIONS_AND_RETENTION.md](docs/CORRECTIONS_AND_RETENTION.md). Problems: [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).
