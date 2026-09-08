# 2026-09-08 — Production Telegram Chat Deep Audit & Link/Alert Resilience Fixes

## What we did

Conducted an exhaustive, empirical audit of the complete production Telegram chat history between the founder (Pushkar Verma) and FounderOS (`@Raggae3698_bot`). The entire message history across MTProto (**7,389 total messages**: 5,722 bot messages and 1,667 user messages, from message #1429 through #9834) was dumped to disk and audited using custom-built deterministic analysis tools.

Every HTTP/HTTPS URL sent to the founder was extracted and tested for HTTP status and soft errors:
- **293 unique URLs** across **895 total link occurrences** were probed.
- **68 problematic/dead URLs** were identified (**23.2% failure rate**).
- **43 pseudo-link glitches** were identified (bare filenames autolinked as foreign TLDs).
- **38 distinct bug and spam categories** were cataloged across the 7,389 messages.

All code fixes were developed in branch `antigravity/fix-telegram-chat-audit`, verified via `pnpm gate` (346 test files, 3,806 tests passing), and submitted via draft PR #632 to `beta`.

---

## 1. Dead Link & URL Glitch Taxonomy

| Class | Count | Example Message IDs | Root Cause | Impact |
|---|---|---|---|---|
| **Hallucinated URLs** | 16 | #9802, #9806 | The LLM was asked to show screened/rejected jobs for Tashi Goyal. The underlying tool omitted the canonical URL from the text summary, so the synthesizer hallucinated plausible ATS paths (`jobs.lever.co/vendavo/...`, `rsm.wd3.myworkdayjobs.com/...`). | User clicked link and got 404. Damaged trust in agent's reporting. |
| **Trailing Bracket Poisoning** | 22 | #1768, #2125, #2127 | Formatted as `[https://github.com/.../FounderOS]`. Telegram parsed the closing `]` as part of the URL path (`.../FounderOS]`), resulting in GitHub 404. | Every bare bracketed URL failed to open. |
| **Pseudo-Link TLD Glitches** | 43 | #1943, #2290, #2429 | Files like `README.md`, `primes.py`, `agent.ai` sent as plain text. Telegram parsed `.md` (Moldova) and `.py` (Paraguay) as clickable top-level domain links. | Distracting, broken hyperlinks to non-existent web domains. |
| **Parenthesis Truncation** | 2 | #5739 | ATS URLs containing parentheses (e.g. `-(typescript)-`). Markdown parser terminated the link at the first closing parenthesis `)`. | 404 Not Found on employer site. |
| **Localhost / Dummy URLs** | 4 | #2127, #3419, #3910 | Sent `http://localhost:4000` and `http://YOUR_VPS_IP/...` to the founder's phone. | Unroutable on mobile device. |
| **Expired Google Redirects** | 5 | #3737, #4235 | `vertexaisearch.cloud.google.com/grounding-api-redirect/...` expired after brief TTL. | Ephemeral search redirects died. |
| **Stale / Taken Down ATS Jobs** | 12 | #5485, #5488, #5500 | Real jobs filled or closed on employer ATS without proactive soft-404 detection. | User opened filled job. |

---

## 2. Systemic Bugs & Noise Loops Cataloged

1. **Runaway Auth Expiration Spam (1,590 messages — 27.8% of all bot messages)**:
   - Message text: `🧠 pr-brain STOPPED on founder-os: Claude Code auth expired. Run 'claude login' on the VPS to resume.`
   - Cause: `/home/founderos/bin/pr-brain:137` in VPS crontab ran every 20 minutes with no deduplication or throttling state file.
2. **Reboot Broadcast Spam (373 messages)**:
   - Message text: `🚀 FounderOS is back online`
   - Cause: Broadcasted on every process restart, health check recovery, or deploy.
3. **PR #438 Infinite Review Retry Loop (202 messages)**:
   - Cause: An unmergable PR was retried on every single cron sweep without an exponential backoff circuit breaker.
4. **Un-deduped Job Pipeline Alerts (384 messages)**:
   - Message text: `🎯 39 jobs ready to apply` repeated across multiple sweeps without delta diffing.
5. **Single-Board 404 Aborting Multi-Board Sweep (28 messages)**:
   - `probe-sponsor-boards.ts` aborted the entire multi-board sweep when `greenhouse/crcevans` returned HTTP 404 instead of skipping that board.
6. **False Alarm Funnel Alerts**:
   - `sweep-heartbeat.ts` warned of a dead funnel (`0 passed`) when candidates were simply already tracked in the database.
7. **Message Truncation at 4,000 Characters (96 messages)**:
   - Long fallback responses were abruptly sliced at index 4000 (`text.slice(0, 4000) + '…'`), losing actionable tables and instructions.
8. **Unrendered LaTeX Math (#9819)**:
   - Raw `$$ ext{Duration} = \frac{ ext{Lines}}{...} \approx 6.4 ext{ hours}$$` was dumped directly into chat without plain-text rendering.

---

## 3. What We Fixed in Code

### Fix 1: Telegram URL Sanitization (`src/tools/jobhunt/telegram-format.ts`)
- Added `sanitizeTelegramUrl()`:
  - Trims trailing punctuation (`]`, `)`, `.`, `,`, `;`, `:`, `>`).
  - Percent-encodes internal parentheses (`(` -> `%28`, `)` -> `%29`) so Telegram's markdown parser does not terminate URLs prematurely.
- Wrapped all outbound links through `sanitizeTelegramUrl(targetUrl)`.

### Fix 2: LaTeX Math & Pseudo-Link Cleaning (`src/gateway/format.ts`)
- Added `cleanLatexMath()`:
  - Converts display math `$$...$$` and inline math `$...$` into readable plain text (e.g. `\frac{a}{b}` -> `a / b`, `\approx` -> `≈`, `\times` -> `×`).
- Added bare code filename chip formatting:
  - Regex detects bare references to `[a-zA-Z0-9_-]+\.(md|py|sh|ts|js|json|yml|yaml|sql)` and wraps them in `<code>...</code>` so Telegram stops treating them as country TLDs.
- Cleaned bracketed links `[https://...]` into standard markdown `https://...`.

### Fix 3: Message Fallback Chunking (`src/gateway/kernel-run.ts`, `mission-resume.ts`, `scheduled-task-run.ts`)
- Replaced naive `cleanHtml(text).slice(0, 4000)` with `splitForTelegram(cleanHtml(text))`.
- When HTML parsing fails or text exceeds Telegram limits, messages are chunked and delivered sequentially rather than truncated mid-sentence.

### Fix 4: False-Alarm Funnel Alert Suppression (`src/tools/jobhunt/sweep-heartbeat.ts`)
- The heartbeat alert `⚠ Job lane funnel alert` checked `heartbeat.candidatesPassed === 0`.
- If 10 candidates entered the funnel and all 10 were dropped because they were `"already known in tracker"`, the funnel is healthy, not broken.
- Now checks `reasons["already known in tracker"] ?? 0`. If all dropped candidates were duplicates, `zeroPassStreak` is reset to 0.

### Fix 5: Proactive ATS Liveness Headers & Soft-404 Detection (`src/tools/jobhunt/liveness.ts`)
- Added browser `User-Agent` and `Accept` headers to prevent bot-detection 403 blocks during liveness checks.
- Added body inspection for soft-404 text ("This job has been closed", "No longer accepting applications", "This position has been filled", "Job expired").

### Fix 6: Strict Anti-Hallucination Prompting (`src/kernel/synthesizer.ts`)
- Updated `SYNTHESIZER_PROMPT` to explicitly instruct:
  `"NEVER fabricate or guess URLs. Only include a hyperlink if an exact URL was returned by a tool. If no URL is provided, output the entity name in plain text without a link."`

### Fix 7: Full Telegram Tester Message Display (`scripts/telegram-tester.ts`)
- Removed `m.text.slice(0, 1500) + "…"` from `printMessage()` so diagnostics display complete message content.

### Fix 8: Durable Audit Tooling Added to Repo
- `scripts/dump-chat.ts`: Fetches all messages from MTProto with rate-limiting, sender classification, and pagination.
- `scripts/analyze-telegram-chat.ts`: Extracts all URLs, probes HTTP status, detects malformed punctuation and pseudo-links.
- `scripts/deep-chat-bug-audit.ts`: Analyzes chat history across 38 failure patterns and exports message metrics.

---

## 4. Verification Evidence

1. **Local Architecture & Branch Verification**:
   ```bash
   bash scripts/verify-branch-name.sh
   # verify:branch — OK: 'antigravity/fix-telegram-chat-audit'
   ```
2. **Typecheck & Lint**:
   ```bash
   pnpm lint
   # tsc --noEmit && tsc -p tsconfig.test.json -> 0 errors
   ```
3. **Full Suite Unit Tests**:
   ```bash
   pnpm gate
   # Test Files  346 passed (346)
   # Tests       3806 passed (3806)
   ```
   - Added unit tests in `tests/unit/gateway/format.test.ts` (LaTeX math cleaning, code chips for filenames, bracketed URLs).
   - Added unit tests in `tests/unit/jobhunt/sweep-heartbeat.test.ts` (already-known candidate streak reset).
   - Added unit tests in `tests/unit/jobhunt/telegram-format.test.ts` (parenthesis encoding, trailing punctuation stripping).
4. **Brain Sync**:
   ```bash
   pnpm brain:sync
   # Sync complete: 134 docs current
   ```
5. **Draft Pull Request**:
   - Branch: `antigravity/fix-telegram-chat-audit`
   - PR: https://github.com/pushkarverma3698/FounderOS/pull/632 targeting `beta`.
