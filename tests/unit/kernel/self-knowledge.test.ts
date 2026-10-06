/**
 * Self-knowledge from the registry. "What can you do / list your tools / can you send email"
 * is answered by pure code from the live worker tool lists — the model is never asked, so it
 * cannot add a department or a tool that does not exist.
 *
 * Incident: answer_evaluations 2026-09-29, groundedness 50/100. "List all tools available in
 * FounderOS by department" got Research and Sales tools that are not registered.
 */

import { describe, expect, it } from "vitest";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { DEPARTMENT_TOOLS, HITL_GATED_TOOLS } from "../../../src/agents/capabilities.js";
import { answerSelfKnowledge, type SelfKnowledgeDepartment } from "../../../src/kernel/self-knowledge.js";
import { makePlanNode, type KernelChatModel } from "../../../src/kernel/planner.js";
import type { KernelStateType } from "../../../src/kernel/state.js";

const PROD_QUESTION = "List all tools available in FounderOS by department";

const fixture: SelfKnowledgeDepartment[] = [
  { id: "admin", toolNames: ["read_context", "set_reminder"] },
  { id: "comms", toolNames: ["send_email", "read_emails", "create_calendar_event"] },
  { id: "marketing", toolNames: ["linkedin_post", "generate_image"] },
  { id: "personal", toolNames: ["read_file", "run_shell"] },
];
const fixtureGated = new Set(["send_email", "linkedin_post", "run_shell"]);

const live: SelfKnowledgeDepartment[] = Object.entries(DEPARTMENT_TOOLS).map(([id, tools]) => ({
  id,
  toolNames: tools.map((t) => String((t as { name: string }).name)),
}));

const ask = (text: string, depts = fixture, gated: ReadonlySet<string> = fixtureGated) =>
  answerSelfKnowledge(text, depts, gated);

/** Every `backticked` word in a reply. */
const quoted = (reply: string): string[] => [...reply.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);

describe("listing questions", () => {
  it("answers the exact prod question from the registry, grouped by department", () => {
    const reply = ask(PROD_QUESTION, live, HITL_GATED_TOOLS)!;
    expect(reply).not.toBeNull();
    for (const d of live) expect(reply).toContain(`**${d.id}**`);
    const known = new Set(live.flatMap((d) => d.toolNames));
    const names = quoted(reply);
    expect(names.length).toBeGreaterThan(40);
    for (const n of names) expect(known.has(n), `${n} is not a registered tool`).toBe(true);
    for (const n of known) expect(names).toContain(n);
  });

  it("names no department or tool that is not in the registry", () => {
    const reply = ask(PROD_QUESTION)!;
    for (const absent of ["research", "sales", "engineering", "jobhunt"]) {
      expect(reply.toLowerCase()).not.toContain(absent);
    }
    expect(quoted(reply).sort()).toEqual(fixture.flatMap((d) => d.toolNames).sort());
  });

  it("marks gated tools as asking first and leaves the rest unmarked", () => {
    const reply = ask("what tools do you have")!;
    expect(reply).toMatch(/\*\*comms\*\*[^]*Asks first: `send_email`/);
    expect(reply).toMatch(/\*\*personal\*\*[^]*Asks first: `run_shell`/);
    expect(reply).not.toMatch(/Asks first:[^\n]*`read_file`/);
    expect(reply).not.toMatch(/\*\*admin\*\*[^]*Asks first[^]*\*\*comms\*\*/);
  });

  it.each([
    "what can you do",
    "What can you do?",
    "what can you do for me",
    "list your tools",
    "show me your capabilities",
    "which tools do you have by department",
    "what are your capabilities",
  ])("recognises %j", (text) => {
    expect(ask(text)).not.toBeNull();
  });

  it("scopes to one department when one is named", () => {
    const reply = ask("what tools does marketing have")!;
    expect(reply).toContain("`linkedin_post`");
    expect(reply).not.toContain("`send_email`");
  });

  it.each([
    "what can you do about the failing build in oplify",
    "what tools did you use yesterday",
    "list the tools you used to research Acme and then email the summary to Priya",
    "show me the jobs",
    "what is the weather",
    "",
  ])("leaves %j to the planner", (text) => {
    expect(ask(text)).toBeNull();
  });
});

describe("capability questions", () => {
  it("answers yes from the registry and says which tool, and that it asks first", () => {
    const reply = ask("can you send email")!;
    expect(reply).toMatch(/^Yes/);
    expect(reply).toContain("`send_email`");
    expect(reply).toContain("asks first");
    expect(reply).not.toContain("`linkedin_post`");
  });

  it("says plainly when the capability does not exist", () => {
    const reply = ask("do you have a tool for tweets")!;
    expect(reply).toMatch(/^No/);
    expect(reply).toContain("tweets");
    expect(reply).not.toContain("`");
  });

  it("says no for an explicit tool question about a missing integration", () => {
    expect(ask("do you have a tool for salesforce")).toMatch(/^No/);
  });

  it("does not claim a tool exists for a bare verb it does not have", () => {
    expect(ask("can you tweet")).toMatch(/^No/);
  });

  it.each([
    "can you email john about the invoice",
    "can you write me a poem",
    "can you help me",
    "do you have time",
    "can you summarize this",
    // A request about one particular thing is an instruction to act, never a capability question.
    "can you send it",
    "can you schedule this",
    "can you send the email",
    "can you read my email",
    "can you call me",
    // A noun after a verb may be a person or a thing; "no tool for tashi" would be false.
    "can you message tashi",
    "can you send tweets",
    // A bare noun or an unmatched verb is not proof that a tool covers it.
    "can you apply",
    "can you upload cv",
  ])("passes the request %j to the planner", (text) => {
    expect(ask(text)).toBeNull();
  });
});

describe("plan node", () => {
  const stateFor = (input: string): KernelStateType =>
    ({
      turn: { id: "t1", chat_id: "c1", received_at: new Date().toISOString(), raw_input: input },
      mission: { goal: "", status: "idle", plan: null, cursor: 0 },
      results: [], attempts: {}, scratch: {}, step_receipts: {}, failure: null, reply: "",
      history: [], last_turn: null, command: null, lesson_candidate: null,
    }) as unknown as KernelStateType;

  const catalog = fixture.map((d) => ({ id: d.id as never, description: "", toolNames: [...d.toolNames], gatedToolNames: [] }));

  it("replies from the registry without calling the model", async () => {
    let calls = 0;
    const model: KernelChatModel = {
      async invoke(_m: BaseMessage[]) {
        calls += 1;
        return new AIMessage('{"type":"reply","text":"Research tools: deep_research, sales_pipeline"}');
      },
    };
    const update = await makePlanNode(model, catalog, undefined, [], undefined, undefined, fixtureGated)(stateFor(PROD_QUESTION));
    expect(calls).toBe(0);
    expect(update.mission).toMatchObject({ status: "done", plan: null });
    expect(update.failure).toBeNull();
    expect(String(update.reply)).toContain("`send_email`");
    expect(String(update.reply)).not.toContain("sales_pipeline");
  });

  it("still sends an ordinary message to the model", async () => {
    let calls = 0;
    const model: KernelChatModel = {
      async invoke() {
        calls += 1;
        return new AIMessage('{"type":"reply","text":"hi"}');
      },
    };
    const update = await makePlanNode(model, catalog, undefined, [], undefined, undefined, fixtureGated)(stateFor("hello there"));
    expect(calls).toBe(1);
    expect(update.reply).toBe("hi");
  });
});
