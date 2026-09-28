# CLAUDE.md rules — full text and incident history

Moved verbatim from `CLAUDE.md` on 2026-09-28 (PR docs/claude-md-trim). `CLAUDE.md` keeps each rule in one or two lines plus what enforces it; this file keeps the reasoning and the incidents that produced each rule. When a rule in CLAUDE.md seems odd, read its entry here before changing it.

## Engineering rules (#24–#26 and carried v2 rules)

- **Evidence over assertion (rule #24)**: "done" = the verification command run
  fresh in the same session with output shown. Unit tests are necessary, not
  sufficient — exercise the real path (gateway → kernel → tool → reply →
  action_log row) before claiming anything works. Unverifiable ⇒ say
  "NOT VERIFIED — reason".
  - **"Gateway" means the real Telegram transport, not a shortcut that starts
    one layer in.** Calling a tool's `.execute()` directly over SSH proves the
    tool; it does not prove the planner routed to it, the prompt passed the
    right profile, or the reply the founder actually sees is correct — that gap
    is exactly where the 2026-09-06/07 bugs (`job_state`, the dead judge model,
    the missing Tashi heartbeat) lived, undetected by tool-level tests alone.
    **Founder directive, 2026-09-07: after fixing and unit-testing anything in
    the jobhunt/gateway path, drive it through Telegram before calling it
    done.** `scripts/lib/mtproto.ts` sends as the founder and reads the bot's
    real reply (one-time setup: `TELEGRAM_TESTER_API_ID`/`_API_HASH`/`_SESSION`
    in `.env` — absent as of 2026-09-07; see `scripts/telegram-tester.ts
    login`). Until that exists, SSH tool-level execution is a fallback, not a
    substitute — say so explicitly, and ask the founder to send the real
    message himself when the gap matters.
- **Fix the schema, not the code**: if a task fails on ambiguous requirements,
  the planner asks for the missing field; never guess data.
- **Bug fixes start with a failing test** (PR template section is mandatory).
- **Deep-ideate, then self-critique from multiple angles (rule #25)**: before acting
  on any non-trivial task, generate real alternatives and argue against your own
  first answer. Three checks are mandatory, in this order:
  1. **Does it already exist?** Grep before you build. (2026-07-29: a recurrence
     module was written from scratch while `nextRecurrence` already sat in
     `src/core/time.ts` — and the existing one was *better*, with real IANA
     timezone handling instead of a fixed offset.)
  2. **What is the binding constraint?** Optimising a downstream variable while an
     upstream one is unverified is the most expensive mistake available. Name the
     constraint before choosing the work.
  3. **What would make this wrong?** State the strongest counter-argument to your
     own plan and answer it, or adopt it.
  Recommend one option with reasons; never present an unranked survey. If a
  conclusion rests on an assumption, verify the assumption or label it unverified.
- **Build for the OUTCOME, not the instruction (rule #26 — founder directive,
  2026-08-01)**: the general form of this rule — the three questions, and the
  2026-07-31 screener that produced zero applications — lives in the global
  `~/.claude/CLAUDE.md` § "Outcome-Driven, Not Instruction-Driven" and is not
  restated here. What is FounderOS-specific:
  - Every deliverable must end in something the founder can ACT ON — a ranked
    shortlist, a draft, a decision, a number that changes a choice. A log of what
    happened is not an outcome. If ignoring the output costs nothing and emits no
    signal, the design is wrong, however many tests pass.
  - Anything shown to the founder must be legible to someone who has never read
    the code. An internal label nobody defined ("Sponsor", "partially overlaps",
    "not checked") is not information. Print every reason, in bullets, with its
    own result — and split the Telegram message rather than hide a row.
  - Never discard collected data because it is currently useless. A senior role
    we will not apply to is still evidence about the market and about our own
    filters; a filtered-out row and an empty market are indistinguishable from
    outside, and that ambiguity has already cost this pipeline weeks. Reject
    inside the pipeline where the reason is stored and shown, never before it.
  - The second failure behind this rule is FounderOS-local: the first real jobhunt
    brief was unreadable because it displayed a PASSING check as the reason a role
    needed attention (2026-08-01).
- **Episodic memory is a file, not a hope**: any session that completes or merges non-trivial work
  writes `docs/sessions/YYYY-MM-DD-<topic>.md`, using `docs/sessions/TEMPLATE.md`'s sections (What we
  did / What we fixed / Why / Metrics / Outstanding), before the session ends. This is what "record
  significant decisions" actually means — a vague instruction with no destination doesn't get
  followed twice. The write lands under `docs/`, so it triggers the Automated Brain Sync rule below
  the same as any other doc change — `pnpm brain:sync` picks it up as an `entry_type: "session"` row,
  retrievable by every future session through `search_knowledge`/`search_turicks_brain`.
- **Zero paid calls in the dev loop** (⚠️ NON-NEGOTIABLE). This rule lives here, not in the global
  `~/.claude/CLAUDE.md`, because every command it names exists only in this repo — carrying it
  globally billed ~475 tokens to every session in every project for a rule that could not apply.

  | Zone | What runs | Allowed cost |
  |---|---|---|
  | Dev loop (write → test → fix) | `pnpm test` (scripted models) + `nomic-embed-text` dedup | **$0** |
  | Integration check (pre-PR) | free OpenRouter model | **$0** |
  | Live verification (PR-ready only) | real Gemini / MTProto QA | once per PR |

  1. A unit or integration test that makes a real LLM call is a **bug**. Tests use mocks, always.
  2. `scripts/probe-*.ts` and `scripts/e2e-telegram-qa.ts` spend Gemini tokens — never run them
     iteratively. Write a failing unit test, fix it, then run the probe ONCE to confirm.
  3. While iterating set `AGENT_MODEL=openrouter:google/gemini-2.5-flash-preview-05-20:free`
     (fallback `openrouter:deepseek/deepseek-r1:free`). Never a `google-genai:*` model in the loop.
  4. `pnpm eval` is a milestone gate, not a debugging tool — once per feature, not once per attempt.
     `pnpm qa:telegram` runs exactly once: tests green, lint clean, PR about to go up.
  5. If a bug needs a live call to reproduce it, capture it in a unit test first; the live call only
     confirms the fix.


## Rules binding on Claude itself (2026-08-06, derived from measured failures)

These come from an audit of ten defects across AG-001…AG-006. Each one names the incident that
produced it. Every rule states **what enforces it** — a rule with no mechanism is labelled
unenforced, and is expected to decay.

- **#27 — A rule with no mechanism decays; say which layer holds it.** Over one month the
  CI-enforced rules in `verify-architecture.ts` drifted **zero** times. Over one day, markdown rules
  drifted **three** times. When proposing any rule, state whether it is enforced by CI, by a script,
  or by nothing but goodwill — and prefer converting it rather than restating it louder. *More
  instruction is not the lever; the asymmetry between layer 2 and layer 4 is.*
  **Enforced by:** nothing. This is the rule that says so out loud.

- **#28 — Founder approval authorizes work; it does not verify it.** An approved plan can still be
  technically wrong, and shipping it is my failure, not the founder's. *(2026-08-06: the founder
  approved three M0a ranking fixes. Fix #1 — "make `scripts/` reachability roots" — was wrong; it
  would have erased a deliberate, documented distinction in `findOrphanSubsystems` and silently
  hidden `src/outreach` and `src/workflows`, the two genuinely dead subsystems. Root-cause
  investigation caught it after approval.)* If I find an approved plan is wrong, I say so before
  building it, then build the corrected version.
  **Enforced by:** nothing. Judgement only.

