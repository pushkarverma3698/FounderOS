# Jobhunt daily supply audit: why Tashi gets ~5 roles a day, and Pushkar's NL lane

**Date:** 2026-10-05 · **Scope:** `wife-nl-finance` and `pushkar-nl-tech`, free board lane · **Code:** `origin/main` @ `1deb68d2` (= prod)

## Answer

Nothing in the pipeline is broken. Sweeps run every 15 minutes (94–96 a day), see ~82k postings each, and only 5–9 boards fail per sweep. **The lane is short of supply.** Across all 3,223 boards we poll, only **24 Dutch postings published in the last 7 days match Tashi's tracks** (≈3 a day). LinkedIn showed **673 a week** for her titles in NL (measured 2026-09-28). We see about 3% of her market.

## Measurements

### Prod, `agents.job_applications`, last 14 days

| Profile | NL rows | NL pass | India rows | Unknown |
|---|---:|---:|---:|---:|
| Tashi | 65 (≈4.6/day) | 19 (≈1.4/day) | 162 | 17 |
| Pushkar | 97 (≈7/day) | 56 (≈4/day) | 761 | 263 |

Weekend dips (Sat/Sun) are normal. Pushkar's weekday volume fell from ~120 to ~50–90 rows/day since 1 Oct. Sweep health is unchanged (seen ~82k/sweep, failures down after the dead-board skip), so the drop tracks new publications, not a fault.

### Live sweep, all 3,223 boards, production adapters and filters ($0, 290 s, 80,620 postings, 37 board failures)

| | Tashi | Pushkar |
|---|---:|---:|
| Dutch postings, any role, ≤ 7 days | 490 | 490 |
| …on-track for the profile | 24 | 38 |
| Kept after the 30-day window, NL | 58 | 117 |
| Kept, India | 74 | 526 |

### Why her NL rows get rejected (prod, last 14 days, 28 NL rejects)

- **Dutch required: 12.** BDO Transfer Pricing ×2, BDO Internal Audit, Deloitte IT Audit, Deloitte Finance Strategy ×3, PwC Indirect Tax, NN Business Controller and others. These are real fits blocked only by the language.
- **Experience 6+ years or Manager/Principal title: ~14.** Correct rejects.
- **Internship or working student: 2.** Correct.

## Causes, ranked

1. **Corpus (the main cause).** Only ~41 of the ~126 curated NL finance brands (`nl-finance-employers.csv`) are on a board we poll. ABN AMRO, KPMG, EY, Aegon, a.s.r., PGGM, Heineken, de Volksbank and others run SAP SuccessFactors, Taleo, Phenom or their own sites. The SuccessFactors spike (`docs/audits/2026-09-29-successfactors-feed-spike.md`) found no single adapter for these: SAP's legacy portal blocks crawlers in robots.txt, and the rest run on three different front ends.
2. **Dutch-language gate.** 43% of her NL rejects. The rule is correct until we know her Dutch level, and that answer has been pending since 2026-09-28.
3. **Vocabulary (small).** Among this week's 490 Dutch postings, about 6–8 fits are still off-track: Adyen "Finance Support Specialist" and "Internal Control Specialist", Deloitte "Analyst Regulatory Risk & Compliance", ING "Junior Business Analyst COO Risk", Flexport "Operations Controller", BDO "Senior Consultant Corporate Finance", Medtronic "Senior Compliance Specialist", Rabobank "Risk Consultant". Fixing these adds about 1 role a day.

## A correction to the plan for S4 (Indeed for Tashi)

`INDEED_REMOTE.NL = "remote"` (`src/tools/jobhunt/ingest-pools.ts`), and `runJobIngestSweep` takes no profile, so it runs for the default profile only. **Turning the metered cron back on would not reach Tashi's on-site Dutch roles.** S4 needs a per-profile NL query without the remote filter, not just the cron line.

## Pushkar

His NL lane has the same corpus limit: 38 on-track Dutch postings a week, ~4 NL passes a day. 70% of his rows are Indian, which matches the profile (`india-local`). 1,799 UK and 73 DE boards (58% of the registry) serve a market neither profile targets. They cost sweep time but don't reduce anyone's supply.

## Next steps

| # | Change | Gain | Needs |
|---|---|---|---|
| 1 | Her Dutch level → language gate | Up to ~12 NL rows / 14 days stop rejecting (if she has B1+) | Founder answer |
| 2 | Indeed NL on-site for Tashi only (per-profile metered run) | Reaches ABN AMRO / KPMG / EY-class employers | Founder approval (paid, ~cents/month) + ~2h build |
| 3 | Vocabulary terms from cause 3, pinned in `tashi-track-recall.test.ts` | ~+1 role a day | Claude, ~1h, $0 |
| 4 | Phenom / SF Recruiting Marketing sitemap adapter (AkzoNobel, SBM, Vistra-class) | A few employers each | ~1 day |
