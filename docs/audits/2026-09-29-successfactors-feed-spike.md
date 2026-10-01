# SuccessFactors public-feed spike: what Dutch career sites really expose

**Date:** 2026-09-29 · **Scope:** task B3 of `docs/plans/2026-09-29-jobhunt-tashi-and-findings.md` (time-boxed spike, research only, no production code, no adapter) · **Branch:** `docs/successfactors-feed-spike`

**How to read this.** Inside the per-site tables every cell is a **[FACT]** (seen in a response fetched on 2026-09-29, or read from a repo file whose path is given) unless it carries **[INFERENCE]** (my reading of the facts, not tested) or **[NOT MEASURED]** (not tested, reason given). Verdicts: **YES** = a public, unauthenticated GET surface that robots.txt allows and that yields title, location, a date and an id today. **PARTIAL** = public and allowed, but a needed field or a usable list is missing. **NO** = no surface that a poller obeying robots.txt may use.

## Answer

**Overall: PARTIAL.** Two of the three requested sites expose a public, unauthenticated list over plain GET; the third is closed to automated access by robots.txt. Only one of those two (SBM Offshore) is a SuccessFactors-rendered site. The bigger finding is that the corpus label "successfactors" does not tell you what the public site is: of four sites probed, one is SAP's legacy portal (blocked), one is Phenom People (not SuccessFactors-rendered at all), and two are SuccessFactors Recruiting Marketing with different search templates. So "the SuccessFactors adapter" is the wrong unit of work; see Recommendation.

| Employer (CSV category) | Corpus row | What the public site actually is | Public list that robots.txt allows | Verdict |
|---|---|---|---|---|
| HEINEKEN (shared-services) | `career5.successfactors.eu/career?company=C0000032666P` | SAP-hosted legacy portal | none: robots.txt says `Disallow: /`; job URLs not fetched | **NO** (policy, not a technical failure) |
| AkzoNobel (shared-services) | `careers.akzonobel.com` | Phenom People front end; the landing HTML never says "successfactors" | XML sitemap (229 job URLs) and a `search-results` page with the job JSON embedded (230 jobs, 10 per page) | **YES** (a Phenom parser, not SF) |
| SBM Offshore (shared-services) | `careers.sbmoffshore.com` | SuccessFactors Recruiting Marketing (inferred from `jobs2web` and `j2w` assets) | XML sitemap (293 job URLs) and server-rendered `/search/` (20 rows per page, 15 pages) | **YES** (HTML parse, no JSON or feed) |
| Vistra (trust-fund-admin), bonus | `careers.vistra.com` | SuccessFactors Recruiting Marketing (same assets as SBM Offshore) | XML sitemap (244 job URLs); `/search/` renders no rows; job page shows no labelled location or date | **PARTIAL** |

## What the repo already knew, and one correction

- **[FACT]** `docs/plans/2026-09-08-successfactors-adapter-for-tashi-supply.md` and `docs/antigravity/AG-013-successfactors-adapter.md` scope an adapter around SAP's DWR call (`careerJobSearchControllerProxy.getInitialJobSearchData.dwr` on `career5.successfactors.eu`). AG-013's own header marks it ON HOLD.
- **[FACT]** `docs/sessions/2026-09-08-jobhunt-supply-audit.md` (lines 117-126) measured the SuccessFactors share of the NL-finance list against the same public corpus: **7** raw hits by strict matching (Vistra, Heineken, AkzoNobel, DSM-Firmenich, SBM Offshore; two are duplicate spellings), 13 by a loose matcher. Those five employers are where I sampled from.
- **Correction.** Plan task B3 says memory recorded "85 of 126 NL finance employers sit on SuccessFactors (measured 2026-09-08)". The 2026-09-08 audit superseded that figure with 7. I did not re-measure it and use it nowhere below. **[INFERENCE]** The 85 looks like the count of employers with no corpus row on any of the ten polled platforms, which `docs/plans/2026-09-08-successfactors-adapter-for-tashi-supply.md` (lines 12-14) describes as "on SuccessFactors, Taleo or bespoke career sites", not "on SuccessFactors".
- **[FACT]** `src/tools/jobhunt/adapters/` holds ashby, bamboohr, greenhouse, lever, personio, recruitee, smartrecruiters, teamtailor, workable, workday (plus `index.ts`, `types.ts`). There is no SuccessFactors or Phenom adapter. The only file in `src`, `docs` and `scripts` that mentions "phenom" is `docs/strategy/data/ind-sponsors-work.csv`.
- **[FACT]** The corpus (`kalil0321/ats-scrapers`, `ats-companies/successfactors.csv`, fetched today) has 1,392 data rows (1,393 lines with the header, the number earlier notes quote). By URL shape: 1,288 custom domains (92.5%), 80 legacy `career*.successfactors.{eu,com}/career?company=` (5.7%), 19 `*.jobs2web.com` (1.4%), 5 other SAP-hosted (0.4%).

