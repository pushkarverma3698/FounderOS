/**
 * /goal and /goals as the founder meets them: what each command replies, that every reply names the goal
 * it touched (so a list that shifted under him is noticed), that nothing is ever deleted, and that a bad
 * input is answered with the exact field that is wrong — with buttons where the options are finite.
 */

import { describe, it, expect, vi } from "vitest";
import { handleGoal, handleGoals } from "../../../src/gateway/goal-commands.js";
import { replySkippedStandups } from "../../../src/gateway/goal-resume.js";
import { decodeGoalCallback } from "../../../src/goals/callbacks.js";
import { MemorySkips, makeCtx, makeDeps, seedGoal } from "../../helpers/goal-gateway.js";
import { TELEGRAM_MAX_CHARS } from "../../../src/tools/jobhunt/telegram-format.js";

const ADD = "add Tashi applies to 5 NL roles a week | metric=applications_7d:wife-nl-finance target=5 by=2026-10-31";

async function run(h: ReturnType<typeof makeDeps>, match: string, opts: Parameters<typeof makeCtx>[0] = {}) {
  const c = makeCtx({ match, ...opts });
  await handleGoal(c.ctx, h.deps);
  return c;
}

describe("/goal — no arguments", () => {
  it("teaches the whole grammar, names every metric, and touches no storage", async () => {
    const h = makeDeps();
    const { replies } = await run(h, "");
    expect(replies).toHaveLength(1);
    const text = replies[0]!.text;
    for (const needle of ["/goals", "/goal add", "/goal done", "/goal drop", "/goal block", "/goal unblock", "applications_7d", "prs_merged_7d", "issues_closed_7d", "action_count_7d", "manual"]) {
      expect(text, needle).toContain(needle);
    }
    expect(text).not.toMatch(/<n>|<value>/); // placeholders are escaped, or Telegram reads them as tags
    expect(h.deps.repo).not.toHaveBeenCalled();
  });
});