- **#29 — Review is mine and is not delegable.** A reviewer subagent is an input, never a verdict;
  every causal claim it makes gets verified against evidence before I repeat it to the founder.
  *(2026-08-06: the review subagent asserted AG-005 changed the count AG-004 was told to pin. False
  — AG-005 changed zero workflow references; the 4→7 rise came from my own commit `42a2cbb`. It also
  produced a plausible-but-wrong hypothesis for the AG-004 revert.)*
  **Enforced by:** nothing. Judgement only.

- **#30 — Name the displacement before accepting a redirect.** When a request would displace
  committed in-flight work, state what it displaces and what the delay costs, then do it. The
  founder is entitled to redirect; he is not entitled to do it *invisibly*, because the frozen plan
  lists "design loop never ships — 8 passes, 0 files" as a **realized, critical** risk. A process
  document written instead of a shipped milestone is that risk recurring.
  **Enforced by:** nothing. This is the rule the founder asked me to hold him to.

- **#31 — Status relayed through a human is still unverified.** "It's done" from the founder is a
  report of what an executor claimed, not an observation of the tree. Run `agy-guard`, commit, then
  read. *(2026-08-06: reviewed AG-004 at 20:27 on a relayed "it's done"; the still-live conversation
  reverted the tree at 20:36 and was still writing at 20:39.)*
  **Enforced by:** `~/Projects/scripts/ai-tools/agy-guard` (exit 1 while a conversation is live).

