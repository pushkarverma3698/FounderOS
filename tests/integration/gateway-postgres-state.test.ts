/**
 * FounderOS — Gateway ↔ Postgres state integrity (simulated Telegram payload)
 * ============================================================================
 * Proves the production run-loop does not drop state across a HITL pause,
 * against a REAL PostgreSQL checkpointer — no live LLM or Telegram needed.
 *
 * Real (production code + real Postgres):
 *   routeToOffice → pre-router → office graph (createSupervisor + ReAct comms)
 *   → send_email wrapper (quota, duplicate-outreach, brand gate, hitl_approvals
 *   insert, interrupt()) → PostgresSaver checkpoint → resumeOffice →
 *   suppression check → idempotency audit (action_log) → final reply.
 *
 * Faked (exactly the two seams that need external credentials — see
 * ARCHITECTURE_LEDGER.md Entry 4):
 *   - the LLM: a scripted BaseChatModel that decides by its BOUND TOOL SET
 *     (send_email ⇒ act as comms dept; transfer_to_* ⇒ act as supervisor)
 *   - the Gmail transport: providerSendEmail (audit/idempotency stay real)
 *   - judgeOutbound: deterministic "pass" (fail-open by design, ADR-023;
 *     mocked only to avoid a live OpenRouter call)
 *
 * Skips cleanly when Postgres is unreachable (keyless CI) — like the other
 * integration suites skip without a live model key.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import pg from "pg";

// ── Mocks (must be registered before the office/gateway are imported) ─────────

const h = vi.hoisted(() => ({
  providerSendEmail: vi.fn(async () => ({
    success: true as const,
    data: { message_id: "msg_simulated_001" },
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

// Unique recipient per run: the duplicate-outreach guard checks action_log by
// recipient, so a leftover audit row from an earlier run must never block this one.
const EMAIL_TO = `alex+${Date.now()}@example.com`;
const EMAIL_SUBJECT = "Retreat call Thursday";
const EMAIL_BODY =
  "Hi Alex — confirming Thursday 3pm for the retreat planning call. Agenda: schedule review and open bookings. — Pushkar";

vi.mock("../../src/agents/model.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/agents/model.js")>();
  const { BaseChatModel } = await import("@langchain/core/language_models/chat_models");
  const { AIMessage } = await import("@langchain/core/messages");

  /**
   * Scripted model: role is derived from the tool set bound to this instance,
   * not from call order — one shared model serves supervisor + all departments,
   * so ordering would couple the test to LangGraph's internal invocation order.
   */
  class ScriptedModel extends BaseChatModel {
    toolNames: string[] = [];

    _llmType(): string {
      return "scripted-test-model";
    }

    override bindTools(tools: unknown[]): ScriptedModel {
      const bound = new ScriptedModel({});
      bound.toolNames = tools.map((t) => (t as { name?: string }).name ?? "");
      return bound;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async _generate(messages: any[]): Promise<any> {
      const transcript = messages
        .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
        .join("\n");
      if (process.env["SCRIPTED_MODEL_DEBUG"]) {
        // eslint-disable-next-line no-console
        console.error("[scripted]", JSON.stringify({ tools: this.toolNames.slice(0, 12), last: transcript.slice(-300) }));
      }

      const last = messages[messages.length - 1];
      const lastType: string = last?.getType?.() ?? last?._getType?.() ?? "";
      const lastContent: string = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");

      let message;
      if (this.toolNames.includes("send_email")) {
        // Acting as the comms department agent. Terminal on any real tool result
        // (success OR guard/failure text) so a blocked send can never loop the
        // graph — a sane model reports the outcome instead of retrying verbatim.
        if (lastType === "tool" && !lastContent.includes("Successfully transferred")) {
          message = lastContent.includes("✅ Email sent to")
            ? new AIMessage(`EMAIL_DONE: sent to ${EMAIL_TO}.`)
            : new AIMessage(`EMAIL_FAILED: ${lastContent.slice(0, 200)}`);
        } else {
          message = new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "call_send_email_1",
                name: "send_email",
                args: { to: EMAIL_TO, subject: EMAIL_SUBJECT, body: EMAIL_BODY },
              },
            ],
          });
        }
      } else if (this.toolNames.some((n) => n.startsWith("transfer_to_"))) {
        // Acting as the supervisor.
        if (transcript.includes("EMAIL_DONE")) {
          message = new AIMessage(`✅ Email to ${EMAIL_TO} sent — task complete.`);
        } else if (transcript.includes("EMAIL_FAILED")) {
          message = new AIMessage(`❌ The comms department could not send the email: ${transcript.slice(-200)}`);
        } else {
          message = new AIMessage({
            content: "",
            tool_calls: [{ id: "call_transfer_1", name: "transfer_to_comms", args: {} }],
          });
        }
      } else {
        message = new AIMessage("ok");
      }
      return { generations: [{ text: typeof message.content === "string" ? message.content : "", message }] };
    }
  }

  const model = new ScriptedModel({});
  return {
    ...actual,
    getModel: () => model,
    // Departments use the worker model; internally it delegates to the module-local
    // getModel (which a mock export can't intercept) — override it directly.
    getWorkerModel: () => model,
    getModelFallbackMiddleware: () => [],
  };
});