describe("/goal add", () => {
  it("creates the goal and echoes its number, title, metric, target and due date", async () => {
    const h = makeDeps();
    const { replies } = await run(h, ADD);
    const [goal] = await h.repo.listOpenGoals("t");
    expect(goal).toMatchObject({ title: "Tashi applies to 5 NL roles a week", metric_key: "applications_7d", metric_arg: "wife-nl-finance", target: 5, due_on: "2026-10-31", priority: 100, status: "active" });
    expect(replies[0]!.text).toContain("Goal 1 added: “Tashi applies to 5 NL roles a week”");
    expect(replies[0]!.text).toContain("applications_7d:wife-nl-finance");
    expect(replies[0]!.text).toContain("target 5");
    expect(replies[0]!.text).toContain("31 Oct");
  });

  it("says which number the new goal took in the ordered list, not just 'added'", async () => {
    const h = makeDeps();
    await seedGoal(h, { title: "First" });
    await seedGoal(h, { title: "Second" });
    const { replies } = await run(h, "add Urgent one | metric=manual target=3 priority=10");
    expect(replies[0]!.text).toContain("Goal 1 added: “Urgent one”");
    const later = await run(h, "add Late one | metric=manual target=3");
    expect(later.replies[0]!.text).toContain("Goal 4 added: “Late one”");
  });

  it("tells a manual goal how its value is reported", async () => {
    const h = makeDeps();
    const { replies } = await run(h, "add Reach 5k | metric=manual target=5000");
    expect(replies[0]!.text).toContain("/goal 1 &lt;value&gt;");
  });

  it("escapes the founder's title so one < or & cannot make Telegram refuse the reply", async () => {
    const h = makeDeps();
    const { replies } = await run(h, "add Ship <fast> & well | metric=manual target=1");
    expect(replies[0]!.text).toContain("Ship &lt;fast&gt; &amp; well");
    expect(replies[0]!.text).not.toContain("<fast>");
  });

  it("refuses with the exact field named, creates nothing, and offers the metric keys as buttons when the metric is missing", async () => {
    const h = makeDeps();
    const { replies } = await run(h, "add Ship a fix | target=1", { messageId: 77 });
    expect(await h.repo.listOpenGoals("t")).toEqual([]);
    const reply = replies[0]!;
    expect(reply.text).toContain("<b>metric</b>");
    expect(reply.text).toContain("metric is missing");
    const buttons = reply.opts!.reply_markup!.inline_keyboard.flat();
    expect(buttons.map((b) => b.text)).toEqual(["applications_7d", "prs_merged_7d", "issues_closed_7d", "action_count_7d", "manual"]);
    // The picker is a reply to the founder's message: the conversation is the state.
    // ...and survives him deleting his command: without allow_sending_without_reply Telegram would refuse it.
    expect(reply.opts!.reply_parameters).toEqual({ message_id: 77, allow_sending_without_reply: true });
    expect(buttons.map((b) => decodeGoalCallback(b.callback_data))).toEqual(
      ["applications_7d", "prs_merged_7d", "issues_closed_7d", "action_count_7d", "manual"].map((family) => ({ kind: "metric", family })),
    );
  });

  it("lists every problem at once, each with its own field", async () => {
    const h = makeDeps();
    const { replies } = await run(h, "add | target=abc by=nope");
    for (const field of ["title", "metric", "target", "by"]) expect(replies[0]!.text, field).toContain(`<b>${field}</b>`);
  });

  it("asks which profile with the registered profiles as buttons, when the metric needs one", async () => {
    const h = makeDeps();
    const { replies } = await run(h, "add x | metric=applications_7d target=5");
    const buttons = replies[0]!.opts!.reply_markup!.inline_keyboard.flat();
    expect(buttons.map((b) => b.text)).toEqual(["pushkar-nl-tech", "wife-nl-finance"]);
    expect(decodeGoalCallback(buttons[1]!.callback_data)).toEqual({ kind: "arg", family: "applications_7d", arg: "wife-nl-finance" });
  });

  it("asks which repo with the dispatchable repos as buttons, and never offers an employer's", async () => {
    const h = makeDeps({
      repoChoices: vi.fn(async () => ["pushkarverma3698/FounderOS", "OplifyMessage/oplify-messaging-app", "pushkarverma3698/House-of-Hulda-Website-frontend"]),
    });
    const { replies } = await run(h, "add x | metric=prs_merged_7d target=1");
    const args = replies[0]!.opts!.reply_markup!.inline_keyboard.flat().map((b) => (decodeGoalCallback(b.callback_data) as { arg: string }).arg);
    expect(args).toEqual(["pushkarverma3698/FounderOS", "pushkarverma3698/House-of-Hulda-Website-frontend"]);
  });

  it("offers no buttons for an action name (not a finite list) but still says what to write", async () => {
    const h = makeDeps();
    const { replies } = await run(h, "add x | metric=action_count_7d target=3");
    expect(replies[0]!.opts?.reply_markup).toBeUndefined();
    expect(replies[0]!.text).toContain("action_count_7d:&lt;action&gt;");
  });

  it("keeps every callback payload inside Telegram's 64 bytes", async () => {
    const h = makeDeps();
    for (const args of ["add x | target=1", "add x | metric=applications_7d target=5", "add x | metric=prs_merged_7d target=1"]) {
      const { replies } = await run(h, args);
      for (const b of replies[0]!.opts!.reply_markup!.inline_keyboard.flat()) expect(Buffer.byteLength(b.callback_data, "utf8")).toBeLessThanOrEqual(64);
    }
  });
});

