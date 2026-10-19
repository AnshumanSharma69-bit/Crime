# Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| `npm run db:setup` cannot connect | Database not running or wrong `DATABASE_URL` in `.env`. Run `npm run db:up`; check port 5432 is free. |
| `extension "postgis" is not available` | Plain PostgreSQL. Use the `postgis/postgis` image or a provider with PostGIS. |
| Node error about `--env-file-if-exists` | Node older than 22.9. Upgrade Node. |
| Tests fail at `CREATE DATABASE` | Test user must be a superuser able to create databases. Set `TEST_PG_BASE`. |
| Web shows "incident service is unavailable" | API not running, wrong `NEXT_PUBLIC_API_URL` (needs a rebuild after changing), or CORS: set `CORS_ORIGIN` to the web origin. |
| Map is blank | Tile server blocked or WebGL unavailable; check the browser console. Set `NEXT_PUBLIC_MAP_STYLE_URL` for production. |
| Map is empty but the API works | No published incidents yet. Import drafts, then review and publish them, or use `npm run seed:dev` for fake local data. |
| Amber "Development fixture data is loaded" banner | Fake data from `seed:dev` is in the database. Remove it with `npm run seed:dev:remove`. |
| `seed:dev` says "refusing" | It only runs for local databases and never with `NODE_ENV=production`. This is intentional. |
| Admin endpoints answer 503 | `ADMIN_JWT_SECRET` missing or under 32 characters. |
| Admin endpoints answer 401 | Token expired (8 h), user disabled, or wrong password. Sign in again. |
| 409 `insufficient_evidence` | The requested status needs more linked sources than the incident has. |
| 409 `possible_duplicate` | Candidate resembles an existing incident: merge it, or resend with `confirmDistinct:true`. |
| Source never syncs | Not enabled or robots/terms review not recorded: `npm run source:enable ...`. Check `/admin/health`. |
| Run fails with `parser_found_no_items` | The site's markup changed or the parser (unverified) does not match it. Inspect the page and update `ingest/pressnotes.ts`. |
| Document status `error` with `pdf_no_text` | The PDF has no selectable text (probably a scan). OCR is not implemented; add the incidents by import instead. |
| Run error `blocked_by_robots` | The site's robots.txt now disallows the page for this crawler. Do not work around it. |
| Run error `robots_unavailable` | robots.txt could not be fetched (server error or network). Nothing is crawled until it can be; it retries on the next run. |
| `Set CRAWLER_CONTACT ...` and the command exits | The crawler must identify itself. Put an email address or URL in `.env`. |
| Document status `error` with `legacy_font_unconverted` | The PDF uses a legacy Marathi font encoding that the converter could not turn into a plausible result. Do not feed the raw text to the extractor; add the incidents by import, or extend `ingest/legacy-font.ts`. |
| Document status `error` with `http_403` / `http_404` | The site refused or removed the file. Do not work around a refusal; check the site's terms. |
| Extraction does nothing | LLM extraction is off unless `LLM_EXTRACTION_ENABLED=true` and `ANTHROPIC_API_KEY` are set. Documents without text are skipped. |
| Extraction errors (`invalid_extraction`) | The model's answer failed the strict schema. Nothing is queued for that document; try a different `LLM_MODEL`. |
| Drafts never get a location | Geocoding is off unless `GEOCODER_PROVIDER=nominatim` **and** `CRAWLER_CONTACT` are set. It only handles drafts that have a place name, at most 10 new lookups per run, and rejects results more than 40 km from the city. |
| Geocoder errors (`geocoder_http_429`) | The provider is rate limiting you. Failures are not cached and retry on the next run; reduce volume or self-host. |
| Everyone is rate limited at once | Behind a proxy: set `TRUST_PROXY_HOPS`. |
| Port 3000/4000 in use | Stop the other process or change `PORT`. |
| Docker build fails | The images are untested; run the apps with Node directly and report the error. |
