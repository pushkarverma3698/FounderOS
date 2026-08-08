# Voice → Browser Control

**Date:** 2026-08-08
**Branch:** `feat/voice-browser-control` (off `origin/main` @ 7af3951)
**Status:** Approved, implementing
**Scope:** Sub-project B of four. A (3D control surface) shipped on
`gemini/antigravityChanges`. C (self-operating loop) is a separate spec.

## Outcome

The founder speaks a general web task — *"open my GitHub PRs and tell me which are
failing CI"* — and the agent navigates, reads, clicks and reports back.

## What already exists (grepped before designing)

- **Voice → text already works, client-side.** `voiceEngine.listen()` (Web Speech
  API) in `apps/jarvis-next` is wired to `dispatchTurn` via the Header. The kernel
  has zero voice code. B adds nothing here except live-testing it, which has never
  been done.
- **Browser control exists but is shallow.** `src/tools/browser-playwright.ts` +
  `src/tools/personal.ts` expose exactly three actions: `open_url`,
  `get_page_text`, `run_js`. No click, type, scroll, screenshot, or wait.
- **Three browser-driving surfaces already exist**: the kernel Playwright tool,
  the kernel AppleScript/Safari path, and `mac-client`'s ATS form-fill with native
  hardware keystrokes. This spec deepens the first and leaves the other two alone;
  it does not add a fourth.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Target | General web tasks by voice | Widest payoff; makes the existing shallow tool genuinely useful |
| Browser | Dedicated Playwright profile with persistent `user-data-dir` | Logged-in sessions are required for anything useful. Founder logs in ONCE by hand; agent reuses the cookies. Blast radius limited to accounts deliberately added — unlike driving real Chrome, which would hand over banking and email in the same breath |
| Sight | Accessibility tree, NOT screenshots | A11y snapshots are text: deterministic, diffable, $0 on top of the existing model call. Screenshots need a vision model per step, which collides with "zero paid calls in the dev loop". Screenshot is an explicit opt-in action |
| Approval | Gate writes, not reads | Gating every action means 20 cards for a 20-step task, which is why the current tool is unused. One card at the moment it matters |
| Loop shape | One tool, action union, snapshot→ref→act | Rejected a high-level `browse_and_report(goal)` tool: it puts an LLM loop inside a tool, which is the LLM-supervisor pattern v3 deliberately removed in July |

## Architecture

```
src/tools/browser/
  profile.ts      persistent user-data-dir resolution + first-run login guidance
  snapshot.ts     DOM -> a11y tree with stable ref ids        (PURE, unit-tested)
  write-gate.ts   isWriteAction(action, element) -> boolean   (PURE, unit-tested)
  actions.ts      the action union executor
  session.ts      browser lifecycle; one page, survives across turns
src/agents/agent-tools/browser.ts   single LangChain tool wrapper
```

### The contract

Every call returns:

```ts
interface BrowserResult {
  url: string;
  title: string;
  snapshot: Ref[];          // interactive elements only
  text?: string;            // present for read actions
  notice?: string;          // e.g. "login wall detected"
}

interface Ref {
  ref: string;              // "ref_7" — stable within one snapshot
  role: string;             // button | link | textbox | checkbox | select ...
  name: string;             // accessible name
  value?: string;
}
```

The agent acts on **refs, never CSS selectors**. A page that reflows cannot cause a
mis-click, and a stale ref fails loudly instead of hitting the wrong element.

### Actions

`navigate` · `snapshot` · `click` · `type` · `select` · `scroll` · `wait_for` ·
`screenshot` · `back`

### The write gate

`isWriteAction()` is pure code, not a prompt instruction — per the kernel rule that
routing and guards are unit-tested functions. It returns true for:

- `type` into a field whose role/name/type indicates a credential
- `click` on an element whose accessible name or role matches submit / send / buy /
  order / pay / post / publish / delete / remove / confirm
- any action that submits a `<form>`
- `navigate` to a URL carrying auth or payment parameters

Everything else — navigate, snapshot, scroll, read, screenshot, back — runs
unattended. The gate is table-tested, including cases that *should* have been
gated, so a regression is visible rather than silent.

**Never automated regardless of the gate:** entering passwords, card numbers or
government IDs; completing CAPTCHAs; executing trades or transfers. These stop and
ask the founder to act, they do not become HITL cards.

## Error handling

| Failure | Behaviour |
|---|---|
| Navigation timeout | Typed failure naming the URL, `retryable: true` |
| Stale / unknown ref | Force a fresh snapshot; never guess a substitute element |
| Login wall | Detected from the snapshot; stop and tell the founder to log into the profile. The agent does not attempt to authenticate |
| Session death | Relaunch once, then fail loud |
| Profile missing | First-run message with the exact command to create it |

## Testing

- `snapshot.ts` and `write-gate.ts` are pure → unit tests at **$0**, including a
  table of "should this have been gated?" cases.
- Integration against a local fixture page (no network, no cost).
- One live run against a real logged-in site — the only part that costs anything,
  run once when everything above is green.
- Live voice test: speak a command, confirm it reaches `dispatchTurn`. Never done
  before; the mic is blocked in the preview pane, so this must be real Chrome.

## Known limits

- Voice recognition is Web Speech API — Chrome/Edge only, and it sends audio to
  Google's servers. Kernel-side Whisper is out of scope here.
- The persistent profile is a standing credential store on disk. It is worth
  exactly the accounts deliberately logged into it and should never hold banking
  or primary email.
- Headless-vs-headed is a config flag; headed on the Mac lets the founder watch,
  headless is what runs on the VPS.