// ── Postgres reachability probe (top-level await — vitest ESM) ────────────────

async function probeDb(): Promise<boolean> {
  const url = process.env["DATABASE_URL"];
  if (!url) return false;
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3_000 });
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

const dbUp = await probeDb();
if (!dbUp) {
  // eslint-disable-next-line no-console
  console.warn("[gateway-postgres-state] SKIP — Postgres unreachable at DATABASE_URL.");
}

// ── Fake grammy Context (transport boundary only) ─────────────────────────────

interface Reply {
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  opts?: any;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeCtx(chatId: number, replies: Reply[], text?: string): any {
  return {
    chat: { id: chatId },
    from: { id: chatId },
    ...(text !== undefined ? { message: { text } } : {}),
    reply: vi.fn(async (t: string, opts?: unknown) => {
      replies.push({ text: t, opts });
    }),
    replyWithChatAction: vi.fn(async () => {}),
  };
}

describe.runIf(dbUp)("gateway ↔ Postgres — simulated Telegram payload keeps state across HITL pause", () => {
  // Unique chat id per run so reruns never collide with leftover thread state.
  const chatId = Number(`9${String(Date.now()).slice(-8)}`);
  const threadId = `turicks:${chatId}`;
  let sql: pg.Client;

  beforeAll(async () => {
    sql = new pg.Client({ connectionString: process.env["DATABASE_URL"] });
    await sql.connect();
  });

  afterAll(async () => {
    if (!sql) return;
    // Clean up this run's rows so the table doesn't accumulate test artifacts.
    await sql.query("DELETE FROM agents.hitl_approvals WHERE thread_id = $1", [threadId]).catch(() => {});
    await sql.query("DELETE FROM agents.action_log WHERE payload->>'to' = $1", [EMAIL_TO]).catch(() => {});
    for (const t of ["checkpoints", "checkpoint_writes", "checkpoint_blobs"]) {
      await sql.query(`DELETE FROM agents.${t} WHERE thread_id = $1`, [threadId]).catch(() => {});
    }
    await sql.end().catch(() => {});
  });

  it("turn 1: text payload pauses on a HITL card; interrupt + checkpoint are durably in Postgres", async () => {
    const { routeToOffice } = await import("../../src/gateway/office-run.js");

    const replies: Reply[] = [];
    await routeToOffice(fakeCtx(chatId, replies, `Send an email to ${EMAIL_TO} confirming the Thursday retreat call`));

    // The gateway replied with an approval card carrying the approve/reject keyboard.
    const card = replies.find((r) => r.text.includes("Send email to") && r.opts?.reply_markup);
    expect(card, `expected an approval card, got: ${JSON.stringify(replies)}`).toBeTruthy();
    expect(card!.text).toContain(EMAIL_TO);

    // Nothing sent yet — approval gates the side effect.
    expect(h.providerSendEmail).not.toHaveBeenCalled();

    // REAL Postgres state: pending hitl_approvals row (rule #4 — written before interrupt()).
    const hitl = await sql.query(
      "SELECT status FROM agents.hitl_approvals WHERE thread_id = $1",
      [threadId],
    );
    expect(hitl.rows).toHaveLength(1);
    expect(hitl.rows[0]).toMatchObject({ status: "pending" });

    // REAL Postgres state: the paused graph is checkpointed (survives a process restart).
    const cp = await sql.query("SELECT COUNT(*)::int AS n FROM agents.checkpoints WHERE thread_id = $1", [threadId]);
    expect(cp.rows[0].n).toBeGreaterThan(0);
  });

  it("turn 2: approve callback resumes the SAME paused run — send fires once, audited, state intact", async () => {
    const { resumeOffice } = await import("../../src/gateway/office-run.js");

    const replies: Reply[] = [];
    await resumeOffice(fakeCtx(chatId, replies), "approved");

    // The transport was called exactly once with the payload drafted before the pause.
    expect(h.providerSendEmail).toHaveBeenCalledTimes(1);
    expect(h.providerSendEmail.mock.calls[0]![0]).toMatchObject({ to: EMAIL_TO, subject: EMAIL_SUBJECT });

    // Founder got a real completion reply, not a dropped turn.
    const all = replies.map((r) => r.text).join("\n");
    expect(all).toContain(EMAIL_TO);

    // REAL Postgres: idempotency audit row written (rule #5).
    const audit = await sql.query(
      "SELECT idempotency_key, payload FROM agents.action_log WHERE action = 'send_email' AND payload->>'to' = $1",
      [EMAIL_TO],
    );
    expect(audit.rows.length).toBeGreaterThan(0);
    expect(audit.rows[0].idempotency_key).toMatch(/^email:turicks:[0-9a-f]{16}$/);

    // REAL Postgres: the interrupt was resolved, not orphaned.
    const hitl = await sql.query(
      "SELECT status FROM agents.hitl_approvals WHERE thread_id = $1",
      [threadId],
    );
    expect(hitl.rows).toHaveLength(1);
    expect(hitl.rows[0].status).toBe("approved");

    // State was NOT dropped across the pause: the thread still holds the original
    // human payload from turn 1 in its checkpointed history.
    const { getOffice } = await import("../../src/agents/office.js");
    const office = await getOffice();
    const state = await office.getState({ configurable: { thread_id: threadId } });
    const contents = (state.values?.messages ?? []).map((m: { content?: unknown }) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
    );
    expect(contents.some((c: string) => c.includes(`Send an email to ${EMAIL_TO}`))).toBe(true);
    // And no pending interrupt remains.
    const pending = (state.tasks ?? []).flatMap((t: { interrupts?: unknown[] }) => t.interrupts ?? []);
    expect(pending).toHaveLength(0);
  });

  it("idempotency: replaying the approved action does not double-send", async () => {
    // Re-executing the same email through the audited tool path must skip.
    const { emailTool } = await import("../../src/tools/email.js");
    const { idemKey } = await import("../../src/agents/agent-tools/hitl.js");

    const res = await emailTool.execute({
      to: EMAIL_TO,
      subject: EMAIL_SUBJECT,
      body: EMAIL_BODY,
      idempotency_key: idemKey("email", EMAIL_TO, EMAIL_SUBJECT, EMAIL_BODY),
      tenant_id: "turicks",
      department: "comms",
    });

    expect(res.success).toBe(true);
    expect((res.data as { skipped?: boolean }).skipped).toBe(true);
    // Transport still only ever fired once, in turn 2.
    expect(h.providerSendEmail).toHaveBeenCalledTimes(1);
  });
});