describe("/goal <n> <value>", () => {
  it("records a value for a manual goal, echoing the goal, and says when it reaches the target", async () => {
    const h = makeDeps();
    const g = await seedGoal(h, { title: "Reach 5k", target: 5000 });
    const first = await run(h, "1 1200");
    expect(first.replies[0]!.text).toContain("Goal 1 “Reach 5k”: recorded 1,200");
    expect(first.replies[0]!.text).toContain("target 5,000");
    expect((await h.repo.getGoal("t", g.id))!.manual_value).toBe(1200);
    const met = await run(h, "1 5200");
    expect(met.replies[0]!.text).toContain("reaches the target");
    expect(met.replies[0]!.text).toContain("next standup marks it done");
  });

  it("records a 0 as 0 and mentions what it replaced", async () => {
    const h = makeDeps();
    const g = await seedGoal(h, { title: "Reach 5k", target: 5000 });
    await run(h, "1 300");
    const { replies } = await run(h, "1 0");
    expect((await h.repo.getGoal("t", g.id))!.manual_value).toBe(0);
    expect(replies[0]!.text).toContain("recorded 0");
    expect(replies[0]!.text).toContain("was 300");
  });

  it("refuses a goal that is measured automatically, naming its metric", async () => {
    const h = makeDeps();
    const g = await seedGoal(h, { title: "Apps", metric_key: "applications_7d", metric_arg: "wife-nl-finance" });
    const { replies } = await run(h, "1 4");
    expect(replies[0]!.text).toContain("Goal 1 “Apps” is measured automatically (applications_7d:wife-nl-finance)");
    expect((await h.repo.getGoal("t", g.id))!.manual_value).toBeNull();
  });

  it("names a goal number that does not exist, and how many there are", async () => {
    const h = makeDeps();
    await seedGoal(h);
    await seedGoal(h);
    expect((await run(h, "7 5")).replies[0]!.text).toContain("There is no goal 7: you have 2 open goals");
    const empty = makeDeps();
    expect((await run(empty, "1 5")).replies[0]!.text).toContain("no open goals");
  });

  it("names the invalid field instead of guessing", async () => {
    const h = makeDeps();
    await seedGoal(h);
    expect((await run(h, "1 lots")).replies[0]!.text).toContain("<b>value</b>");
    expect((await run(h, "1")).replies[0]!.text).toContain("<b>value</b>");
  });
});

