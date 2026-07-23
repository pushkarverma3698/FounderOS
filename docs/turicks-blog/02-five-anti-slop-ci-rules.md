# 5 CI Rules That Stop AI Slop From Growing Back

*Turicks — engineering notes*

Most "use AI responsibly" advice is a vibe: review more carefully, keep it simple,
don't over-engineer. Good luck enforcing a vibe against an agent that writes faster
than your team can read. [The data says reviewers already can't keep pace](https://addyosmani.com/blog/agentic-code-review/) —
so the discipline has to live somewhere that doesn't get tired.

We put ours in CI. After rebuilding our agent system twice (the
[full story here](../turicks-case-studies/)), these are the five machine-checked
rules that keep the slop from coming back. All five run on every PR. None of them
require a human to remember anything. Steal them.

## 1. Tombstones — killed modules can't return

When you delete a bad abstraction, an AI agent's very next instinct — when it hits
the problem that abstraction "solved" — is to rebuild it. So we keep a list of
**tombstoned** module names (our regex pre-router, our post-hoc guard, our old god
module). A CI check fails the build if any of them reappear.

```
if killed_module_exists(): fail("This module was deleted on purpose. Solve it inside the new pipeline.")
```

The effect is profound: the agent cannot recreate the thing you spent a rewrite
escaping. The fix is permanent.

## 2. A hard per-file line budget

God modules don't arrive fully formed; they accrete. Our worst v2 file grew to
1,210 lines by absorbing "just one more" responsibility per PR. So: **no source
file may exceed 400 lines.** When a file bumps the ceiling, that's the signal to
split responsibilities *now*, while it's cheap — not after it's a 1,200-line
god object nobody wants to touch.

## 3. A debt ratchet that only moves one way

Some debt you can't delete overnight. So track it and make it monotonic. We keep a
baseline file with the count of each known smell — regex routers, untagged
fail-open catches, layering violations. CI compares the PR's counts to the
baseline and **fails if any number went up.**

```
regex_routers: 0    # can go to 0, can never go to 1
fail_open_catches: N   # may shrink, may never grow
```

You don't have to fix everything today. You just can't add more. Over months, the
ratchet drags the codebase toward clean without a single "big cleanup" sprint.

## 4. Enforce import direction (dependency purity)

Slop loves to reach across layers "just this once" — the core imports the
transport, the pure module reads an env var, the thing that's supposed to be
testable now needs a live provider. We assert the allowed dependency direction in
CI: our kernel may import core/db/infra/tools, but **never** the gateway, and it
may **never** read env or construct a provider client.

The payoff is concrete: because the core stays pure, our entire system runs offline
in tests for **$0**. Dependency purity isn't aesthetic — it's what makes fast,
free verification possible.

## 5. Tax every fail-open catch

`catch (e) { return null }` is the single most common way an AI agent quietly
loses your data. It makes the immediate test pass and hides the failure. We don't
ban it — sometimes failing open is right — but every one must carry an explicit
tag:

```ts
try { ... } catch { /* allow-failopen: telemetry is best-effort */ return null }
```

Untagged fail-open catches fail CI, and the tagged count is in the ratchet (rule
3), so it can only shrink. Now swallowing an error costs a visible decision and a
reviewer's attention — instead of hiding in a diff and surfacing as data loss three
months later.

## Why this works when "review more carefully" doesn't

The throughput problem is real: an agent produces more code than humans can
scrutinize, so anything that depends on humans scrutinizing every line will fail.
These five rules share one property — **they don't require anyone to remember or
notice anything.** The build is the reviewer that never gets tired, never gets
busy, and never merges unread. You turn "we agreed not to do that" into "that
doesn't compile."

That's the whole trick. The agent supplies velocity. CI supplies the brakes. You
get to keep both.

---

*These rules run in FounderOS today (`scripts/verify-architecture.ts`). The war
stories that produced each one are in [the case studies](../turicks-case-studies/).
Turicks builds AI-native software with these rails from day one. [turicks.com](https://turicks.com).*
