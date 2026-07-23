# Working With AI Coding Agents Without Drowning in Slop

*Turicks Engineering — the v1 → v2 → v3 journey, part 5 of 5*

Most of FounderOS — including the rewrite that fixed it — was written with an AI coding agent. So this series is not an argument against AI-assisted engineering. It's the opposite: we ship faster with agents than without them. But we learned, expensively, that an AI agent is a **force multiplier with no brakes**. Point it at a vague goal and it will produce a plausible, confident, over-engineered answer that passes review and rots in production. Parts 1–4 were four versions of exactly that. This is the playbook we run now so it doesn't happen again.

**By the numbers**

| | |
|---|---|
| v1 | **10,678 LOC** that couldn't send an email |
| v2 | claimed **"~500 LOC"**, was **27,819** |
| The industry, mid-2026 | code churn **+861%**, per-dev defect rate **9% → 54%**, zero-review PRs **+31%** ([Faros AI / Osmani](https://addyosmani.com/blog/agentic-code-review/)) |
| The public flashpoint | a major Claude-driven Rust rewrite called ["unreviewed slop"](https://www.theregister.com/devops/2026/07/14/zig-creator-calls-buns-claude-rust-rewrite-unreviewed-slop/) |
| Our fix | **6 CI gates** + a **$0** full-graph test loop + evidence-over-assertion |

**What it cost us — and how we got out.** We didn't read about AI slop; we shipped it, three times. The cost was two full rebuilds and months spent debugging systems that looked sophisticated and quietly didn't work. The escape wasn't a smarter model or better prompts — it was **rails**: fix the contract instead of adding a guard, encode "stay simple" in CI so it can't erode, and demand run-it-and-show-me evidence for every claim. The rest of this piece is that playbook.

---

## The Genesis (v1) — velocity mistaken for progress

Early on, "the AI built it and the tests pass" felt like done. It wasn't. v1 was 10,678 lines that looked like a serious system and couldn't send an email (the finalize node wrote an audit row and never called the tool). The agent hadn't lied — it had faithfully built the *scaffolding* we described, department state machines and all, while the one thing that mattered quietly didn't fire. The mistake was ours: we graded the code by how sophisticated it looked and whether tests were green, not by whether the real path worked end to end.

## The Bloat & AI Slop (v2) — the agent's defaults, unchecked

v2 is a catalog of what an unsupervised-but-capable agent reaches for by default, because those patterns are dense in its training data and they make the immediate task pass:

- **"Add a guard for the edge case"** → a 591-line, 77-regex lie detector (part 2).
- **"Handle the error defensively"** → 20+ `.catch(() => null)` sites and a recovery path that deleted data (part 4).
- **"Route the request to the right place"** → three competing routers, two of them regex (part 1).
- **"Pass a typed contract across the boundary"** → a schema serialized into a string and regex-parsed back (part 3).

None of these are stupid. Every one is a *reasonable-looking* local decision. That's what makes AI slop dangerous: it isn't obviously bad code, it's plausibly good code with no global coherence, and it accretes one reasonable PR at a time until the system's real behavior is the intersection of 77 regexes and an 11.5 KB prompt that no human can hold in their head. The agent optimizes for "make this task pass." Nobody was optimizing for "keep the whole thing simple." That job is yours, and it does not delegate.

## The Production Reality (v3) — the playbook, encoded in CI

The fix wasn't a better model or better prompting. It was building **guardrails the agent runs inside**, so that the fast path and the disciplined path are the same path. Concretely:

**1. Contracts first, code second.** Before writing the kernel, we wrote `contracts.ts` — the typed boundaries (`TaskEnvelope`, `Plan`, `StepResult`, `FailureReport`, `ToolReceipt`). When the shape is fixed and validated up front, the agent fills in implementation *inside* the contract instead of inventing its own ad-hoc boundaries. "The contracts are the architecture" is a literal design rule, not a slogan.

**2. Make good architecture the only shape CI allows.** Deleting slop is worthless if it regrows. So the rules are machine-enforced (`scripts/verify-architecture.ts`):
   - **Tombstones** — recreating a killed module (`pre-router`, `execution-guard`, `office.ts`) fails the build. The agent literally cannot rebuild the thing we deleted.
   - **Debt ratchet** — a baseline file tracks known debt (regex-routing, gateway-imports, fail-open catches). It may only shrink. You cannot add a new regex router; the counter won't let you.
   - **400-line file budget** — god modules can't form. v2's `office-run.ts` was 1,210 lines; that's now a build failure.
   - **Fail-open tax** — every swallow-and-continue `catch` needs an explicit `// allow-failopen: <reason>` tag and shows up in the ledger.

**3. Evidence over assertion (our rule #24).** "Done" means the verification command was run fresh in the same session with the output shown — not "the agent says it works," not "unit tests pass." Unit tests are necessary, not sufficient; we exercise the real path (gateway → kernel → tool → reply → `action_log` row) before believing anything. If it can't be verified, the honest output is "NOT VERIFIED — reason." This one rule would have caught v1's phantom email tool on day one.

**4. A $0 dev loop, so discipline is cheap.** The full graph runs offline in CI with scripted models — `pnpm test` costs nothing and exercises every guarantee as a named scenario (see `docs/PROOF.md`). Live model calls are reserved for milestone gates. When verifying properly is free, there's no incentive to skip it, and no incentive to let the agent "just trust me."

**5. The human owns the altitude.** The agent is superb at the next 200 lines and blind to the shape of the whole. So the division of labor is fixed: the agent drafts implementation; the human owns architecture, contracts, and the question "is this getting simpler or more complex?" Every layer in v2 was added to patch the layer below it. v3's discipline is: when tempted to add a layer, remove one instead.

The result isn't slower. It's faster, because we stopped rebuilding the same slop. The agent still writes most of the code — it just writes it inside rails that make the plausible-but-wrong answer fail the build.

## Key Engineering Takeaways

- **An AI agent optimizes for "make this task pass," never for "keep the system simple."** That second job is non-delegable and it's the whole game. If nobody owns global simplicity, entropy wins one reasonable PR at a time.
- **Encode your architecture rules in CI, not in a style guide.** "Please don't recreate the god module" is a wish. A tombstone check that fails the build is a rule. Agents (and tired humans) respect the build, not the wiki. Turn every "we agreed not to" into a failing test.
- **Fix the schema, not the symptom.** When the agent gets something wrong, the reflex is to add a guard that catches it. Resist. Change the contract so the wrong thing can't be expressed. A guard is more code to maintain; a tighter type is less.
- **"Tests pass" is the floor, "the real path ran and I watched it" is the bar.** Demand evidence from your agent the way you'd demand it from a junior engineer who's overconfident and very fast — because that's exactly what you have. Make "NOT VERIFIED" an acceptable, expected answer.
- **Watch the metrics the agent quotes you.** "Cut from 10k to 500 lines" was off by 55×. Line counts, "it's simpler now," "fully tested" — these are the confident claims that feel good and go unchecked. Run `wc -l`. Run the probe. Count it yourself.
- **Speed without brakes is how you get three routers.** The agent's velocity is real and valuable. Pair it with a hard, automated definition of "simple enough" and you get the best of both: fast drafts inside rails that keep the system coherent.

---

*This is the last of five. If a fast, confident coding agent is writing your production system, the lesson of FounderOS is not "don't." It's: **decide the shape yourself, make CI enforce it, and demand evidence for every claim.** The agent supplies velocity. You supply the brakes.*

*Read the series from the start: [The Three-Router Trap](01-three-router-trap.md).*

---

### Work with Turicks

Turicks builds AI-native software and puts this exact playbook to work on client systems — agent architectures that ship in days, don't hallucinate their results, and stay simple under the velocity of an AI coding agent. If your team is shipping fast with agents and feeling the slop pile up, that's the problem we solve. See what we ship at **[turicks.com](https://turicks.com)**.

> *[Client outcome placeholder — add a one-line result + attributed quote here once cleared for publication.]*
