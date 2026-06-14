# 02 — Request Lifecycle

What happens to **one** Telegram message, end to end. This is `runOfficeText()`
in [`src/gateway/office-run.ts`](../../src/gateway/office-run.ts). Read it with
[08 — Thread state machine](08-thread-state-machine.md) for the guard logic.

```mermaid
flowchart TD
  msg([Telegram message]) --> halt{global halt?<br/>readHalt}
  halt -- yes --> haltOut[reply halt notice · STOP]
  halt -- no --> g1

  subgraph guards["Thread guards (in order)"]
    g1[resolvePendingApproval<br/>drain stale interrupt] --> g2[recoverWedgedThread<br/>clear wedged checkpoint]
  end

  g2 --> base[capture baseLen<br/>= messages before invoke]
  base --> input[buildOfficeInput<br/>deterministic pre-router hint]
  input --> assert[assertNonEmptyMessages<br/>guard vs Gemini 400]
  assert --> invoke["office.invoke({messages})<br/>callbacks: BudgetGuard + Trace"]

  invoke --> paused{pending<br/>approval?}
  paused -- yes --> card[sendApprovalCard<br/>Approve / Reject · STOP] --> wait([wait for tap → resumeOffice])
  paused -- no --> slice[sliceFreshMessages from baseLen]

  slice --> reply[finalReply: last AI text<br/>fallback last tool msg]
  slice --> errs[collectToolErrors<br/>structured flag OR first-line keyword]
  reply --> fmt[markdownToTelegramHtml<br/>+ splitForTelegram 4096]
  errs --> fmt
  fmt --> send[send to Telegram]
  send --> post[recordConversationEnd<br/>+ trimThreadHistory<br/>fire-and-forget]
  post --> done([done])

  invoke -. throws .-> catch{error type}
  catch -- BudgetExceeded --> ab[clearThreadAfterAbort<br/>+ 💰 notice]
  catch -- GraphRecursion --> ab2[clearThreadAfterAbort<br/>+ 🔁 notice]
  catch -- other --> ab3[reply ❌ error + stack]

  classDef stop fill:#ef4444,stroke:#991b1b,color:#fff
  class haltOut,card,ab,ab2,ab3 stop
```

**Why each step exists (the bugs they fix)**
- **baseLen + sliceFreshMessages** — the Postgres checkpointer returns the *whole*
  thread trail every call. Without slicing, stale AI answers and old tool errors
  resurface every turn ("identical stale reply", "persistent toolErrors:1").
- **collectToolErrors** — tools return errors as their *result string* (they don't
  throw), so they never hit the catch. We surface them so the founder always sees a
  real failure. The two-signal test (structured `success:false` OR error keyword on
  the **first line**) avoids false "⚠️ Tool issue" on content that merely mentions
  the word "fail".
- **clearThreadAfterAbort** — an abort leaves the thread parked mid-graph; clearing
  unconditionally (same as `/reset`) stops the next message re-entering the dead loop.
