# Automatic mode

With `AUTO_PUBLISH=true`, incidents can go from an official police press note to the public map with no one clicking anything. It is **off by default**.

## What happens, in order
1. The listing and PDFs are fetched, the Marathi is converted, personal details are redacted, and the AI extractor turns each note into candidate incidents.
2. **Automatic acceptance.** A candidate becomes a draft only if it passes every rule below. Otherwise it stays in the Review queue for a person.
3. **Place lookup.** Drafts with a place name get an approximate position (neighbourhood level, low confidence).
4. **Automatic publishing.** Only drafts that automatic mode created itself, that nobody has touched, that have an official source and a position, are published. Their public note says they were published without review by a person.

## Rules that always send a candidate to a person
| Rule | Why |
|---|---|
| Source is not an official police source | News reports need a human check |
| Category is crimes against women and children, or unknown | Sensitive; never automatic |
| Extraction confidence is low (or below `high` if `AUTO_MIN_CONFIDENCE=high`) | The model was unsure |
| No place name | It could not be placed on the map |
| Text still contains a redaction marker such as `[NAME]` | The extraction is not clean |
| Event date is in the future or older than `AUTO_MAX_AGE_DAYS` (default 120) | Probably misread |
| It looks like a duplicate of an existing incident | A person decides whether to merge |

Drafts from CSV import, and any draft a person has reviewed, are **never** published automatically.

## Turn it on
Add to the root `.env`, together with the AI extraction and place-lookup settings:
```
AUTO_PUBLISH=true
# optional: AUTO_MIN_CONFIDENCE=high   AUTO_MAX_AGE_DAYS=60
```
Then `npm run ingest:once` (or the worker). The printed result shows `auto` (accepted, and held with reasons) and `published`.

**Suggested rollout:** run first with `AUTO_PUBLISH` off and look at the candidates in the Review queue. Turn it on only when they look right. Check the map after the first automatic run.

## Undo
From `apps\api`:
```
npx tsx --env-file-if-exists=../../.env src/auto-revoke.ts
```
It takes every automatically published incident that nobody has edited off the map. They become drafts again, nothing is deleted, and automatic mode will not republish them. Individual incidents can also be archived or corrected in the **Published incidents** tab.

## What it can still get wrong
- The AI can misread a note: wrong category, wrong day, a wrong place. The rules reduce this; they do not remove it.
- Place-name matches can put a marker in the wrong neighbourhood. Positions are approximate by design.
- An arrest announced for an older offence can look like a new incident. The date rule catches only old or future dates.
- Police notes describe allegations. Automatic mode never names anyone, but a published entry still says a crime was reported in an area.
