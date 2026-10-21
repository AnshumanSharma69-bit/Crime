# Nagpur City Police: what was observed on 17 Oct 2026

These notes record what was actually read from `nagpurpolice.gov.in` with a page-fetch tool (not from CrimeLens's own crawler, and not from the sandbox's network, which cannot reach the site). Re-check before relying on any of it; sites change.

## Confirmed
- **Listing page** `press-releases` (the `.php` URL redirects): a table of *title | publication date | PDF link*, newest first, 10 rows per page, `?page=N` pagination (3 pages seen). The page footer showed a "last update" time and says the site is hosted by NIC.
- **Titles** are English: "Afternoon Pressnote dd-mm-yyyy" and "Evening Pressnote dd.mm.yyyy" (two a day), plus occasional "Press Conference <topic>" entries that describe specific cases. The date column renders as `dd/mm/yy dd/mm/yyyy`.
- **One press-note PDF was opened** (an afternoon note). It has a one-line English header, then Marathi body text. The text is *selectable but stored in a legacy Marathi font encoding (Kruti Dev)*, so a naive extraction yields Latin-looking gibberish ("iksyhl" is "पोलीस"). CrimeLens now detects and converts this, and refuses documents it cannot convert (`legacy_font_unconverted`).
- **Content shape:** a section of enforcement totals (not incidents), then many separate cases grouped by police station: offence, dates, arrests, recovered property and sections of law. It names accused persons and complainants with ages and detailed addresses. **CrimeLens must not republish those names or addresses**; the extraction prompt forbids them and summaries are written in the project's own words in English.
- Offence dates often differ from the publication date (an arrest can be announced months after the offence), so `eventDate` and publication date are stored separately.
- **Terms of use (`terms`, in Marathi), read in full:** use only for lawful purposes; no unlawful or unauthorised use; do not interfere with others' use; the department does not guarantee accuracy; **all site content (text, images, logos, graphics) is the department's property and protected by copyright**; liability disclaimer; third-party links; terms may change; Indian law and Nagpur courts. They say nothing explicit about automated access, and grant no reuse licence.

## robots.txt (checked by the project owner, 18 Oct 2026)
`https://nagpurpolice.gov.in/robots.txt` returned **404 Page Not Found**. Under the Robots Exclusion Protocol (RFC 9309) a 4xx answer means there are no crawl restrictions from robots.txt. That does not change the terms above: the content is still the department's copyright and the terms are still silent on automated access. CrimeLens also reads robots.txt itself on every run, before fetching the listing or any PDF, and stops if a Disallow rule applies or if robots.txt cannot be reached (5xx or network error).

## Certificate problem seen from Node (19 Oct 2026)
From the project owner's machine (Node 24, Windows), requests to `nagpurpolice.gov.in` failed with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, with any crawler name. That is consistent with the server not sending its intermediate certificate, which browsers repair silently and Node does not. `npm run fix-tls` downloads the intermediate named in the site's own certificate, checks it is the real issuer, and writes it to `certs/nagpurpolice.gov.in.pem` for `NODE_EXTRA_CA_CERTS`. Certificate verification is never switched off. If it reports that the chain ends at a root your Node does not trust, stop and ask before using `--include-root`: that makes the app trust that authority.

## Not verified (do these yourself)
- The disclaimer and privacy-policy pages were not read.
- Only **one** PDF was examined. Other notes and the "Press Conference" PDFs may differ in layout, encoding or whether they are scans.
- The listing's raw HTML was not seen (only its rendered text), so the parser's selectors are still assumptions.
- The converter was checked against common words from this encoding, not against a full document; expect gaps in rare conjuncts. Conversion quality should be spot-checked by a Marathi reader before trusting extracted summaries.

## What this means for the project
1. **Copyright:** the terms reserve the content. CrimeLens stores facts it extracts, writes short summaries in its own words and links to the original; it does not republish press-note text or PDFs, and fetched text is internal only (never served by the API).
2. **Permission:** because the terms are silent on automated access, consider asking the department in writing (the site has an "Inform Us / Feedback" form, and RTI exists) before running the connector regularly. This is not legal advice.
3. **Be gentle:** the connector fetches at most a listing page and a few PDFs per run, identifies itself, pauses between requests, and does not retry refusals.
4. Police-station headings are the natural location detail, so locations are police-station-area or neighbourhood level, never addresses.
