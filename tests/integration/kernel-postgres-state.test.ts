/**
 * FounderOS v3 — Gateway ↔ Postgres state integrity (simulated Telegram payload)
 * ===============================================================================
 * Proves the v3 kernel run-loop does not drop state across a HITL pause,
 * against a REAL PostgreSQL checkpointer — no live LLM or Telegram needed.
 *
 * Real (production code + real Postgres):
 *   runKernelText → getKernel() (kernel-boot composition root) → planner →
 *   dispatch → comms worker → send_email wrapper (daily quota, duplicate-
 *   outreach guard, brand gate, hitl_approvals insert, interrupt()) →
 *   PostgresSaver checkpoint → resumeKernel → suppression check →
 *   idempotency audit (action_log) → synthesizer reply + code-side receipts.
 *
 * Faked (exactly the seams that need external credentials — see
 * ARCHITECTURE_LEDGER.md Entry 8):
 *   - the LLMs: scripted models injected at agents/model.js. Role is derived
 *     from the SYSTEM PROMPT CONTENT (synthesizer prompt vs worker protocol),
 *     never from call order — invariant under graph topology changes.
 *   - the Gmail transport: providerSendEmail (audit/idempotency stay real)
 *   - judgeOutbound: deterministic "pass" (fail-open by design, ADR-023;
 *     mocked only to avoid a live call)
 *
 * Skips cleanly when Postgres is unreachable (keyless CI-without-services).
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import pg from "pg";

// ── Mocks (registered before the gateway/kernel modules are imported) ─────────

const h = vi.hoisted(() => ({
  providerSendEmail: vi.fn(async () => ({
    success: true as const,
    data: { message_id: "msg_simulated_v3_001" },
  })),
}));

vi.mock("../../src/infra/providers/index.js", async (importActual) => ({
  ...(await importActual<typeof import("../../src/infra/providers/index.js")>()),
  providerSendEmail: h.providerSendEmail,
}));

vi.mock("../../src/infra/judge.js", async (importActual) => ({
  ...(await importActual<typeof import("../../src/infra/judge.js")>()),
  judgeOutbound: vi.fn(async () => ({ verdict: "pass" as const })),
}));

// Unique recipients per run: the duplicate-outreach guard checks action_log by
// recipient, so a leftover audit row from an earlier run must never block this
// one — and the reject scenario needs its OWN recipient, or that same guard
// (correctly) short-circuits before the HITL gate ever fires.
const EMAIL_TO = `alex+v3-${Date.now()}@example.com`;
const REJECT_EMAIL_TO = `casey+v3-${Date.now()}@example.com`;
const EMAIL_SUBJECT = "Retreat call Thursday";
const EMAIL_BODY =
  "Hi Alex — confirming Thursday 3pm for the retreat planning call. Agenda: schedule review and open bookings. — Pushkar";

vi.mock("../../src/agents/model.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/agents/model.js")>();
  const { AIMessage } = await import("@langchain/core/messages");

  type Msg = { content: unknown; getType?: () => string; _getType?: () => string };
  const contentOf = (m: Msg | undefined): string =>
    typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? "");
  const typeOf = (m: Msg | undefined): string => m?.getType?.() ?? m?._getType?.() ?? "";
  // Recipient comes from the message itself (like a real planner/worker would
  // read it), so approve and reject scenarios stay independent.
  const recipientIn = (text: string): string => /[\w.+-]+@[\w.-]+\.\w+/.exec(text)?.[0] ?? "";

  const planJson = (to: string) =>
    JSON.stringify({
      type: "plan",
      plan: {
        schema_version: 1,
        goal: `Send a confirmation email to ${to}`,
        steps: [
          {
            step_id: "s1",
            worker: "comms",
            objective: `Send an email to ${to} confirming the Thursday 3pm retreat call.`,
            inputs: {},
            expected: { kind: "action_receipt", schema_ref: "action.summary" },
            constraints: { max_tool_calls: 2, hitl_required: true },
          },
        ],
      },
    });

  /** Planner: emits the single-step comms plan for the requested recipient. */
  const plannerModel = {
    invoke: async (messages: Msg[]) =>
      new AIMessage(planJson(recipientIn(contentOf(messages[messages.length - 1])))),
  };

  /**
   * Worker + synthesizer share getWorkerModel() in kernel-boot. Role is
   * decided by the system prompt the kernel constructed for this call.
   */
  const workerModel = {
    bindTools() {
      return this;
    },
    invoke: async (messages: Msg[]) => {
      const system = contentOf(messages[0]);
      if (system.startsWith("You are the FounderOS synthesizer")) {
        return new AIMessage("Email sent and confirmed.");
      }
      const last = messages[messages.length - 1];
      if (typeOf(last) === "tool") {
        const result = contentOf(last);
        // Terminal on ANY tool result — a sane model reports the outcome
        // (success, rejection, or guard text) instead of retrying verbatim.
        return new AIMessage(
          JSON.stringify({
            summary: result.includes("✅ Email sent to")
              ? `Email sent.`
              : `Not sent: ${result.slice(0, 160)}`,
          }),
        );
      }
      // The envelope (the last HumanMessage) carries the objective with the
      // recipient. NEVER scan the system prompt — it contains real addresses.
      const envelope = [...messages].reverse().find((m) => typeOf(m) === "human");
      const to = recipientIn(contentOf(envelope));
      return new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "call_send_email_1",
            name: "send_email",
            args: { to, subject: EMAIL_SUBJECT, body: EMAIL_BODY },
            type: "tool_call" as const,
          },
        ],
      });
    },
  };

  return {
    ...actual,
    getModel: () => plannerModel as never,
    getWorkerModel: () => workerModel as never,
  };
});

