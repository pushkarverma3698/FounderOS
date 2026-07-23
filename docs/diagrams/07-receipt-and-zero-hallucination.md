# 07 — Receipts & Zero-Hallucination

The scariest failure mode of an action-taking agent is claiming it did something
it didn't. v3 makes that claim **structurally impossible** rather than trying to
catch it after the fact (the v2 approach — a 591-line, 77-regex "lie detector" —
is a CI tombstone). The mechanism is the `ToolReceipt` plus one check in
`validateStepResult`.

```mermaid
sequenceDiagram
  autonumber
  participant A as agent (LLM)
  participant TA as tool-adapter (code)
  participant EXT as External API
  participant C as collect (pure)
  participant S as synthesize (LLM)

  A->>TA: call send_email(args)
  Note over TA: args_hash = sha256(stable(args))<br/>idempotency check BEFORE send
  TA->>EXT: perform side effect
  EXT-->>TA: provider response (msg-id)
  Note over TA: ToolReceipt {tool, args_hash,<br/>result_digest, ok:true, at, idempotency_key}<br/>← written by CODE, not the model
  TA-->>A: result + receipt
  A->>C: StepResult { output, tool_receipts[] }
  Note over C: validateStepResult()<br/>expected.kind == action_receipt?<br/>→ require some receipt.ok == true
  alt receipt present & ok
    C->>S: accepted result
    S-->>S: reply may claim the action
  else no successful receipt
    C-->>C: REJECT → typed failure<br/>"claims success but has no receipt"
  end
```

## Why it can't be gamed

- **The model never writes the receipt.** The tool adapter does, from the actual execution. The LLM cannot forge `ok: true`.
- **The synthesizer only sees validated results.** The node that writes "✅ Sent" physically never receives an unbacked action, so it cannot narrate one.
- **Idempotency is upstream of the receipt.** The idempotency key is checked before the side effect, so a retry can't double-send *and* can't mint a second receipt for the same action.
- **It's an executable guarantee, not a promise.** `docs/PROOF.md` lists `kernel-e2e: fabricated action` — a test that a fabricated action claim is rejected — running offline at $0.

## Contrast with v2

| | v2 (detection) | v3 (prevention) |
|---|---|---|
| Mechanism | 77 regexes scanning the reply | 1 receipt check in a pure validator |
| Grows with | every incident (a new pattern each time) | never (written once, inherited by every tool) |
| Failure of the mechanism | false positive → 2× spend, canned refusal, **checkpoint rewritten** | none — the unbacked claim can't reach the writer |
| Truth source | the prose (wrong place) | the execution receipt (right place) |
