# LinkedIn Distribution Kit

Ready-to-post LinkedIn versions of every blog post and case study. Each is
hook-first (the first two lines are what shows before "…see more"), candid, and
ends with a link + a light CTA. Swap `[LINK]` for the published URL.

Posting notes: lead with the hook line alone, break every 1–2 sentences for mobile,
put the link in the first comment if you want max reach (LinkedIn suppresses
outbound links in-post — your call). Numbers below are all from our own audit; keep
them exact.

---

## From the blogs

### 01 · The AI-Slop Reckoning

> We didn't read about AI slop. We built it. Twice.
>
> Our internal system, FounderOS, takes real actions for us — email, LinkedIn,
> GitHub. We built it with an AI agent, fast, and we were proud of the speed.
>
> v1: 10,678 lines that looked serious and couldn't send an email. The "send" step
> wrote a database row and never called the tool. Every approval was paperwork.
>
> v2: the "clean rebuild." The design doc said "10,678 → ~500 lines." A month later
> the real count was 27,819 — three control systems fighting over every message.
>
> Neither was written by a careless engineer. Both were written by a capable agent
> doing exactly what we asked, one reasonable PR at a time. That's the trap.
>
> The industry just got the data: with high AI adoption, code churn +861%, defect
> rate 9%→54%, zero-review PRs +31%. Nobody chose to stop reviewing — they just
> couldn't keep up.
>
> We got out. Not with a better model — with rails: contracts first, "simple"
> enforced by CI, evidence over assertion. The agent still writes most of the code.
> It just can't bloat the system anymore.
>
> Full write-up (5 candid case studies): [LINK]
>
> #AI #SoftwareEngineering #AIcoding #TechnicalDebt

---

### 02 · 5 CI Rules That Stop AI Slop

> "Review more carefully" is not a plan when your agent writes faster than your team
> can read.
>
> After rebuilding our agent system twice, here are the 5 CI rules that keep the
> slop from growing back — no human has to remember anything:
>
> 1. Tombstones — deleted bad modules fail the build if recreated. The agent can't
> rebuild what you escaped.
> 2. 400-line file budget — god modules can't accrete. (Ours hit 1,210 lines before
> we caught it.)
> 3. A debt ratchet that only shrinks — you can't add a new smell, only remove one.
> 4. Enforced import direction — keeps the core pure, which is what makes tests run
> for $0.
> 5. Tax every fail-open catch — `catch { return null }` is how agents quietly lose
> your data.
>
> The build is the reviewer that never gets tired. Turn "we agreed not to" into
> "that doesn't compile."
>
> Full breakdown + the code: [LINK]
>
> #DevOps #CI #AIcoding #SoftwareEngineering

---

### 03 · How Turicks Ships With AI Agents

> "We use AI" now describes both the teams shipping miracles in days and the teams
> drowning in unreviewable code. Same tool. Different discipline.
>
> Here's our playbook — the one we run on client work and on our own system:
>
> → The human owns the altitude; the agent owns the next 200 lines. "Keep it
> simple" never delegates.
> → Contracts first, code second. The agent fills in a validated shape it can't
> wander away from.
> → "Simple" is a build check, not a hope.
> → Evidence over assertion: "done" = the real path ran and we watched it.
> → A $0 dev loop, so quality is never the expensive path.
>
> The payoff for clients: speed that doesn't turn into a rewrite, and software that
> tells the truth about what it did.
>
> We're not the studio afraid of agents, and not the one shipping their unreviewed
> output. We're the one that figured out where the brakes go.
>
> The full playbook: [LINK]
>
> #AI #Startups #SoftwareDevelopment #AInative

---

### 04 · Receipts Over Vibes

