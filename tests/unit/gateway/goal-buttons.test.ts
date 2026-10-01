/**
 * The goal buttons: "Plan next step" and the metric choices. What these tests hold:
 *   - every tap is checked with mayActAsOwner BEFORE anything else, exactly like the HITL approval
 *     callbacks, so a guest tap runs no kernel turn and reads no storage;
 *   - a second tap while a run is in flight is refused, not doubled. The kernel lock QUEUES a second
 *     turn (it does not refuse it) and grammY handles updates one at a time, so the guard is per goal
 *     and the run is detached from the handler;
 *   - callback data stays inside Telegram's 64 bytes;
 *   - a picker double-tap cannot create the goal twice.
 */

import { describe, it, expect, vi } from "vitest";
import { handleGoalCallback } from "../../../src/gateway/goal-buttons.js";
import { buildChatAccessConfig } from "../../../src/gateway/chat-access.js";
import { encodeGoalCallback, type GoalCallback } from "../../../src/goals/callbacks.js";
import { ALLOWED_GROUP, GUEST, OWNER, makeCtx, makeDeps, seedGoal, type GoalHarness } from "../../helpers/goal-gateway.js";

const access = buildChatAccessConfig({ primaryChatId: String(OWNER), allowedChatIds: String(ALLOWED_GROUP) });

const dataFor = (cb: GoalCallback): string => encodeGoalCallback(cb) as string;

async function tap(h: GoalHarness, data: string, o: Parameters<typeof makeCtx>[0] = {}) {
  const c = makeCtx({ ...o, callback: { data, ...(o.callback ?? {}) } });
  const handled = await handleGoalCallback(c.ctx, access, h.deps);
  return { ...c, handled };
}

describe("payloads that are not ours", () => {
  it("returns false and does nothing for another handler's button, so approve/reject and the rest still route", async () => {
    const h = makeDeps();
    for (const data of ["approve:abc", "reject:abc", "task:repo:FounderOS", "retry:abcd1234", "menu:home"]) {
      const c = await tap(h, data);
      expect(c.handled, data).toBe(false);
      expect(c.answers, data).toEqual([]);
    }
    expect(h.deps.repo).not.toHaveBeenCalled();
  });

  it("refuses a malformed goal payload without running anything", async () => {
    const h = makeDeps();
    const c = await tap(h, "goal:p:short");
    expect(c.handled).toBe(true);
    expect(c.answers[0]).toMatchObject({ show_alert: true });
    expect(h.deps.runKernelText).not.toHaveBeenCalled();
  });
});

describe("Plan next step — who may tap it", () => {
  it("lets the owner in his own chat start a kernel turn on the code-built prompt", async () => {
    const h = makeDeps();
    const g = await seedGoal(h, { title: "Tashi applies", metric_key: "applications_7d", metric_arg: "wife-nl-finance", target: 5, due_on: "2026-10-31" });
    await h.repo.claimReviews("t", [g.id], "2026-09-28", new Date("2026-09-28T07:00:00Z"), 300000);
    await h.repo.saveReviewResults("2026-09-28", [{ goalId: g.id, value: 1, evidence: "1 application for wife-nl-finance from 2026-09-21 to 2026-09-28", pace: "behind", error: null }]);

    const c = await tap(h, dataFor({ kind: "plan", goalId: g.id }));

    expect(c.handled).toBe(true);
    expect(h.deps.runKernelText).toHaveBeenCalledTimes(1);
    const prompt = h.kernel.prompts[0]!;
    expect(prompt).toContain('Goal 1: "Tashi applies"');
    expect(prompt).toContain("- 2026-09-28: 1 (behind): 1 application for wife-nl-finance");
    expect(prompt).toContain("at most 3 concrete actions");
    expect(c.answers[0]).toMatchObject({ text: expect.stringMatching(/planning/i) });
  });

  it("refuses a guest in an allow-listed group: NO kernel run and no storage read", async () => {
    const h = makeDeps();
    const g = await seedGoal(h);
    const c = await tap(h, dataFor({ kind: "plan", goalId: g.id }), { fromId: GUEST, chatId: ALLOWED_GROUP });
    expect(c.handled).toBe(true);
    expect(c.answers[0]).toMatchObject({ show_alert: true, text: expect.stringMatching(/only the owner/i) });
    expect(h.deps.runKernelText).not.toHaveBeenCalled();
    expect(h.deps.repo).not.toHaveBeenCalled();
    expect(h.deps.metrics).not.toHaveBeenCalled();
    expect(h.deps.planGuard.tryStart(g.id)).toBe(true); // and no guard was left set
  });

  it("refuses a chat that is not allowed at all", async () => {
    const h = makeDeps();
    const g = await seedGoal(h);
    const c = await tap(h, dataFor({ kind: "plan", goalId: g.id }), { fromId: GUEST, chatId: -100999 });
    expect(c.answers[0]).toMatchObject({ show_alert: true });
    expect(h.deps.runKernelText).not.toHaveBeenCalled();
  });

  it("lets the founder himself tap it in a group he is in, and only him", async () => {
    const h = makeDeps();
    const g = await seedGoal(h);
    await tap(h, dataFor({ kind: "plan", goalId: g.id }), { fromId: OWNER, chatId: ALLOWED_GROUP });
    expect(h.deps.runKernelText).toHaveBeenCalledTimes(1);
  });

  it("checks the picker buttons the same way: a guest cannot create a goal through them", async () => {
    const h = makeDeps();
    const c = await tap(h, dataFor({ kind: "metric", family: "manual" }), {
      fromId: GUEST,
      chatId: ALLOWED_GROUP,
      callback: { data: dataFor({ kind: "metric", family: "manual" }), replyTo: { text: "/goal add x | target=1", message_id: 5 } },
    });
    expect(c.answers[0]).toMatchObject({ show_alert: true });
    expect(await h.repo.listOpenGoals("t")).toEqual([]);
    expect(h.deps.repo).not.toHaveBeenCalled();
  });
});

