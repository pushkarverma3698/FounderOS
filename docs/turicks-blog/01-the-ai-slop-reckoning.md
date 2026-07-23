# The AI-Slop Reckoning: We Built the Thing Everyone's Warning About

*Turicks — engineering notes*

In July 2026 the Zig creator looked at a major Claude-driven Rust rewrite and
called it ["unreviewed slop."](https://www.theregister.com/devops/2026/07/14/zig-creator-calls-buns-claude-rust-rewrite-unreviewed-slop/)
Around the same time, Faros AI instrumented 22,000 developers and found that as
teams cranked up AI adoption, [code churn rose 861%, the per-developer defect rate
went from 9% to 54%, and PRs merged with zero review climbed 31%.](https://addyosmani.com/blog/agentic-code-review/)
The most damning line in that data isn't a number — it's the observation that
nobody *chose* to stop reviewing. Reviewers just couldn't keep pace with the
volume, so unread code became normal.

We have a confession: we didn't read about AI slop. We built it. Twice.

## What we shipped

FounderOS is our internal system that runs Turicks — it takes real actions over
Telegram (email, LinkedIn, GitHub, shell) on the founder's behalf. We built it
with an AI coding agent, fast, and we were proud of the velocity.

- **v1** was 10,678 lines of hand-rolled orchestration that looked like a serious
  system. It couldn't send an email. For four of five "departments," the finalize
  step wrote an audit-log row to the database and returned — it never called the
  tool that would actually perform the action. Every approval a user had ever given
  produced a row, not a result.
- **v2** was the "clean rebuild." The design doc proudly described going from
  "10,678 LOC to ~500 LOC" on modern framework primitives. A month later an audit
  found the real number: **27,819 lines**. The "simplification" had metastasized
  into three separate control systems — a regex pre-router, an LLM supervisor, and
  a 77-regex post-hoc "lie detector" — all fighting over every single message.

Neither version was written by a careless engineer. Both were written by a capable
AI agent doing exactly what we asked, one reasonable-looking pull request at a time.
That's the whole point.

## Why slop is dangerous specifically

Bad code you can see. Slop you can't — that's what makes it lethal. As The New
Stack put it, AI tools don't just help you write code faster, [they help you make
the same mistake faster, at scale.](https://thenewstack.io/engineering-ai-slop-registry/)
The output compiles, passes the tests, and looks plausible. It's *locally*
reasonable and *globally* incoherent.

Every disaster in our v2 was a locally reasonable decision:

- "Add a guard for the edge case" → a 591-line, 77-regex lie detector that
  sometimes rewrote our own database history to "clean up."
- "Handle errors defensively" → 20+ `catch (…) { return null }` sites and a
  recovery path that deleted the founder's entire conversation to escape a loop,
  then reported it as a courtesy.
- "Route to the right place" → three routers that all had to agree, so the system's
  true behavior was the intersection of 77 regexes and an 11.5 KB prompt no human
  could hold in their head.

None of those show up as a red diff. They show up as months of undebuggable
behavior and, eventually, a rewrite — the opposite of the speed AI promised.

## The way out isn't a better model

Here's the part that matters for anyone shipping with agents right now: we didn't
fix this with a smarter model or better prompts. We fixed it with **rails.**

1. **Contracts before code.** We wrote the typed boundaries first — the plan, the
   task envelope, the step result, the tool receipt — and made the agent fill in
   implementation *inside* them. When the shape is fixed and validated, the agent
   can't invent its own ad-hoc handoff.
2. **We made good architecture the only shape CI allows.** Deleting slop is
   worthless if it grows back. So we encoded the rules as build checks: killed
   modules fail the build if recreated, no file may exceed 400 lines, a debt
   counter may only shrink. The agent literally cannot rebuild the god module.
3. **Evidence over assertion.** "Done" means the real path ran and we watched it —
   not "the agent says it works." That one rule would have caught v1's phantom
   email tool on day one.
4. **A $0 dev loop.** The whole system runs offline in tests for free, so verifying
   properly is never the expensive option you're tempted to skip.

The result wasn't slower. It was faster, because we stopped rebuilding the same
slop. The agent still writes most of the code. It just writes it inside rails that
make the plausible-but-wrong answer fail the build.

## The uncomfortable takeaway

The Faros data says teams with mature, disciplined practices got hit just as hard
as everyone else. We believe it — discipline that lives in a wiki or a code-review
norm doesn't survive contact with an agent that outputs faster than you can read.
The only discipline that held for us was the kind a machine enforces.

If you're shipping fast with AI agents and the debt is piling up quietly: it's not
that you're bad at this. It's that velocity without brakes always ends in a
rewrite. Build the brakes.

---

*We wrote the full autopsy — five candid case studies on exactly where we fell for
slop and how we dug out — in [the FounderOS case studies](../turicks-case-studies/).
Turicks builds AI-native software with these rails built in. [turicks.com](https://turicks.com).*
