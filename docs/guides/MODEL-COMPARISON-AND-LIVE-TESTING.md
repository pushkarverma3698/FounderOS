# Model Comparison & Live Testing — Flash vs Pro (Reliability Trial)

**Purpose:** give the founder an exact, repeatable procedure to decide whether the
runtime product's loop + hallucination problems are **model-driven** (fixed by a
stronger model) or **architecture-driven** (need code changes), by changing ONE
variable — the model — and measuring the same task battery.

**Status:** prod is pinned to `openrouter:google/gemini-2.5-pro` (deploy.yml).
The Flash baseline is `openrouter:google/gemini-2.5-flash`. This doc is the runbook
for producing the numbers, and records what we already know so the live run only has
to confirm/deny.

---

## 1. The comparison — what we already know (confirm live, don't rediscover)

| Dimension | Gemini 2.5 **Flash** (old prod) | Gemini 2.5 **Pro** (new prod) |
|---|---|---|
| **Price — input** | $0.075 / 1M tokens | $1.25 / 1M tokens (**~17×**) |
| **Price — output** | $0.30 / 1M tokens | $10.00 / 1M tokens (**~33×**) |
| **Typical agent turn (output-heavy)** | baseline | **~30× cost** of Flash |
| **Agentic tool-calling** | Weak — the documented root cause of most repeat-guard / execution-guard scar tissue. Loops on identical read calls; sometimes answers instead of calling a tool. | Strong — built for multi-step tool use / reasoning. Expected to loop far less and honour tool calls. |
| **Loop behaviour** | Spins on the same `(tool,input)` until `GraphRecursionError` (limit 40) unless a guard stops it. | Expected: rarely repeats an identical successful call; should terminate on its own. |
| **False "Done."** | Occasionally claims completion without the backing tool call (execution-guard catches the covered cases). | Expected: much lower rate; better at actually finishing. |
| **Budget tracking** | priced in `budget.ts` | priced in `budget.ts:41` ($1.25 / $10) — per-turn `usd` stays accurate |

**These are hypotheses about Pro** — the live run (§4) turns them into evidence.

**Cost-reclaim path once Pro is proven** (do NOT do it during the trial — it adds a
second variable): set `WORKER_AGENT_MODEL=openrouter:google/gemini-2.5-flash` so the
strong Pro model runs only on the **supervisor** (routing, where reliability matters)
and cheap Flash runs the **workers** (tool-calling inside an already-chosen dept).
See `src/agents/model.ts` `getWorkerModel()`.

---

## 2. What you need before testing (creds)

Everything runs on the **VPS** (or any box with the paid key) — it CANNOT run in the
Claude Code sandbox because there are no paid API keys here.

Required in `/opt/founderos/.env` (the deploy renders most of these from `PROD_DOTENV`):

| Var | Why |
|---|---|
| `OPENROUTER_API_KEY` | the paid key both models route through |
| `AGENT_MODEL` | the model under test — flipped between the two values below |
| `DATABASE_URL` | Postgres — `action_log`, HITL, dept_signals (evidence rows) |
| `TELEGRAM_BOT_TOKEN` | the live bot |
| `TELEGRAM_TESTER_SESSION` | MTProto session so the harness can drive the bot **as the founder** (one-time `scripts/telegram-tester.ts login`) |
| `GOOGLE_GENERATIVE_AI_API_KEY` | only if `search_web` grounding / any `google-genai:` path is used |

> If any is missing, the run is **NOT VERIFIED** — say so, don't infer a result.

---

## 3. The A/B procedure (change one variable)

Run the **identical** task battery twice — once on each model. Do it on the VPS.

```bash
cd /opt/founderos

# --- Baseline: Flash -----------------------------------------------------------
# Temporarily override the pinned model for this run only.
export AGENT_MODEL=openrouter:google/gemini-2.5-flash
pnpm eval 2>&1 | tee /tmp/eval-flash.txt          # routing/tool/HITL golden set

# Drive the REAL gateway as the founder (send + tap Approve/Reject over MTProto):
npx tsx scripts/e2e-telegram-qa.ts run all 2>&1 | tee /tmp/qa-flash.txt

# --- Candidate: Pro ------------------------------------------------------------
export AGENT_MODEL=openrouter:google/gemini-2.5-pro
pnpm eval 2>&1 | tee /tmp/eval-pro.txt
npx tsx scripts/e2e-telegram-qa.ts run all 2>&1 | tee /tmp/qa-pro.txt
```

> The deploy always **force-writes** `AGENT_MODEL` back to Pro (deploy.yml). So an
> `export` here is a safe, temporary local override for the measurement — the next
> deploy resets it. To make Flash the real prod model again, change `deploy.yml`.

Single-task probes (faster, office-level, still real model — use for drilling into a
specific misroute or loop, not for gateway-loop bugs):

```bash
npx tsx scripts/probe-real-task.ts "list my GitHub repositories"      # loop-bait read
npx tsx scripts/telegram-tester.ts send "email the client the proposal"  # send path
```

---

## 4. What to measure (the decision metrics)

For each model, from the QA output + the live log (`/tmp/founderos.log`) + Postgres:

| Metric | How to read it | Model win = |
|---|---|---|
| **`GraphRecursionError` count** on loop-bait reads (e.g. "list my repos") | `grep -c "GraphRecursionError" /tmp/founderos.log`; target is **0×** | fewer |
| **Guard fires** — `guard.retry`, `guard.blocked`, repeat-guard short-circuits | `grep -cE "guard\.(retry\|blocked)" /tmp/founderos.log` | fewer (model needed less rescuing) |
| **False "Done." rate** | per QA task: bot said ✅ but there is **NO** matching `action_log` row | lower |
| **Task-completion rate** | QA task actually produced the right outcome + audit row | higher |
| **Cost / turn** | `grep "turn.out" /tmp/founderos.log` → per-turn `usd` (greppable by `turnId`) | the honest price of the reliability |
| **Routing accuracy** | `pnpm eval` routing score — did the right department get picked | not regressed |

**Evidence standard (rule #24):** for every "it works" claim, paste the exact bot
reply text **plus** the matching `action_log` row (or an explicit "NO ROW"). A
friendly "✅ Done." with no audit row is a FAIL, not a pass.

**The decision:**
- Pro drops `GraphRecursionError` to ~0, cuts guard fires and false-dones sharply, and
  routing holds → **the problem was mostly the model.** Keep Pro; then optimise cost
  with `WORKER_AGENT_MODEL=…flash`; then start *removing* now-redundant guards.
- Pro still loops / still fakes completion on the same tasks → **the problem is
  architectural** (sealed prebuilt graph forcing all reliability logic to the gateway
  boundary). That's the trigger to revisit "Architecture is LOCKED".

---

## 5. The loop-honesty guard (shipped alongside this trial)

Independent of the model, the identical-call breaker (`repeat-guard.ts`) — previously
only on `github_read` — now wraps every loop-prone read: `search_web`, `read_emails`,
`read_file`, `list_dir`, `read_cv`, `search_jobs`. When a read is called with the
**same arguments** 3× inside one turn, it is short-circuited with an **honest**
terminal message (`repeatGuardBlockMessage`) that tells the model: *you are going in
circles, stop, answer with what you have, and if it doesn't satisfy the request say so
plainly — do NOT claim the task is complete.*

This means "even when it loops without crashing, the model is told it is looping and
pushed to be honest rather than hallucinate a completion." It fires identically for
both models, so it does **not** confound the §4 routing/tool-quality comparison — it
only changes what happens **after** a loop has already started, and the *guard-fire
count* itself becomes one of the comparison signals (fewer fires = better model).
