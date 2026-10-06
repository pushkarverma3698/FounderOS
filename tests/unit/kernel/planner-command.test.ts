/**
 * Plain words → slash command. The planner may answer {"type":"command"}; the kernel only
 * NAMES the command, and code (not the model) refuses a name that is not in the catalog.
 */

import { describe, expect, it } from "vitest";
import { MemorySaver } from "@langchain/langgraph";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import {
  buildKernel,
  kernelCommand,
  type CommandCatalogEntry,
  type KernelBindableModel,
} from "../../../src/kernel/index.js";
import { buildPlannerPrompt, makePlanNode, type KernelChatModel } from "../../../src/kernel/planner.js";
import type { KernelStateType, KernelUpdate } from "../../../src/kernel/state.js";
import type { FailureReport, PlannedCommand } from "../../../src/kernel/contracts.js";

const commands: CommandCatalogEntry[] = [
  { name: "where", description: "Where are we. where founderos for one", mutating: false },
  { name: "task", description: "Build something", mutating: true },
];

const cmd = (name: string, args?: string) => JSON.stringify({ type: "command", name, ...(args !== undefined ? { args } : {}) });

function stateFor(input: string): KernelStateType {
  return {
    turn: { id: "t1", chat_id: "c1", received_at: new Date().toISOString(), raw_input: input },
    mission: { goal: "", status: "idle", plan: null, cursor: 0 },
    results: [], attempts: {}, scratch: {}, step_receipts: {}, failure: null, reply: "",
    history: [], last_turn: null, command: null, lesson_candidate: null,
  } as unknown as KernelStateType;
}

function scripted(responses: string[]): KernelChatModel & { calls: BaseMessage[][] } {
  const calls: BaseMessage[][] = [];
  return {
    calls,
    async invoke(messages: BaseMessage[]) {
      calls.push(messages);
      return new AIMessage(responses[calls.length - 1] ?? responses[responses.length - 1]!);
    },
  };
}

const commandOf = (u: KernelUpdate) => u.command as PlannedCommand | null | undefined;
const failureOf = (u: KernelUpdate) => u.failure as FailureReport | null | undefined;

describe("plan node — command decision", () => {
  it("routes a catalogued command: no plan, command set, history keeps what ran", async () => {
    const model = scripted([cmd("where", "oplify")]);
    const update = await makePlanNode(model, [], undefined, commands)(stateFor("where are we on oplify"));
    expect(commandOf(update)).toEqual({ name: "where", args: "oplify" });
    expect(update.mission).toMatchObject({ status: "done", plan: null });
    expect(update.reply).toBe("Ran /where oplify");
    expect(failureOf(update)).toBeNull();
  });

  it("normalizes a slash and case, and a missing args field is empty", async () => {
    const update = await makePlanNode(scripted([cmd("/Where")]), [], undefined, commands)(stateFor("where are we"));
    expect(commandOf(update)).toEqual({ name: "where", args: "" });
    expect(update.reply).toBe("Ran /where");
  });

  it("refuses an invented command with a correction retry, then accepts a real one", async () => {
    const model = scripted([cmd("deploy", "prod"), cmd("task", "fix login")]);
    const update = await makePlanNode(model, [], undefined, commands)(stateFor("ship it"));
    expect(model.calls).toHaveLength(2);
    expect(JSON.stringify(model.calls[1])).toContain("/deploy is not a command");
    expect(commandOf(update)).toEqual({ name: "task", args: "fix login" });
  });

  it("two invented commands in a row is a loud planning failure, never a silent run", async () => {
    const update = await makePlanNode(scripted([cmd("deploy")]), [], undefined, commands)(stateFor("ship it"));
    expect(commandOf(update)).toBeNull();
    expect(failureOf(update)).toMatchObject({ stage: "planning", component: "kernel/planner" });
  });

  it("with no catalog, any command answer is refused (plan/reply only)", async () => {
    const update = await makePlanNode(scripted([cmd("where")]), [])(stateFor("where are we"));
    expect(failureOf(update)).toMatchObject({ stage: "planning" });
  });

  it("clears the command on a turn that does not choose one", async () => {
    const update = await makePlanNode(
      scripted([JSON.stringify({ type: "reply", text: "hi" })]), [], undefined, commands,
    )({ ...stateFor("hello"), command: { name: "where", args: "" } } as KernelStateType);
    expect(commandOf(update)).toBeNull();
  });
});

describe("planner prompt — command section", () => {
  it("lists each command with its usage and marks the ones that change things", () => {
    const prompt = buildPlannerPrompt([], commands);
    expect(prompt).toContain('{"type":"command"');
    expect(prompt).toContain("- where: Where are we. where founderos for one");
    expect(prompt).toContain("- task: Build something [changes things: the founder taps to confirm]");
  });

  it("is byte-identical to before when no commands are supplied", () => {
    expect(buildPlannerPrompt([])).not.toContain("Command");
    expect(buildPlannerPrompt([], [])).toBe(buildPlannerPrompt([]));
  });
});

describe("full graph — a command turn", () => {
  it("ends the turn with state.command set and runs no worker", async () => {
    let workerCalls = 0;
    const worker: KernelBindableModel = {
      bindTools() { return this; },
      async invoke() { workerCalls += 1; return new AIMessage("x"); },
    };
    const kernel = buildKernel({
      plannerModel: scripted([cmd("where", "founderos")]),
      workerModel: worker,
      synthesizerModel: scripted(["unused"]),
      workers: [],
      commands,
      checkpointer: new MemorySaver(),
    });
    const state = (await kernel.invoke(
      { turn: { id: "t1", chat_id: "1", received_at: new Date().toISOString(), raw_input: "where are we on founderos" } },
      { configurable: { thread_id: "cmd-1" } },
    )) as KernelStateType;
    expect(kernelCommand(state)).toEqual({ name: "where", args: "founderos" });
    expect(workerCalls).toBe(0);
    expect(state.mission.status).toBe("done");
  });
});


describe("planner prompt — goals from plain words", () => {
  const goal: CommandCatalogEntry = { name: "goal", description: "goal add title | metric=key target=n", mutating: true };

  it("tells the planner to leave the metric out of a goal (the founder picks it with buttons)", () => {
    const prompt = buildPlannerPrompt([], [goal]);
    expect(prompt).toContain("goal add");
    expect(prompt).toContain("Leave metric out");
    expect(prompt).toContain("add Apply to 20 jobs | target=20");
  });

  it("says nothing about goals when the command is not offered", () => {
    expect(buildPlannerPrompt([], commands)).not.toContain("Leave metric out");
  });
});
