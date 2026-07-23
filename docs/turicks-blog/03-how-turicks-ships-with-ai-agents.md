# How Turicks Ships With AI Agents (Without Drowning in Slop)

*Turicks — engineering notes*

Turicks is an AI-native software studio. That phrase is doing a lot of work right
now, because in mid-2026 "we use AI" describes both the teams shipping remarkable
things in days and the teams drowning in unreviewable code. [The public
flashpoints](https://www.theregister.com/devops/2026/07/14/zig-creator-calls-buns-claude-rust-rewrite-unreviewed-slop/)
and [the productivity data](https://addyosmani.com/blog/agentic-code-review/) make
the split obvious: the tool is the same, the discipline is not.

Here's how we actually work — the operating playbook we run on client projects and
on our own system, FounderOS. We built FounderOS with an AI agent, rebuilt it twice
when we got the discipline wrong, and the rules below are what stuck.

## 1. The human owns the altitude; the agent owns the next 200 lines

An AI agent is superb at local implementation and blind to global shape. It
optimizes for "make this task pass" — never for "keep the system simple." That
second job never delegates, and it's the whole game. So on every project the
division of labor is fixed: **we own the architecture, the contracts, and the
question "is this getting simpler or more complex?"** The agent drafts inside those
decisions. When we forgot this on FounderOS, we got three competing routers nobody
could debug.

## 2. Contracts first, code second

Before implementation, we define the typed boundaries — the shapes of data as it
crosses between components. Then the agent fills in the middle. This flips the
usual failure mode: instead of the agent inventing an ad-hoc handoff (ours once
serialized a typed object into a string and regex-parsed it back — a schema
smuggled through a text field), it fills in code that *has* to satisfy a validated
contract. The contract is the spec the agent can't wander away from.

## 3. Make "simple" a build check, not a hope

We encode our architecture rules in CI so they survive contact with an agent that
out-types us: killed modules can't be recreated, no file exceeds 400 lines, a debt
counter only shrinks, dependency direction is enforced, fail-open error handling is
taxed. (We wrote these up as [five reusable rules](02-five-anti-slop-ci-rules.md).)
The point isn't process for its own sake — it's that discipline living in a wiki
doesn't survive the volume, and discipline living in CI does.

## 4. Evidence over assertion

Our definition of "done" is strict: the real path ran and we watched it produce the
real result — not "tests pass," and certainly not "the agent says it works." Unit
tests are necessary, not sufficient. This is the rule that catches the most
dangerous slop, the kind that looks finished. On FounderOS v1 we had a fully built,
fully tested email tool wired to nothing; every "sent" was a database row. One
run-it-and-show-me check would have caught it on day one.

## 5. Keep the dev loop free, so quality is never the expensive path

We build so the whole system can be exercised offline, deterministically, for $0.
When verifying properly costs nothing, there's no incentive to skip it or to "just
trust" the agent. Cheap verification is what makes the strict rules above
sustainable instead of aspirational.

## What this gets a client

Two things, mostly.

**Speed that doesn't turn into a rewrite.** The industry data shows the initial AI
speed gain is often [lost in the first month of maintenance](https://thenewstack.io/engineering-ai-slop-registry/)
as the debt compounds. Our rails are specifically designed to keep the velocity and
not pay it back — the agent still writes most of the code, it just can't bloat the
system.

**Software that tells the truth.** For anything that takes real action — sends,
payments, deployments — we build so the system can't claim it did something it
didn't, and can't act without a receipt. (More on that in
[Receipts Over Vibes](04-receipts-over-vibes.md).) That's not a nice-to-have when an
agent is operating on your behalf; it's the difference between an assistant and a
liability.

## The one-line version

We're not the studio that's afraid of AI agents, and we're not the studio shipping
their unreviewed output. We're the one that figured out where the brakes go. The
agent supplies velocity. We supply the judgment, the contracts, and the CI that
keeps it honest.

---

*See the discipline in a real system: [FounderOS on GitHub](../../README.md) and
the [case studies](../turicks-case-studies/). If your team is shipping fast with
agents and feeling the slop pile up, that's the problem we solve —
[turicks.com](https://turicks.com).*
