# 2026-09-07 — widening board supply for the NL finance lane

## What we did

Grew the free board registry with Dutch employers that actually hire FP&A, audit,
KYC and accounting at 0-4 years, and added the two — only two — vocabulary terms
the previous day's measurement justified.

1. **A second employer list**, `docs/strategy/data/nl-finance-employers.csv`: 126
   curated brands across accountancy, banks, insurers/pensions, shared-service
   centres, trading, fintech, consultancy and finance staffing.
2. **A second join**, `--employers` on `pnpm jobhunt:import-boards`. Same corpora,
   same live verification, same append path as the IND-register import — only the
   list being joined changes.
3. **15 boards added**, 1,297 → 1,312. Rabobank, Deloitte Netherlands, BDO, NN
   Group, NIBC, PwC (two global sites), Euronext, Royal Vopak, Boskalis, Achmea,
   Blue Sky Group, Roland Berger, Ohpen, Elsevier.
4. **Two vocabulary terms** on the `finance-ops` track: "Finance Operations
   Specialist" and "Finance Operations Analyst".
5. **`IN-MARKET ON-TRACK`** now printed by `scripts/audit-track-coverage.ts`.

## What we fixed

- **The IND register cannot see Dutch finance.** The existing join keys the
  register's legal names against the corpora's brand names, which works for tech
  and fails for exactly the employers this lane needs: `Coöperatieve Rabobank
  U.A.` never matches a corpus row reading `Rabobank`, and `Deloitte Accountants`
  never matches `Deloitte Netherlands`. Both boards had been sitting unmatched in
  a corpus the importer already downloads.
- **A tenant's second Workday site was unreachable.** The corpus disambiguates by
  appending a site label — `Nn Group` and `Nn Group (Wdexternal)` — and keying on
  the label cost us the live board. Verified: `nngroup/wd3/external` answers with
  zero postings; `nngroup/wd3/wdexternal` answers with The Hague and Rotterdam.
  `stripSiteSuffix` fixes it, for the employer join only.
- **A brand is not a country.** `boardMatchKey("Deloitte Netherlands")` and
  `boardMatchKey("Deloitte Nordic")` both reduce toward `deloitte`, and all of
  Deloitte's country boards are live, so liveness alone cannot separate them. The
  postings can: a candidate that answers with no Dutch work is another country's
  site. That check rejected 24 of 39 candidates, including a `bamboohr/vdl` that
  turned out to be a US metalworking firm in Georgia, not VDL Groep in Eindhoven.

## Why

The founder's own measurement, 2026-09-07: her lane's problem is supply, not
vocabulary. Of 4,511 postings sampled across 120 boards, 177 were in the
Netherlands at all, and of the 174 NL postings her classifier dropped, exactly one
was both finance-shaped and inside her 0-4-year range. The registry is
overwhelmingly tech companies on Greenhouse/Lever/Ashby, and a tech company in NL
posts roughly one junior finance role per fifty engineering ones.

This is why nothing was added to her keywords beyond the two terms the audit
named. The measurement is the argument for both halves: widen the employers,
leave the vocabulary alone.

## Metrics

Full registry, both profiles, `audit-track-coverage.ts --boards 2000`. The metric
is in-market on-track postings per sweep — classified, minus those outside the
profile's target markets.

| | before (1,297 boards) | after (1,312 boards) | Δ |
|---|---|---|---|
| **Tashi** `wife-nl-finance` | 55 | **84** | **+29 (+53%)** |
| Pushkar `pushkar-nl-tech` | 1,635 | 1,653 | +18 (+1%) |
| postings seen | 47,131 | 47,864 | +733 |

Attribution, measured by polling the 15 new boards alone: **27 in-market on-track
postings, of which 0 came via the two new vocabulary terms.** The boards did the
work; the vocabulary contributed nothing this sweep, exactly as the audit
predicted. All 15 verified live, 0 failures.

What the new boards actually surface, first sweep: `Accountant in Opleiding -
Audit` (Deloitte NL's graduate audit track, seven cities), `Assistent Accountant
MKB - HBO`, `KYC analist NN Bank` (The Hague), `Senior Auditor: Insurance and
Pension` (Amsterdam), `(Senior) Consultant - Finance Business Partner` (Utrecht).

## Outstanding

- **85 of 126 curated brands have NO CORPUS ROW on any of the ten platforms** —
  ABN AMRO, Aegon, KPMG, EY, Heineken, AkzoNobel, Ahold Delhaize, a.s.r., PGGM,
  Triodos, Van Lanschot, de Volksbank, and every finance staffing agency
  (Michael Page, Robert Half, Hays, Undutchables). They are on SuccessFactors,
  Taleo or bespoke career sites. This is the ceiling on the current mechanism,
  and it is where the next real gain sits: a SuccessFactors corpus exists
  upstream (1,393 rows, fetched and confirmed 2026-09-07) with no adapter here.
  Adapter work, not list work — deliberately NOT started in this session.
- Shell (`workday/shell/wd3/shellcareers`) and KLM (`workable/klm-careers-3`) are
  matched and live but were skipped: Shell's freshest 40 postings carry no Dutch
  role, and the KLM board returns zero postings. The import is re-runnable, so
  both are picked up on the next run if that changes.
