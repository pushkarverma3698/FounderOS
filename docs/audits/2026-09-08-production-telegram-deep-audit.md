# Production Telegram Chat Deep Audit Report

**Date:** 2026-09-08  
**Scope:** 7,389 production Telegram messages (Message ID #1429 through #9834)  
**Branch:** `antigravity/fix-telegram-chat-audit`  
**Dataset:** MTProto chat dump from Hetzner VPS (`@Raggae3698_bot`)

---

## Executive Summary

An exhaustive empirical audit was conducted on the full production Telegram chat between Founder Pushkar Verma and FounderOS (**7,389 messages** total: 5,722 bot messages, 1,667 user messages).

1. **Link Verification Audit:**
   - **895 total link occurrences** across the chat; **293 unique HTTP/HTTPS URLs** were provided to the founder.
   - **68 unique URLs (23.2%) are dead, broken, or problematic**:
     - **48 HTTP 404 Not Found** (including 22 GitHub URLs and 16 ATS job postings)
     - **7 Network / Connection Failures** (`localhost:4000`, `127.0.0.1`, `YOUR_VPS_IP` placeholder sent to mobile client)
     - **5 Expired Google Search Grounding Redirects** (`vertexaisearch.cloud.google.com/grounding-api-redirect/...`)
     - **4 HTTP 401 Unauthorized** (Indeed job view links requiring login)
     - **3 HTTP 403 Forbidden** (W3C SVG namespace, Dyson careers blocking requests without browser User-Agent)
     - **3 HTTP 500 Internal Server Error** (Workday careers homepages / malformed job paths)
     - **2 HTTP 410 Gone** (Expired Workable postings)
     - **1 HTTP 999** (LinkedIn scraping blocker)
   - **43 Pseudo-Link Glitches**: Plaintext filenames like `README.md`, `BRAND.md`, and `primes.py` were sent without backticks, causing Telegram to auto-link `.md` (Moldova) and `.py` (Paraguay) as dead website links.
   - **URL Fabrication / Hallucination**: In message #9802, when asked for application URLs, the bot fabricated 16 non-existent URLs for Workday, Lever, and SmartRecruiters.
   - **Parenthesis / Markdown Truncation**: URLs with parentheses (e.g. Workable URLs containing `-(typescript)-`) were truncated at the first `)` by Telegram's markdown/URL parser.
   - **Bracket Leaks**: Markdown square brackets leaked into URLs (`[https://github.com/pushkarverma3698/FounderOS]`), causing 404s when tapped.

2. **Systemic Bot Bugs Identified:**
   - **Spam Loop #1 (pr-brain auth alert)**: The notification `🧠 pr-brain STOPPED on founder-os: Claude Code auth expired` repeated **1,590 times** (every 20 minutes for weeks), consuming over 21% of the entire chat history.
   - **Spam Loop #2 (Reboot broadcasts)**: `🚀 FounderOS is back online` broadcasted **373 times** to the founder's chat on every container restart, health check, or crash recovery.
   - **Spam Loop #3 (Infinite PR Gate retry)**: `⚠️ Gate FAILED to complete — founderos#438` repeated **202 times** because failed PR sweeps were left unstamped without backoff.
   - **Spam Loop #4 (Un-deduped Job Alerts)**: `🎯 N jobs ready to apply` repeated **384 times**, spamming the exact same job listings repeatedly on every sweep.
   - **Single Board 404 Aborts Whole Sweep**: `⚠ Free job lane failed — nothing was screened this sweep. greenhouse/crcevans: HTTP 404` fired 28 times because one dead board in the registry crashed the entire multi-board sweep.
   - **False Alarm Funnel Alerts**: Alerts claimed "The funnel may be restricted or closed" even when candidates were merely "already known in tracker" (normal status when all current postings have already been screened).
   - **Message Truncation (96 occurrences)**: Bot replies cut off mid-word or mid-sentence with `…` or `1. Pe…` due to 4000/1500 char slicing and lack of multi-chunk fallback.
   - **Unrendered LaTeX Math**: Raw formulas like `$$ ext{Duration} = rac{13,000}{21.2} approx 613$$` sent to Telegram instead of readable plain text.
   - **Internal Exception Leaks**: Uncaught errors (`TypeError: Cannot read properties of undefined (reading 'length')` and GoogleGenAI API failures) leaked directly to the user.

---

## Detailed Findings

### 1. Link Reachability & Dead Links Analysis

| Category | Count | Primary Causes | Sample Message IDs |
|---|---|---|---|
| **Hallucinated ATS URLs** | 16 | The model invented slugs (e.g. `jobs.lever.co/vendavo/Senior-Financial-Analyst`, `jobs.smartrecruiters.com/SGS/AP-Accountant`, `rsm.wd3.myworkdayjobs.com/...`) instead of reading database `job_applications.url`. | #9802 |
| **Trailing Syntax Leak (Brackets/Punctuation)** | 10 | The bot wrapped URLs in square brackets `[https://github.com/.../FounderOS]`; Telegram parsed `]` as part of the URL. | #1768, #2125, #2183, #2227, #2428, #2520, #3326, #3920, #3944, #4379 |
| **Parenthesis-Truncated URLs** | 2 | URLs containing parentheses (e.g. `.../remote-full-stack-engineer-(typescript)-in-boston...`) broke Telegram's parser at the closing `)`. | #5739 |
| **Localhost / Dummy IP URLs** | 4 | Bot provided `http://localhost:4000`, `http://127.0.0.1/...`, or `http://YOUR_VPS_IP/...` which cannot be accessed on the founder's phone. | #2127, #3419, #3910 |
| **Expired Search Grounding Redirects** | 5 | Google Vertex AI / Gemini Search Grounding returned ephemeral redirect tokens (`vertexaisearch.cloud.google.com/grounding-api-redirect/...`) that expire after hours/days. | #3737, #4235, #4236 |
| **Expired / Stale ATS Job Links** | 12 | Roles on Workable, Lever, Recruitee, and Greenhouse filled or taken down (HTTP 404/410) after initial ingestion. | #5485, #5488, #5499, #5500, #7287 |
| **Missing User-Agent Headers** | 4 | ATS platforms (Workday, Dyson, etc.) reject Node requests without a browser User-Agent with HTTP 403 or 500. | #9795, #9802 |
| **Filename TLD Autolink Glitch** | 43 | Plaintext filenames like `README.md`, `BRAND.md`, and `primes.py` treated as TLDs (.md, .py) by Telegram mobile clients. | #1943, #2290, #2304, #2337 |

### 2. Deep Chat Bug Analysis

#### Bug 1: `pr-brain` Unthrottled Auth Notification Storm (1,590 messages)
- **Manifestation:** Every 20 minutes, `pr-brain STOPPED on founder-os: Claude Code auth expired` was sent to Telegram.
- **Root Cause:** In `$HOME/bin/pr-brain`, when the preflight check fails (`case "$preflight" in *"authenticate"*`), it calls `notify "..."` with zero rate-limiting, deduplication, or state-file checks.
- **Fix Required:** Add a state-file check in `pr-brain` (e.g. `/tmp/pr-brain-auth-alerted.stamp`) to alert at most once per 24 hours, or only on state transition.

#### Bug 2: PR #438 Infinite Sweep Retry Loop (202 messages)
- **Manifestation:** `⚠️ Gate FAILED to complete — founderos#438. Left unstamped; next sweep retries.` repeated 202 times over 67 hours.
- **Root Cause:** `pr-brain` left failed PRs unstamped without recording an exponential backoff or failure counter, retrying every single 20-minute cron sweep indefinitely.

#### Bug 3: Bot Reboot Announcement Noise (373 messages)
- **Manifestation:** Every time the bot process started, it broadcast `🚀 FounderOS is back online` with an 8-line department summary into the founder's chat.
- **Root Cause:** In `src/index.ts` (or boot lifecycle), the startup greeting had no cooldown or environment check, firing on container restarts, health check bounces, and redeploys.

#### Bug 4: Repeated Job Alerts Without State Diffing (384 messages)
- **Manifestation:** The notification `🎯 39 jobs ready to apply` (and earlier 7 jobs, 10 jobs, 60 jobs) was sent repeatedly across consecutive sweeps even when no new jobs had been discovered.
- **Root Cause:** The job notification trigger compared only count thresholds or ran on cron intervals without checking whether the candidate set had changed since the last notification.

#### Bug 5: Closed Funnel False Alarm on Stale Boards
- **Manifestation:** `⚠ Job lane funnel alert for Tashi Goyal — 0 candidates passed for 6 consecutive sweeps (the last 19 died at: already known in tracker). The funnel may be restricted or closed.`
- **Root Cause:** In `src/tools/jobhunt/sweep-heartbeat.ts`, `afterQuietSweep` increments `zeroPassStreak` whenever 0 *new* candidates pass, even if 19 valid candidates were screened and rejected solely because they were already present in `job_applications`. The board was not closed; it simply had no new postings.

#### Bug 6: Bot Message Truncation & Drop (96 occurrences)
- **Manifestation:** Messages cut off mid-word (e.g. `1. Pe…` or `witho…`).
- **Root Cause:**
  1. In `src/gateway/kernel-run.ts:97`, the error-fallback handler executed `await ctx.reply(text.slice(0, 4000));` dropping everything past character 4000 instead of splitting into chunks.
  2. In `scripts/telegram-tester.ts:127`, `m.text.slice(0, 1500) + "…"` truncated local terminal rendering.
  3. LLM token limits when generating exhaustive multi-job lists.

#### Bug 7: Raw LaTeX Math Output
- **Manifestation:** In message #9819: `$$ ext{Duration} =  rac{13,000}{21.2} approx 613  ext{ seconds } (sim 10.2  ext{ minutes})$$`.
- **Root Cause:** The LLM outputs LaTeX math blocks for calculations, but Telegram has no KaTeX/LaTeX renderer.

---

## Action Plan & Code Changes on Branch `antigravity/fix-telegram-chat-audit`

1. **Fix URL Encoding & Markdown Link Guard in `src/tools/jobhunt/telegram-format.ts`**:
   - URL-encode parentheses (`%28` and `%29`) in all outgoing links to prevent Telegram parser truncation.
   - Clean trailing brackets and punctuation from links.
2. **Fix Fallback Message Chunking in `src/gateway/kernel-run.ts`**:
   - Replace `text.slice(0, 4000)` with full chunking so messages over 4,000 characters are never sliced or dropped.
3. **Fix Funnel Alert False Positives in `src/tools/jobhunt/sweep-heartbeat.ts`**:
   - Do not treat "already known in tracker" as a closed funnel. Only increment `zeroPassStreak` if zero candidates were retrieved or all died at hard platform gates.
4. **Add Browser User-Agent and Soft-404 Body Checks in `src/tools/jobhunt/liveness.ts`**:
   - Add standard browser `User-Agent` to prevent HTTP 403 blocks from Workday/Cloudflare.
   - Check response bodies for soft-404 closures ("position is closed", "no longer accepting applications").
5. **Add LaTeX-to-Text Sanitizer in `src/kernel/synthesizer.ts` & `src/gateway/kernel-run.ts`**:
   - Clean LaTeX math formatting (`$$`, `\frac`, etc.) into clean plain text for Telegram.
6. **Wrap Filenames in Code Chips to Prevent TLD Autolinking**:
   - Ensure files ending in `.md`, `.py`, etc. are emitted with `<code>` tags.