## Method and limits

- **[FACT]** Plain GET only. No cookies sent or kept, no login, form, POST or captcha. A throwaway probe script (deliberately not committed) enforced: at least 1.1 s between requests; User-Agent `FounderOS-feed-spike/1.0 (research spike; plain GET; max 1 req/s)`; robots.txt fetched first for every host and evaluated (longest match, `*` and `$` wildcards) before any other fetch on that host, with a disallowed URL not fetched.
- **[FACT]** 27 requests to career hosts (SAP shards 6, AkzoNobel 7, SBM Offshore 8, Vistra 6) plus 1 to the public corpus; list in the appendix. No 401, 403, 429, captcha or bot-wall marker appeared. None of the robots.txt files fetched (SAP, AkzoNobel, SBM Offshore, Vistra) sets a `Crawl-delay`.
- **Disclosures.** (1) The first `careers.sbmoffshore.com/robots.txt` request timed out after 30 s. I retried once with curl and the same User-Agent (HTTP 200 in 0.54 s), then the script re-fetched it. That curl retry ran outside the throttle and may have started within a second of the preceding request, which went to a different host. (2) No site's Terms of Use were read; robots.txt permission is not a licence to poll.
- Four sites is a sample, not a measurement of the corpus. Everything about the other 1,388 rows is **[INFERENCE]**. Counts (293 jobs and so on) are a snapshot of 2026-09-29.

## Findings per site

### 1. HEINEKEN, SAP legacy portal: NO

| Item | Result |
|---|---|
| URL tried | `https://career5.successfactors.eu/robots.txt` |
| Status, type | 200, `text/plain`, 4 lines (the five other shards measure 59 bytes each) |
| Job-list URLs | **not fetched.** `Disallow: /` and `Disallow: /*company` both match `/career?company=C0000032666P`; `Disallow: /` also covers the DWR path (`/xi/ajax/remoting/call/plaincall/...`) named in the 2026-09-08 scoping |
| Auth, cookies, CSRF | **[NOT MEASURED]** (page not fetched). The 2026-09-08 scoping calls the data path a session-bound DWR POST; I did not re-verify that |
| Pagination, fields | **[NOT MEASURED]** |

The whole payload:

```
User-agent: *
Disallow: /
Disallow: /*company
Allow: /login
```

- **[FACT]** The identical 59-byte robots.txt is also served by `career2.successfactors.eu`, `career4.successfactors.com`, `career8.successfactors.com`, `career10.successfactors.com` and `career012.successfactors.eu`: with `career5` that is 6 of 6 SAP hosts checked.
- **[INFERENCE]** dsm-firmenich (`career5.successfactors.eu/career?company=C0000031152P`) is on the same host, so the same rule covers it; I did not fetch its page. Any adapter that obeys robots.txt cannot use a legacy-portal tenant, whatever the DWR protocol turns out to be.
- **[NOT MEASURED]** Whether Heineken also runs a public site on its own domain. The corpus only has the `career5` row, and guessing a domain is the practice AG-013 rules out for registry rows.

### 2. AkzoNobel, Phenom People front end: YES (not SuccessFactors)

