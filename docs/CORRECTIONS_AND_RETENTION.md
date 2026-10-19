# Corrections, removal, retention and backups

## Correcting or removing a record
The **Published incidents** tab at `/admin/health` does all of this; the API calls below are what it uses.
All actions need an admin or reviewer token (`POST /api/admin/login`) and are written to `audit_events` with before and after snapshots.
```bash
TOKEN=...   # from /api/admin/login
curl -X POST $API/api/admin/incidents/$ID/correct -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"headline":"Corrected headline","note":"Why the record was wrong and what changed."}'
curl -X POST $API/api/admin/incidents/$ID/archive -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"reason":"Outdated; superseded by a newer report."}'
# outright removal (admin only): add "remove": true
```
1. Correction: adds a visible entry to the incident timeline and sets status to *corrected*.
2. Archive: takes the record off the public API; it stays in the database.
3. Removal (admin only): takes it down as inaccurate or harmful; the audit trail is kept.
4. Merge a duplicate (`POST /api/admin/incidents/:id/merge` with `intoIncidentId` and `reason`): the duplicate's sources and timeline move to the target, one primary source is kept, and the duplicate is archived, not deleted. The timeline shows a fixed note that a duplicate was merged; your reason stays internal (audit log and the archived record).
5. Wrong status claims are blocked: *corroborated* needs two independent linked sources, *official* needs a linked police source.
Mistaken merges are not undone by a button: restore from the audit log's before-snapshot or the database backup. There is no public correction form yet. The operator must publish a contact route and act on requests using the steps above.

## Retention (operator decisions, not enforced by code)
Nothing is deleted automatically. Suggested defaults to confirm before launch: keep audit events indefinitely; keep source documents while they support a published incident; remove personal names that lack a public-interest reason when asked; never store credentials or victim addresses (imports refuse street-level locations for sensitive categories).

## Backups
```bash
pg_dump --format=custom --file=crimelens-$(date +%F).dump "$DATABASE_URL"
pg_restore --clean --if-exists --dbname="$DATABASE_URL" crimelens-2026-10-09.dump
```
```powershell
pg_dump --format=custom --file="crimelens-$(Get-Date -Format yyyy-MM-dd).dump" $env:DATABASE_URL
```
Use your managed provider's automated backups as well, and test a restore before relying on it.