describe("edge: Plan next step tapped twice", () => {
  it("refuses the second tap while the first run is in flight (not doubled), then runs again once it has finished", async () => {
    const h = makeDeps();
    const g = await seedGoal(h);
    let finish!: () => void;
    (h.deps.runKernelText as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise<void>((resolve) => void (finish = resolve)));

    const first = await tap(h, dataFor({ kind: "plan", goalId: g.id }));
    const second = await tap(h, dataFor({ kind: "plan", goalId: g.id }));

    expect(first.answers[0]!.text).toMatch(/planning/i);
    expect(second.answers[0]).toMatchObject({ text: expect.stringMatching(/already planning/i) });
    expect(h.deps.runKernelText).toHaveBeenCalledTimes(1);

    finish();
    await vi.waitFor(() => expect(h.deps.planGuard.tryStart(g.id)).toBe(true));
    h.deps.planGuard.finish(g.id);
    await tap(h, dataFor({ kind: "plan", goalId: g.id }));
    expect(h.deps.runKernelText).toHaveBeenCalledTimes(2);
  });

  it("does not hold the handler for the whole run: the bot handles updates one at a time, so waiting would block every other tap", async () => {
    const h = makeDeps();
    const g = await seedGoal(h);
    (h.deps.runKernelText as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise<void>(() => undefined));
    const started = Date.now();
    await tap(h, dataFor({ kind: "plan", goalId: g.id }));
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("lets a different goal's tap through: the kernel's own lock serialises the two turns", async () => {
    const h = makeDeps();
    const a = await seedGoal(h, { title: "A" });
    const b = await seedGoal(h, { title: "B" });
    (h.deps.runKernelText as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise<void>(() => undefined));
    await tap(h, dataFor({ kind: "plan", goalId: a.id }));
    await tap(h, dataFor({ kind: "plan", goalId: b.id }));
    expect(h.deps.runKernelText).toHaveBeenCalledTimes(2);
  });

  it("frees the goal when the run fails, tells the founder, and logs the component", async () => {
    const h = makeDeps();
    const g = await seedGoal(h);
    (h.deps.runKernelText as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("kernel exploded"));
    const c = await tap(h, dataFor({ kind: "plan", goalId: g.id }));
    await vi.waitFor(() => expect(h.log.error).toHaveBeenCalledWith(expect.objectContaining({ component: "goal-buttons" }), expect.stringContaining("Plan next step")));
    await vi.waitFor(() => expect(c.replies.some((r) => r.text.includes("Could not plan"))).toBe(true));
    // The guard is released once the founder has been told; wait for that, then tap again.
    await vi.waitFor(() => expect(h.deps.planGuard.tryStart(g.id)).toBe(true));
    h.deps.planGuard.finish(g.id);
    await tap(h, dataFor({ kind: "plan", goalId: g.id }));
    expect(h.deps.runKernelText).toHaveBeenCalledTimes(2);
  });

  it("frees the goal when the storage read fails before the run starts", async () => {
    const h = makeDeps();
    const g = await seedGoal(h);
    h.repo.before.getGoal = () => {
      throw new Error("connection refused");
    };
    const c = await tap(h, dataFor({ kind: "plan", goalId: g.id }));
    expect(c.answers.at(-1)).toMatchObject({ show_alert: true });
    expect(h.deps.runKernelText).not.toHaveBeenCalled();
    expect(h.deps.planGuard.tryStart(g.id)).toBe(true);
  });

  it("says a goal that is no longer open is no longer open, and runs nothing", async () => {
    const h = makeDeps();
    const g = await seedGoal(h);
    await h.repo.updateStatus("t", g.id, { status: "done" }, new Date());
    const c = await tap(h, dataFor({ kind: "plan", goalId: g.id }));
    expect(c.answers[0]).toMatchObject({ text: expect.stringMatching(/no longer open/i) });
    expect(h.deps.runKernelText).not.toHaveBeenCalled();
    expect(h.deps.planGuard.tryStart(g.id)).toBe(true);
  });
});

describe("metric choice buttons", () => {
  const ORIGINAL = { message_id: 77 };

  it("completes the goal from the founder's own message when the chosen metric needs no argument", async () => {
    const h = makeDeps();
    const c = await tap(h, dataFor({ kind: "metric", family: "manual" }), {
      callback: { data: dataFor({ kind: "metric", family: "manual" }), messageId: 50, replyTo: { ...ORIGINAL, text: "/goal add Ship a fix | target=1" } },
    });
    expect(c.handled).toBe(true);
    const [goal] = await h.repo.listOpenGoals("t");
    expect(goal).toMatchObject({ title: "Ship a fix", metric_key: "manual", target: 1 });
    expect(c.replies[0]!.text).toContain("Goal 1 added: “Ship a fix”");
    expect(c.replies[0]!.opts!.reply_parameters).toEqual({ message_id: 77, allow_sending_without_reply: true });
    expect(c.edits).toHaveLength(1); // the spent keyboard is cleared
  });

  it("asks for the argument next, as buttons, as a reply to the ORIGINAL message so the next tap can read it again", async () => {
    const h = makeDeps();
    const c = await tap(h, dataFor({ kind: "metric", family: "applications_7d" }), {
      callback: { data: dataFor({ kind: "metric", family: "applications_7d" }), messageId: 50, replyTo: { ...ORIGINAL, text: "/goal add Tashi applies | target=5" } },
    });
    expect(await h.repo.listOpenGoals("t")).toEqual([]);
    expect(c.replies[0]!.text).toContain("<b>metric</b>");
    expect(c.replies[0]!.opts!.reply_parameters).toEqual({ message_id: 77, allow_sending_without_reply: true });
    expect(c.replies[0]!.opts!.reply_markup!.inline_keyboard.flat().map((b) => b.text)).toEqual(["pushkar-nl-tech", "wife-nl-finance"]);
  });

  it("creates the goal when the argument is chosen", async () => {
    const h = makeDeps();
    const data = dataFor({ kind: "arg", family: "applications_7d", arg: "wife-nl-finance" });
    const c = await tap(h, data, { callback: { data, messageId: 51, replyTo: { ...ORIGINAL, text: "/goal add Tashi applies | target=5 by=2026-10-31" } } });
    const [goal] = await h.repo.listOpenGoals("t");
    expect(goal).toMatchObject({ title: "Tashi applies", metric_key: "applications_7d", metric_arg: "wife-nl-finance", target: 5, due_on: "2026-10-31" });
    expect(c.replies[0]!.text).toContain("applications_7d:wife-nl-finance");
  });

  it("re-validates a tapped argument against the live registry: a stale or forged profile creates nothing", async () => {
    const h = makeDeps();
    const data = dataFor({ kind: "arg", family: "applications_7d", arg: "nobody" });
    const c = await tap(h, data, { callback: { data, messageId: 52, replyTo: { ...ORIGINAL, text: "/goal add x | target=5" } } });
    expect(await h.repo.listOpenGoals("t")).toEqual([]);
    expect(c.replies[0]!.text).toContain("nobody");
  });

  it("cannot create the same goal twice from one picker: a second tap on it is answered, not acted on", async () => {
    const h = makeDeps();
    const data = dataFor({ kind: "metric", family: "manual" });
    const o = { callback: { data, messageId: 60, replyTo: { ...ORIGINAL, text: "/goal add Ship a fix | target=1" } } };
    await tap(h, data, o);
    const again = await tap(h, data, o);
    expect(again.answers[0]).toMatchObject({ text: expect.stringMatching(/already/i) });
    expect(await h.repo.listOpenGoals("t")).toHaveLength(1);
  });

  it("says so when the founder's original message can no longer be read, instead of guessing", async () => {
    const h = makeDeps();
    for (const replyTo of [undefined, { ...ORIGINAL, text: "/task fix the login" }, { ...ORIGINAL }]) {
      const data = dataFor({ kind: "metric", family: "manual" });
      const c = await tap(h, data, { callback: { data, messageId: 70 + Math.floor(Math.random() * 1000), ...(replyTo ? { replyTo } : {}) } });
      expect(c.answers[0], JSON.stringify(replyTo)).toMatchObject({ show_alert: true });
    }
    expect(await h.repo.listOpenGoals("t")).toEqual([]);
  });

  it("keeps every button it sends inside 64 bytes", async () => {
    const h = makeDeps();
    const data = dataFor({ kind: "metric", family: "prs_merged_7d" });
    const c = await tap(h, data, { callback: { data, messageId: 80, replyTo: { ...ORIGINAL, text: "/goal add x | target=1" } } });
    for (const b of c.replies[0]!.opts!.reply_markup!.inline_keyboard.flat()) expect(Buffer.byteLength(b.callback_data, "utf8")).toBeLessThanOrEqual(64);
  });
});