> The worst AI failure isn't a crash. It's the agent that confidently says "✅ Email
> sent" when no email was sent.
>
> For a chatbot that's embarrassing. For an agent acting on your behalf, it's the
> whole ballgame.
>
> We hit this from both sides building FounderOS:
> → v1 lied by omission — reported success while the action never fired.
> → v2 tried to catch the lie with 77 regexes scanning replies. It couldn't work,
> because the truth isn't in the text. It's in whether the action happened.
>
> The fix: receipts. Every tool run emits a receipt recorded by the code, never the
> model. One rule governs everything — no successful receipt, no success. The
> component that writes "✅ Sent" only sees proven results, so it can't narrate a
> fiction.
>
> Detection scales with every incident. Prevention is a one-time structural cost.
> Stop grading the essay; check the work.
>
> Why this matters more every month: [LINK]
>
> #AI #AIagents #SoftwareEngineering #Trust

---

## From the case studies

### CS-01 · The Three-Router Trap

> Every time a layer of our system was unreliable, we added another layer to police
> it. By v2 we had THREE control systems deciding what one Telegram message should
> do — two of them hand-maintained regex piles.
>
> Each new layer made the whole thing less reliable, because they interacted. The
> system's real behavior was the intersection of 77 regexes and an 11.5 KB prompt.
> Nobody could hold that in their head, so nobody could debug it.
>
> The fix: delete two of the three routers, replace them with one typed pipeline,
> and let CI forbid their return.
>
> The full teardown: [LINK]
>
> #SoftwareArchitecture #AIcoding

---

### CS-02 · The Lie Detector We Built for Our Own AI

> We wrote 591 lines and ~77 regexes to catch our own AI lying about what it did.
>
> It could never be right, only tuned — because no regex tells "I sent the email"
> (true) from "I sent the email" (false). The truth isn't in the text.
>
> When it guessed wrong it replaced correct answers with refusals and rewrote our
> own database history to "clean up."
>
> v3 deleted it and asked one question instead: is there a receipt? Detection grows
> with every incident; prevention is written once.
>
> How we did it: [LINK]
>
> #AIagents #SoftwareEngineering

---

### CS-03 · Empty Braces: The Handoff That Lost the Task

> The most expensive bug in our agent system was two characters: `{}`.
>
> Our supervisor handed off work with an empty-argument call. The receiving agent
> got no task — it re-inferred it from a chat history that was trimmed to ~4,000
> tokens before every call. Complex tasks played telephone with themselves.
>
> The tell: it looked perfect in the diff. Clean call, passing test, task quietly
> gutted at runtime.
>
> The fix: every boundary is a validated typed object, or it isn't a boundary — it's
> a bug.
>
> The full story: [LINK]
>
> #SoftwareArchitecture #AIcoding

---

### CS-04 · When "Recovery" Meant Data Loss

> Our agent's most dangerous line of code was a `catch` block that presented itself
> as helpful.
>
> When a task looped, the system "recovered" by deleting the founder's entire
> conversation from the database — then said, cheerfully: "I've cleared that task,
> just send your next message."
>
> Data loss wearing the costume of error handling. Plus 20+ `catch { return null }`
> sites that swallowed errors and limped forward in an unknown state.
>
> v3: failure is a typed value the founder always sees, and no recovery path may
> destroy state. CI-enforced.
>
> How we made failure honest: [LINK]
>
> #SoftwareEngineering #ErrorHandling

---

### CS-05 · Working With AI Coding Agents Without Drowning in Slop

> Most of our system was written by an AI agent — including the rebuild that fixed
> it. This isn't an argument against AI-assisted engineering. It's the field guide.
>
> An AI agent is a force multiplier with no brakes. It optimizes for "make this task
> pass," never "keep the system simple." That second job is yours and it doesn't
> delegate.
>
> The playbook that saved us: contracts first, "simple" enforced by CI, fix the
> schema not the symptom, demand evidence for every claim, keep verification free.
>
> The agent supplies velocity. You supply the brakes. You get to keep both.
>
> The full playbook: [LINK]
>
> #AIcoding #SoftwareEngineering #Startups