describe("/goal done | drop | block | unblock <n>", () => {
  it("marks a goal done and echoes its title, so a shifted list is noticed", async () => {
    const h = makeDeps();
    await seedGoal(h, { title: "First" });
    const second = await seedGoal(h, { title: "Second" });
    const { replies } = await run(h, "done 2");
    expect(replies[0]!.text).toContain("Goal 2 “Second” marked done");
    expect((await h.repo.getGoal("t", second.id))!.status).toBe("done");
    expect((await h.repo.listOpenGoals("t")).map((g) => g.title)).toEqual(["First"]);
  });

  it("numbers by the CURRENT list: after one goal leaves, the same number names the next", async () => {
    const h = makeDeps();
    await seedGoal(h, { title: "First" });
    await seedGoal(h, { title: "Second" });
    await seedGoal(h, { title: "Third" });
    await run(h, "done 1");
    const { replies } = await run(h, "drop 2");
    expect(replies[0]!.text).toContain("Goal 2 “Third” dropped");
  });

  it("drops without deleting anything: the row and its history stay", async () => {
    const h = makeDeps();
    const g = await seedGoal(h, { title: "Old" });
    await h.repo.claimReviews("t", [g.id], "2026-09-28", new Date("2026-09-28T07:00:00Z"), 300000);
    const before = h.repo.goals.size + h.repo.reviews.size;
    const { replies } = await run(h, "drop 1");
    expect(replies[0]!.text).toContain("history is kept");
    expect(h.repo.goals.size + h.repo.reviews.size).toBe(before);
    expect((await h.repo.getGoal("t", g.id))!.status).toBe("dropped");
  });

  it("blocks with a reason and an end date (start of that local day), and echoes both", async () => {
    const h = makeDeps();
    const g = await seedGoal(h, { title: "Renew permit" });
    const { replies } = await run(h, "block 1 waiting on the IND decision until=2026-10-15");
    expect(replies[0]!.text).toContain("Goal 1 “Renew permit” blocked: waiting on the IND decision (until 15 Oct)");
    const stored = (await h.repo.getGoal("t", g.id))!;
    expect(stored).toMatchObject({ status: "blocked", blocker: "waiting on the IND decision" });
    expect(stored.blocked_until!.toISOString()).toBe("2026-10-14T22:00:00.000Z"); // 00:00 on 15 Oct, Amsterdam
  });

  it("blocks with no end date and says so", async () => {
    const h = makeDeps();
    await seedGoal(h, { title: "T" });
    const { replies } = await run(h, "block 1 waiting");
    expect(replies[0]!.text).toContain("no end date");
  });

  it("unblocks a blocked goal, and says a goal that is not blocked is not", async () => {
    const h = makeDeps();
    const g = await seedGoal(h, { title: "T" });
    expect((await run(h, "unblock 1")).replies[0]!.text).toContain("Goal 1 “T” is not blocked");
    await run(h, "block 1 waiting");
    const { replies } = await run(h, "unblock 1");
    expect(replies[0]!.text).toContain("Goal 1 “T” is active again");
    expect(await h.repo.getGoal("t", g.id)).toMatchObject({ status: "active", blocker: null, blocked_until: null });
  });

  it("names a missing or invalid number, or a missing reason, and changes nothing", async () => {
    const h = makeDeps();
    const g = await seedGoal(h, { title: "T" });
    for (const [args, field] of [["done", "n"], ["drop two", "n"], ["block 1", "reason"], ["done 5", null]] as const) {
      const { replies } = await run(h, args);
      expect(replies[0]!.text, args).toContain(field === null ? "There is no goal 5" : `<b>${field}</b>`);
    }
    expect((await h.repo.getGoal("t", g.id))!.status).toBe("active");
  });

  it("escapes the goal title and the reason it echoes", async () => {
    const h = makeDeps();
    await seedGoal(h, { title: "A & B" });
    const { replies } = await run(h, "block 1 waiting <soon>");
    expect(replies[0]!.text).toContain("A &amp; B");
    expect(replies[0]!.text).toContain("waiting &lt;soon&gt;");
  });
});

describe("an unknown subcommand and a storage failure", () => {
  it("names the word it did not understand", async () => {
    const h = makeDeps();
    expect((await run(h, "finish 2")).replies[0]!.text).toContain("<b>command</b>");
  });

  it("answers a storage failure in words, logs it with the component, and does not throw", async () => {
    const h = makeDeps();
    h.repo.before.listOpenGoals = () => {
      throw new Error("connection refused");
    };
    const { replies } = await run(h, "done 1");
    expect(replies[0]!.text).toContain("Could not run /goal done");
    expect(replies[0]!.text).toContain("connection refused");
    expect(h.log.error).toHaveBeenCalledWith(expect.objectContaining({ component: "goal-commands" }), expect.any(String));
  });
});