// ── Postgres reachability probe (collection-time skip, like the other suites) ──

async function postgresReachable(): Promise<boolean> {
  const url = process.env["DATABASE_URL"];
  if (!url) return false;
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
    await client.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

const pgUp = await postgresReachable();
if (!pgUp) {
  // eslint-disable-next-line no-console
  console.warn("[kernel-postgres-state] SKIP — Postgres unreachable at DATABASE_URL");
}

// ── Fake grammy context (the ONLY Telegram surface kernel-run touches) ─────────

interface SentMessage {
  text: string;
  opts?: { reply_markup?: unknown; parse_mode?: string };
}

function makeCtx(chatId: number) {
  const sent: SentMessage[] = [];
  return {
    sent,
    ctx: {
      chat: { id: chatId },
      reply: vi.fn(async (text: string, opts?: SentMessage["opts"]) => {
        sent.push({ text, ...(opts !== undefined ? { opts } : {}) });
        return { message_id: sent.length } as never;
      }),
    } as never,
  };
}

// ── The proof ──────────────────────────────────────────────────────────────────

describe.runIf(pgUp)("v3 kernel run-loop ↔ Postgres state integrity", () => {
  // Unique chat per run → unique thread_id → cross-run rows can never collide.
  const CHAT_ID = Number(`9${Date.now() % 1_000_000_000}`);
  const REJECT_CHAT_ID = CHAT_ID + 1;

  let pool: pg.Pool;
  let threadId: string;

  beforeAll(async () => {
    process.env["MCP_BRIDGE_ENABLED"] = "false";
    pool = new pg.Pool({ connectionString: process.env["DATABASE_URL"] });
    const { threadIdFor } = await import("../../src/gateway/kernel-run.js");
    threadId = threadIdFor(CHAT_ID);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("turn 1: simulated Telegram payload pauses on the approval card with durable state", async () => {
    const { runKernelText } = await import("../../src/gateway/kernel-run.js");
    const { sent, ctx } = makeCtx(CHAT_ID);

    await runKernelText(ctx, `Send an email to ${EMAIL_TO} confirming the Thursday 3pm retreat call`);

    // The founder got the progress placeholder, then exactly one approval card
    // with Approve/Reject buttons (the placeholder is deleted, not counted here).
    expect(sent).toHaveLength(2);
    expect(sent.at(-1)!.text).toContain(`Send email to ${EMAIL_TO}?`);
    expect(sent.at(-1)!.opts?.reply_markup).toBeDefined();

    // Nothing was sent yet.
    expect(h.providerSendEmail).not.toHaveBeenCalled();

    // Durable HITL state: a pending hitl_approvals row for this thread.
    const hitl = await pool.query(
      `SELECT interrupt_id, status FROM agents.hitl_approvals WHERE thread_id = $1`,
      [threadId],
    );
    expect(hitl.rows).toHaveLength(1);
    expect(hitl.rows[0].status).toBe("pending");

    // Durable graph state: the paused mission is checkpointed in Postgres.
    const cp = await pool.query(`SELECT COUNT(*)::int AS n FROM agents.checkpoints WHERE thread_id = $1`, [
      threadId,
    ]);
    expect(cp.rows[0].n).toBeGreaterThan(0);
  });

  it("turn 2: approve resumes the SAME thread — side effect exactly once, audited, state preserved", async () => {
    const { resumeKernel } = await import("../../src/gateway/kernel-run.js");
    const { getKernel } = await import("../../src/gateway/kernel-boot.js");
    const { idemKey } = await import("../../src/infra/hitl.js");
    const { sent, ctx } = makeCtx(CHAT_ID);

    await resumeKernel(ctx, "approved");

    // The transport fired exactly once, with the payload from turn 1.
    expect(h.providerSendEmail).toHaveBeenCalledTimes(1);
    expect(h.providerSendEmail.mock.calls[0]![0]).toMatchObject({
      to: EMAIL_TO,
      subject: EMAIL_SUBJECT,
    });

    // Idempotency audit row exists with the deterministic key.
    const key = idemKey("email", EMAIL_TO, EMAIL_SUBJECT, EMAIL_BODY);
    const audit = await pool.query(`SELECT action FROM agents.action_log WHERE idempotency_key = $1`, [key]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].action).toBe("send_email");

    // The approval row was resolved — and NO orphan pending row was left behind.
    const rows = await pool.query(
      `SELECT status FROM agents.hitl_approvals WHERE thread_id = $1 ORDER BY created_at`,
      [threadId],
    );
    expect(rows.rows.some((r) => r.status === "approved")).toBe(true);
    expect(rows.rows.filter((r) => r.status === "pending")).toHaveLength(0);

    // Founder-facing reply: synthesized text + code-side receipts block
    // (placeholder + final reply).
    expect(sent).toHaveLength(2);
    expect(sent.at(-1)!.text).toContain("Action receipts");
    expect(sent.at(-1)!.text).toContain("send_email");

    // State was NOT dropped: the thread still holds the turn-1 mission, done.
    const kernel = await getKernel();
    const state = await kernel.getState({ configurable: { thread_id: threadId } });
    expect(state.values.turn.raw_input).toContain(EMAIL_TO);
    expect(state.values.mission.status).toBe("done");
    expect(state.values.results[0]?.status).toBe("ok");
  });

  it("replay: the approved action is idempotent — same key never sends twice", async () => {
    const { emailTool } = await import("../../src/tools/email.js");
    const { idemKey } = await import("../../src/infra/hitl.js");
    const { TENANT } = await import("../../src/core/config.js");

    const res = await emailTool.execute({
      to: EMAIL_TO,
      subject: EMAIL_SUBJECT,
      body: EMAIL_BODY,
      idempotency_key: idemKey("email", EMAIL_TO, EMAIL_SUBJECT, EMAIL_BODY),
      tenant_id: TENANT,
    });

    expect(res.success).toBe(true);
    expect((res.data as { skipped?: boolean }).skipped).toBe(true);
    expect(h.providerSendEmail).toHaveBeenCalledTimes(1); // still exactly once
  });

  it("reject path: typed hitl_rejected failure, NO side effect, no orphan rows", async () => {
    const { runKernelText, resumeKernel, threadIdFor } = await import("../../src/gateway/kernel-run.js");
    const rejectThread = threadIdFor(REJECT_CHAT_ID);

    const t1 = makeCtx(REJECT_CHAT_ID);
    await runKernelText(t1.ctx, `Send an email to ${REJECT_EMAIL_TO} confirming the Thursday 3pm retreat call`);
    expect(t1.sent.at(-1)!.text).toContain(`Send email to ${REJECT_EMAIL_TO}?`);

    const t2 = makeCtx(REJECT_CHAT_ID);
    await resumeKernel(t2.ctx, "rejected");

    // No send happened for this thread (count unchanged from the approve test).
    expect(h.providerSendEmail).toHaveBeenCalledTimes(1);

    // The reply names the rejection honestly (typed failure, fail loud).
    expect(t2.sent).toHaveLength(2);
    expect(t2.sent.at(-1)!.text.toLowerCase()).toContain("nothing was sent");

    // The approval row is rejected; nothing pending remains.
    const rows = await pool.query(`SELECT status FROM agents.hitl_approvals WHERE thread_id = $1`, [
      rejectThread,
    ]);
    expect(rows.rows.some((r) => r.status === "rejected")).toBe(true);
    expect(rows.rows.filter((r) => r.status === "pending")).toHaveLength(0);
  });
});
