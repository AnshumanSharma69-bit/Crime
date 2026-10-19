# Source coverage and data limitations

## What the data is
Incident reports published by police and news organisations, each linked to its original source. Not an official police database; coverage is incomplete and uneven across sources, areas and time.

## Current sources (see `db/seed/sources.json`)
| Source | Type | Method | State |
|---|---|---|---|
| Nagpur City Police press releases | official police | HTML listing of PDF press notes | Listing structure confirmed from rendered text; one real PDF examined (Marathi, legacy font, converted); terms read (content is copyrighted; silent on automation); `robots.txt` returned 404 (no restrictions); connector never run live. See POLICE_SOURCE_NOTES.md |
| Nagpur Police statistics dashboard | official dataset | not inspected | Not integrated |
| NCRB "Crime in India" | official statistics | manual import | Nothing imported |
No news sources are configured because none has had its feed and terms verified.

## Reading the numbers
- Reports are not incidents, and incidents are not crimes. One incident can have many reports; reports and incidents are counted separately.
- More collected reports can mean more coverage, not more crime. Areas are listed alphabetically and never ranked; there is no population or reporting-rate denominator.
- A police statement confirms what police said, not that every allegation is true. Allegations, arrests, charges and court outcomes are different things.
- Date filters use the event date; incidents with no stated event date are excluded when a date filter is used.
- Marker positions can be approximate. Positions come from an import, or, if enabled, from geocoding a place name. Geocoded positions are rounded to about 1 km, marked low confidence and can be wrong; a reviewer sees them before publishing. Without a geocoder, an incident has no map position. Crimes against women and children are limited to neighbourhood precision.
- Sources publish on their own schedule. CrimeLens is not a real-time feed. UTC internally, IST on screen.