- **#32 — The brief is the defect surface.** Six of ten defects were mine, in the brief, not
  Antigravity's, in the code. Pre-dispatch brief review is worth more than any additional
  instruction to the executor. Checklist: `docs/antigravity/README.md` § "Before you dispatch".
  **Enforced by:** nothing yet. Candidate for a fitness rule once the failure modes are stable.

- **#33 — Never dismiss or reject claims from other AIs out of hand; deep-research and accept valid feedback.**
  Claims, critique, or findings from other AIs (subagents, peer models, automated reviewers, or external AI agents) must never be rejected or dismissed out of hand. Perform thorough, deep research and empirical verification against codebase evidence before reaching any conclusion. If the claim or feedback proves valid upon investigation, accept and integrate it fully without defensive bias.
  **Enforced by:** Judgement & empirical verification loop.

- **#34 — "Done" claims inherit the benchmark's evidence bar everywhere a claim is made, not only inside formal benchmark runs.** `pnpm verify:benchmark`/EXECUTOR-RULES only binds a benchmark invocation. The 2026-09-15 fabricated self-audit (an ad hoc "read the logs" request, not a benchmark) and PR #676's typed "gate green — 4254 tests" against an actual `2 failed` are the same defect — confident assertion standing in for a run — on two surfaces the existing gate never touches. *(`docs/plans/2026-09-16-recurring-failure-patterns-and-behavior-audit.md`: Theme 2, 8 independent instances across 2 months.)* Any self-diagnostic response, any PR body claiming a test/gate result, and any Antigravity dispatch brief's acceptance criteria must state a command that was actually run and its actual output, or say **NOT VERIFIED — reason**. A missing instrument (no log tool, no PR-read action) is reported as missing, never silently substituted with something adjacent.
  **Enforced by:** nothing yet for the ad hoc/PR-body/dispatch-brief surfaces. Mechanism (`gate-evidence.json`, CI-recomputed, PR body must match it) specified in `docs/plans/2026-09-16-mechanism-claimed-done-verification.md`, not yet built.

- **#35 — A freshness check generalizes: anything whose correctness depends on repo/deploy state must assert against that state directly, not against a proxy that can drift from it.** `ActiveEnterTimestamp` over `git rev-parse HEAD` (2026-08-12) is one instance of this, and it has held on every check since. It is not the only place staleness bites: a PR gate verdict is stale the moment the head moves past it; a script checked out once into `/opt/agy-workspace` goes stale the moment `main` moves; a branch with no PR is a decision deferred indefinitely, not a neutral state. *(Recurring-behavior audit: Theme 3, 7 independent instances.)* Before trusting a prior verdict, a script copy, or a branch, check what it was computed against, not just whether it exists.
  **Enforced by:** nothing yet beyond the one deploy-staleness case. No general "assert freshness against source, not proxy" check exists in CI.

- **#36 — Real-path verification is a required field, not a best practice.** `scripts/telegram-probe.ts` (built 2026-09-16) makes one-shot real-path verification cheap and it already caught a live bug on first use — but nothing requires anyone to run it. Issue #687, dispatched the same day the tool shipped, specified `pnpm test && pnpm typecheck` as its only acceptance criteria — the exact gap this rule exists to close, in the same session that built the fix for it. *(Recurring-behavior audit: Theme 8, 9 independent instances — the best-evidenced pattern in the corpus.)* Every PR body and every Antigravity dispatch brief must name one real-path assertion (the actual seam: Telegram → kernel → tool → reply → DB row, or the equivalent for non-Telegram work) or say **NOT VERIFIED — reason**, explicitly, in the same place the rest of the evidence goes.
  **Enforced by:** nothing yet. `pr-brain`'s gate already reads PR bodies; extending it to require this field, and extending the Antigravity brief template (`docs/antigravity/README.md` § "Before you dispatch") to include a verification-command field, is specified in `docs/plans/2026-09-16-mechanism-realpath-verification.md`, not yet built.

## History
The v2 system (LLM supervisor + regex pre-router + regex execution guards) was
audited and replaced 2026-07-08 — see `ZERO-BASE-AUDIT.md` (4 live failure
traces), `JARVIS-ARCHITECTURE.md` (the contract-first design), and
`docs/PROOF.md` (the living scoreboard).