| Item | Result |
|---|---|
| Platform evidence | landing HTML: 61 mentions of "phenom", 24 `data-ph-id` attributes, JSON-LD URLs on `akzonobel.phenompeople.net`, 0 mentions of "successfactors". robots.txt names `phenomtrack.min.js`, `lifeatphenom`, `workingatphenom` |
| robots.txt | 200 `text/plain; charset=UTF-8`. Disallows `*/apply`, `*/jobcart`, `*/iauth`, `*/chatbot`, `*/glassdoor`, `*/px-widgets` and `*/pxhome*` pages; nothing matches the sitemap, `search-results` or `job/` paths. `Sitemap:` lines for gb/en, br/pt, es/es, fr/fr, de/de, nl/nl |
| URLs tried | `/` 303 to `/gb/en` (200, `text/html; charset=UTF-8`, 91,612 B); `/nl/nl/sitemap.xml` (200, `application/xml`, 68,362 B); `/nl/nl/search-results` (200, `text/html`, 84,440 B); `/nl/nl/search-results?from=10&s=1` (200, 84,891 B); `/nl/nl/job/ANDANAGB55992EXTERNALNLNL/Sales-Assistant-Driver` (200, 115,729 B) |
| Auth, cookies, CSRF | none required. The server sets `PLAY_SESSION`, `PHPPPE_ACT`, `VISITED_LANG`, `VISITED_COUNTRY`, but every request I sent carried no cookie and returned complete data. A `csrfToken` string is embedded in the HTML (value deliberately not recorded here; **[INFERENCE]** it serves the site's own POST calls); not needed for these GETs |
| Pagination | `?from=N&s=1`, 10 jobs per page, 23 pages for 230 jobs. Page 2 returned different jobs; `totalHits` stayed 230 |
| Fields (list JSON) | title (`title`); location (`city`, `country`, `location`, `latitude`, `longitude`, `multi_location`); dates (`postedDate`, `dateCreated`); ids (`jobId`, `reqId`, `jobSeqNo`); `category`, `department`, `type`. **No apply URL** (`applyUrl` occurs 0 times, and `*/apply` is disallowed); the public job URL is `/nl/nl/job/<id>/<slug>` as listed in the sitemap |

- **Sitemap [FACT]:** `<urlset>`, 252 `<loc>`: 229 job pages, 10 category pages (`*-job`), 13 other pages. `lastmod` has 18 distinct values between 2026-09-22 and 2026-09-29 (the first three entries share `2026-09-29T11:19:06+00:00`).
- **The list is global [FACT]:** the sitemap under `/nl/nl/` includes French and Swiss postings, and the 20 jobs on pages 1 and 2 are in ARE, EGY, FRA, GRC, IND, JPN, KOR, POL and USA (plus at least one with an empty country), none in the Netherlands. **[INFERENCE]** `/nl/nl/` is a language variant, not an NL-only job set, so an NL filter means paging all 23 pages or finding a facet (not tested).
- **Sample, list JSON, first job of page 1 (selected fields):** `{"title":"Asst Area Sales Manager","jobId":"43271","reqId":"50127333","postedDate":"2024-11-06T05:26:06.000+0000","dateCreated":"2026-09-18T11:02:27.632+0000","city":"Bangalore","country":"IND","location":"Bangalore, IND","category":"Sales"}`. The two dates differ by almost two years on this job; which one means "posted" is **[NOT MEASURED]**.
- **Sample, job page JSON-LD `JobPosting` (selected fields):** `title` "Sales Assistant/Driver", `datePosted` `2026-09-10T13:29:48.000+0000`, `identifier.value` "55992", `employmentType` "Regular", `jobLocation.address` GBR / Yeovil, `directApply` false. Keys present: datePosted, description, directApply, employmentType, hiringOrganization, identifier, industry, jobLocation, occupationalCategory, title, workHours.
- **[INFERENCE]** The id inside the sitemap URL (`ANDANAGB55992EXTERNALNLNL`) embeds the JSON-LD identifier 55992. Whether SuccessFactors is the ATS behind this Phenom site is **[NOT MEASURED]**: nothing I fetched says so.

### 3. SBM Offshore, SuccessFactors Recruiting Marketing: YES

| Item | Result |
|---|---|
| Platform evidence | `Server: Apache` / `nginx`, `JSESSIONID`, scripts under `/platform/js/j2w/...`, one `jobs2web` mention, `/search/` with `startrow` and `sortColumn=referencedate` links. **[INFERENCE]** SAP Recruiting Marketing (formerly Jobs2Web) |
| robots.txt | 200 `text/plain`, 10 lines: `User-agent: *` then Disallow `/applybutton/`, `/talentcommunity/`, `/mobile/talentcommunity/`, `/emailsubscribe/`, `/email/image/`, **`/services/`**, `/preapply/`, `/error`, `/unsubscribe/`, `/reset/`. No `Sitemap:` line. `/sitemap.xml`, `/search/` and `/job/` are not disallowed |
| URLs tried | `/` (200, `text/html;charset=UTF-8`, 93,123 B); `/sitemap.xml` (200, `text/xml;charset=UTF-8`, `Content-Length` 5,529, decoded 58,644 B, I sent `Accept-Encoding: gzip`); `/search/?q=&startrow=0` (200, 113,257 B); `/search/?q=&startrow=25` (200, 114,266 B); `/job/Georgetown-Mechanical-Technician/1350318557/` (200, 86,861 B) |
| Auth, cookies, CSRF | none required. `JSESSIONID` is set on every page and sitemap response and was never sent back by me; every request that got a response returned 200. The string `csrf` appears once in the HTML; no token was needed |
| Pagination | `startrow=0,20,...,280`; 20 rows per page; label `Results 1 – 20 of 293 Page 1 of 15`. `startrow=25` returned different rows (first row a Rio de Janeiro posting), so the offset is honoured and need not be a multiple of 20 |
| Fields (search row) | title, location text, date, department, job URL with numeric id. **No apply URL** (`/applybutton/` and `/preapply/` are disallowed); the job URL is the public link |

- **Sitemap [FACT]:** `<urlset xmlns="http://www.google.com/schemas/sitemap/0.9" ...>` with an `xml-stylesheet` line, 293 `<loc>`, all shaped `/job/<Location>-<Title>/<numeric id>/`, and 293 `<lastmod>` that are all `2026-09-26`. First three `<loc>`: `.../job/Georgetown-Mechanical-Technician/1350318557/`, `.../job/Georgetown-Electrical-Technician/1350318757/`, `.../job/Georgetown-Instrument-Technician/1350318457/`.
- **Search row sample [FACT]:** `('Bulk Manager', 'Rotterdam Office, NL', 'Sep 29, 2026', 'Bulk Management', '/job/Rotterdam-Office-Bulk-Manager/1362904457/')`. Multi-location postings collapse to text such as `MX +1 more…`. Class names that matched: `data-row`, `jobTitle-link`, `jobLocation`, `jobDate`, and `jobFacility` or `jobDepartment` for the department.
- **Job page [FACT]:** no JSON-LD. schema.org microdata (`JobPosting`) gives `datePosted` "Fri Sep 04 02:00:00 UTC 2026", `hiringOrganization` "singlebuoy" (a brand name, not "SBM Offshore") and a location string; `data-careersite-propertyid` gives `dept` "Maintenance", `location` "Georgetown, GY" and `customfield1` "21409". The strings "Requisition" and "Job ID" do not occur in the page HTML. Whether `customfield1` is the SuccessFactors requisition number is **[NOT MEASURED]**; the numeric id in the URL (1350318557) is a different number.
- **Dates [FACT]:** for this one job the sitemap `lastmod` (2026-09-26) and the microdata `datePosted` (Sep 04) disagree, so `lastmod` cannot serve as a posting date. Whether the row date is "first posted" or "last refreshed" is **[NOT MEASURED]**.
- **NL relevance:** page 1 contains a row located "Rotterdam Office, NL" **[FACT]**. 25 of the 293 sitemap URLs have slugs starting with Schiphol, Amsterdam, Rotterdam, Den-Haag, The-Hague, Hoofddorp or Netherlands **[FACT, crude: it undercounts multi-location postings and the sitemap has no country field]**.
- **Cost of a sweep [INFERENCE from the sizes above]:** 15 search pages (about 1.7 MB) plus 1 sitemap request, no per-job requests needed for title, location, date and id.

### 4. Vistra (bonus, same platform as SBM): PARTIAL

| Item | Result |
|---|---|
| robots.txt | 200 `text/plain`, the same 10 lines as SBM Offshore |
| URLs tried | `/` (200, 98,943 B); `/sitemap.xml` (200, `text/xml;charset=UTF-8`, `Content-Length` 3,834, decoded 45,052 B); `/search/?q=&startrow=0` (200, `text/html;charset=UTF-8`, 90,642 B); `/job/Team-Lead%2C-FA/1440288433/` (**302** to `/job/Team-Lead,-FA/18476-en_US/`); the canonical job page (200, 90,611 B) |
| Sitemap | 244 `<loc>`, all `/job/<Title>/<numeric id>/` with **no location in the URL**; 244 `<lastmod>`, all `2026-09-26`. First: `https://careers.vistra.com/job/Team-Lead%2C-FA/1440288433/` |
| Search page | **0 result rows**: no `data-row`, no `jobTitle-link`, no pagination label. The page loads `/platform/js/j2w/min/j2w.searchManager.min.js` **[INFERENCE: results are drawn client-side]** |
| Job page | title only (`og:title` "Team Lead, FA"). It carries the `http://schema.org/JobPosting` itemtype but no `itemprop` fields and no JSON-LD, and a search of the page for posted, location, requisition and job-id labels found nothing. The canonical id (`18476`) differs from the sitemap id (`1440288433`) |
| Auth, cookies, CSRF | none required; `JSESSIONID` set and unused, as on SBM |

- **[FACT]** SBM and Vistra load the same asset build (`?h=275f70e9`), so **[INFERENCE]** the difference in search rendering is per-tenant configuration, not platform version.
- **Verdict PARTIAL:** an allowed, unauthenticated sitemap yields title and id for 244 jobs, and I found nothing further in the two page types I fetched (`/services/` is disallowed, so I made no third kind of request).

## Cross-site findings

- **[FACT] The corpus label does not identify the front end.** Of the five SuccessFactors-matched NL employers: two on the legacy portal (Heineken, dsm-firmenich), one Phenom (AkzoNobel), two Recruiting Marketing (SBM Offshore, Vistra).
- **[INFERENCE]** One GET of `/robots.txt` fingerprints the front end: SAP legacy has `Disallow: /*company`; Recruiting Marketing has `Disallow: /applybutton/` and `/talentcommunity/` (identical on two tenants); Phenom has `phenomtrack.min.js` and `lifeatphenom`. Sample of four.
- **[FACT]** Every content response I recorded on the three career sites carried `Cache-Control: no-cache, no-store, must-revalidate` (SBM Offshore and Vistra add `no-transform`), and none of the recorded responses had a `Last-Modified` header (ETag was not recorded). **[INFERENCE]** Each poll is therefore a full download.
- **[FACT]** The JSON-style endpoints are not open to a polite poller: `/services/` is disallowed on both Recruiting Marketing tenants (on Vistra the only `/services/` call I saw in the HTML was a `/services/t/l` tracking request), and the whole SAP legacy host is disallowed. AkzoNobel's landing HTML references a `/widgets` endpoint and a `refineSearch` call (once each); I did not call them (method rule) and their verb is **[NOT MEASURED]**. They are not needed here, because the GET page embeds the same job JSON.
- **[FACT]** Sitemap `lastmod` is one value for every URL on the two Recruiting Marketing tenants, and has 18 distinct values inside one week on Phenom, where a job with `postedDate` 2024-11-06 is still listed. **[INFERENCE]** It is a generation or refresh stamp, not a posting date.

## Recommendation

**Do not build a SuccessFactors adapter next; keep AG-013 on hold and cite this spike as the reason.** The route AG-013 scopes (SAP's DWR call on `career5.successfactors.eu`) is closed to any poller that obeys robots.txt, on all six SAP shards checked, and that is where two of the five SuccessFactors-matched Dutch employers (Heineken, dsm-firmenich) sit. The other three are reachable, but by three different parsers for at most three employers: Phenom's embedded JSON (AkzoNobel), Recruiting Marketing's server-rendered HTML (SBM Offshore), and for Vistra nothing beyond a sitemap of titles because its tenant renders results in the browser. That is a small, uneven yield against new-surface work plus per-tenant upkeep (the 4-8 hour estimate in the earlier scoping was for DWR, and a three-parser version would not be cheaper **[INFERENCE]**), and the failure mode is the one this repo already fears: Vistra's page parses to zero rows and would read exactly like an employer with no openings. The next hour for Tashi's supply is better spent on the $0 items already in the plan (B1, B2). The strongest argument against this: sitemap XML plus server-rendered HTML is public, cheap and similar across tenants, so a fingerprint-first "careers-site" adapter (Recruiting Marketing plus Phenom) could also reach employers outside this corpus, possibly some of the 77 with no corpus row in the 2026-09-08 audit; this spike did not test a single one of them, so I would fund that only as a separate, founder-approved bet, using the requirements below, and not as the next item.

## What a follow-up brief would need (only if that bet is funded)

1. **Founder decision on posture.** robots.txt allows `/sitemap.xml`, `/search/`, `/job/` (Recruiting Marketing) and `/<locale>/sitemap.xml`, `/<locale>/search-results`, `/<locale>/job/` (Phenom), but no Terms of Use were read. Decide per employer, and whether one sweep a day at 1 request/s is acceptable.
2. **A fingerprint step before any parser.** One GET of `/robots.txt` per employer classifies it (SAP legacy, Recruiting Marketing, Phenom, other); store the class on the registry row and pick the parser from it, never from the corpus label.
3. **Resolve Heineken and dsm-firmenich** from a non-guessed source (a link on their own careers page), or drop them.
4. **Fixtures from real pages**, one per surface: AkzoNobel `search-results` page 1 with its embedded JSON, SBM `/search/` page 1, Vistra's zero-row `/search/` page, one sitemap of each kind. Scrub the page tokens (`csrfToken`, `apiToken` in the Phenom HTML) before committing.
5. **Contract decisions the spike could not settle:** NL filter (Recruiting Marketing row location ends `, NL`; Phenom `country` uses ISO alpha-3 codes, `NLD` unconfirmed); dedup key (Vistra's sitemap id redirects to a different canonical id, SBM's resolved directly); posted date (Phenom `postedDate` vs `dateCreated`, Recruiting Marketing row date vs microdata `datePosted`, both unverified); requisition id (Phenom `reqId`; Recruiting Marketing unverified).
6. **Fail loud.** A page whose announced total (`Results 1 – 20 of 293`, `totalHits`) is above zero but parses to zero rows counts as a failed board, never "no openings". Compare the sitemap count with the search total on every sweep; a mismatch is a health signal.
7. **Politeness.** At most 1 request/s, honest User-Agent, one sweep per day, robots.txt re-read and obeyed each sweep, never `/services/`, `*/apply`, `/applybutton/`. Cost per sweep from this spike: about 16 requests for SBM, about 24 for AkzoNobel.
8. **Two measurements still owed:** whether Phenom has a GET facet that filters by country (to avoid paging the global list), and what the Vistra tenant's search actually calls (read once by a person in a normal browser's network tab; a poller must not call `/services/`).

## Not measured

- Every POST or JSON endpoint: Phenom `/widgets`, the `/services/` family on Recruiting Marketing tenants, SAP DWR. Excluded by the GET-only rule, and `/services/` and the SAP host are disallowed anyway. None was observed being called; the only traces are the strings `/widgets` and `refineSearch` (once each) in AkzoNobel's landing HTML.
- Heineken's and dsm-firmenich's job data, and whether either has a public site on its own domain.
- Terms of Use of all four sites.
- The population mix of the other 1,388 corpus rows; behaviour at higher request volume (no 403 or 429 appeared at 6 to 8 requests per host).
- Whether AkzoNobel's backend ATS is SuccessFactors; what Phenom `jobId` / `reqId` / `jobSeqNo` and Recruiting Marketing `customfield1` mean; which date field means "first posted".

## Appendix: every request (all GET, cold, no cookies, honest User-Agent)

| # | Host and path | Result |
|---|---|---|
| 0 | `raw.githubusercontent.com/kalil0321/ats-scrapers/main/ats-companies/successfactors.csv` | 200, `text/plain`, 78,280 B |
| 1 | `career5.successfactors.eu/robots.txt` | 200, 4 lines |
| 2-4 | `careers.akzonobel.com/robots.txt`, `/`, `/gb/en` | 200; 303 to `/gb/en`; 200 |
| 5 | `careers.sbmoffshore.com/robots.txt` | read timeout after 30 s, no response |
| 6-10 | `robots.txt` on `career2.successfactors.eu`, `career4.successfactors.com`, `career8.successfactors.com`, `career10.successfactors.com`, `career012.successfactors.eu` | 200, 59 B each, same 4 lines as #1 |
| 11-12 | `careers.sbmoffshore.com/robots.txt` (curl retry, then the script) | 200, 200 |
| 13-14 | `careers.akzonobel.com/nl/nl/sitemap.xml`, `/nl/nl/search-results` | 200, 200 |
| 15-19 | `careers.sbmoffshore.com/`, `/sitemap.xml`, `/search/?q=&startrow=0`, `/search/?q=&startrow=25`, `/job/Georgetown-Mechanical-Technician/1350318557/` | 200 each |
| 20-21 | `careers.akzonobel.com/nl/nl/search-results?from=10&s=1`, `/nl/nl/job/ANDANAGB55992EXTERNALNLNL/Sales-Assistant-Driver` | 200, 200 |
| 22-25 | `careers.vistra.com/robots.txt`, `/`, `/sitemap.xml`, `/search/?q=&startrow=0` | 200 each |
| 26-27 | `careers.vistra.com/job/Team-Lead%2C-FA/1440288433/`, then `/job/Team-Lead,-FA/18476-en_US/` | 302; 200 |