describe("/goals — the live list", () => {
  it("shows each open goal with its value against its target, and mutates nothing", async () => {
    const h = makeDeps();
    await seedGoal(h, { title: "Tashi applies", metric_key: "applications_7d", metric_arg: "wife-nl-finance", target: 5, due_on: "2026-10-31" });
    h.metrics.countApplications.mockResolvedValue(2);
    const c = makeCtx();
    await handleGoals(c.ctx, h.deps);
    expect(c.replies[0]!.text).toBe(["<b>Goals · Tue 29 Sep</b>", "1. Tashi applies: 2 of 5 (need 3 more by 31 Oct, pace BEHIND)", "Blocked: none"].join("\n"));
    for (const write of ["claimReviews", "saveReviewResults", "finalizeReviews", "updateStatus", "addGoal"] as const) {
      expect(h.repo.calls.filter((call) => call === write).length, write).toBe(write === "addGoal" ? 1 : 0);
    }
    expect(c.replies[0]!.opts!.reply_markup!.inline_keyboard.flat().map((b) => b.text)).toEqual(["Plan next step · 1"]);
  });

  it("says a reached target will be marked done by the next standup, and does not mark it itself", async () => {
    const h = makeDeps();
    const g = await seedGoal(h, { title: "Reach 5k", target: 5000 });
    await h.repo.recordManualValue("t", g.id, 5200, new Date("2026-09-28T10:00:00Z"));
    const c = makeCtx();
    await handleGoals(c.ctx, h.deps);
    expect(c.replies[0]!.text).toContain("target reached (the next standup marks it done)");
    expect((await h.repo.getGoal("t", g.id))!.status).toBe("active");
  });

  it("shows a failing source as unavailable with the reason, never a 0", async () => {
    const h = makeDeps();
    await seedGoal(h, { title: "Ship a fix", metric_key: "prs_merged_7d", metric_arg: "acme/api", target: 1 });
    h.metrics.countMergedPrs.mockRejectedValue(Object.assign(new Error("Bad credentials"), { status: 401 }));
    const c = makeCtx();
    await handleGoals(c.ctx, h.deps);
    expect(c.replies[0]!.text).toContain("metric unavailable: GitHub rejected the token (HTTP 401)");
  });

  it("splits a long list across messages instead of dropping a goal", async () => {
    const h = makeDeps();
    h.metrics.countMergedPrs.mockRejectedValue(Object.assign(new Error("x"), { status: 401 }));
    for (let i = 1; i <= 15; i++) await seedGoal(h, { title: `Goal ${i} ${"t".repeat(119)}`, metric_key: "prs_merged_7d", metric_arg: `o/r${i}`, target: 1 });
    const c = makeCtx();
    await handleGoals(c.ctx, h.deps);
    expect(c.replies.length).toBeGreaterThan(1);
    for (const r of c.replies) expect(r.text.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS);
    const all = c.replies.map((r) => r.text).join("\n");
    for (let i = 1; i <= 15; i++) expect(all.split(`\n${i}. Goal ${i} `).length - 1, `goal ${i}`).toBe(1);
  });

  it("with no goals, says how to add one instead of sending an empty list", async () => {
    const h = makeDeps();
    const c = makeCtx();
    await handleGoals(c.ctx, h.deps);
    expect(c.replies).toHaveLength(1);
    expect(c.replies[0]!.text).toContain("No goals yet");
    expect(c.replies[0]!.text).toContain("/goal add");
  });

  it("answers a storage failure in words and logs it", async () => {
    const h = makeDeps();
    h.repo.before.listOpenGoals = () => {
      throw new Error("connection refused");
    };
    const c = makeCtx();
    await handleGoals(c.ctx, h.deps);
    expect(c.replies[0]!.text).toContain("Could not load your goals");
    expect(h.log.error).toHaveBeenCalledWith(expect.objectContaining({ component: "goal-commands" }), expect.any(String));
  });
});

describe("replySkippedStandups — the one line at /resume", () => {
  it("says which days were skipped, once", async () => {
    const skips = new MemorySkips();
    await skips.record("2026-09-30");
    await skips.record("2026-10-01");
    const c = makeCtx();
    await replySkippedStandups(c.ctx, skips);
    expect(c.replies.map((r) => r.text)).toEqual(["standup skipped on 30 Sep, 1 Oct"]);
    await replySkippedStandups(c.ctx, skips);
    expect(c.replies).toHaveLength(1);
  });

  it("says nothing when nothing was skipped", async () => {
    const c = makeCtx();
    await replySkippedStandups(c.ctx, new MemorySkips());
    expect(c.replies).toEqual([]);
  });

  it("never fails /resume: a ledger that throws is logged and swallowed", async () => {
    const c = makeCtx();
    await expect(
      replySkippedStandups(c.ctx, { record: async () => undefined, take: async () => { throw new Error("disk full"); } }),
    ).resolves.toBeUndefined();
    expect(c.replies).toEqual([]);
  });
});
