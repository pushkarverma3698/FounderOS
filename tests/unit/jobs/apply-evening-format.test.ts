import { describe, expect, it } from "vitest";
import { buildEveningMessages, roleButtons, EVENING_ROLES_PER_MESSAGE, type WaitingRole } from "../../../src/jobs/apply-evening-format.js";

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const role = (n: number, over: Partial<WaitingRole> = {}): WaitingRole => ({
  id: id(n), company: `Co${n}`, title: `Role ${n}`, url: `https://jobs.example.com/${n}`, lane: "needs_you", reason: "2 required question(s) unanswered: Visa; Salary", answerUrl: null, ...over,
});

describe("buildEveningMessages", () => {
  it("sends nothing when nothing waits", () => {
    expect(buildEveningMessages("Tashi", [])).toEqual([]);
  });

  it("lists Needs you before Hand-off, one line per role with its reason", () => {
    const [m] = buildEveningMessages("Tashi", [
      role(1, { lane: "hand_off", reason: "CAPTCHA on the form" }),
      role(2, { reason: "Greenhouse emails a code" }),
    ]);
    const text = m?.text ?? "";
    expect(text.indexOf("Needs you")).toBeLessThan(text.indexOf("Hand-off"));
    expect(text).toContain("1. <b>Co2</b>");
    expect(text).toContain("Greenhouse emails a code");
    expect(text).toContain("2. <b>Co1</b>");
    expect(text).toContain("CAPTCHA on the form");
    expect(text).toContain("2 roles still waiting");
  });

  it("escapes HTML in company, title and reason", () => {
    const [m] = buildEveningMessages("A<b>", [role(1, { company: "A&B", title: "<script>", reason: "x<y" })]);
    expect(m?.text).toContain("A&amp;B");
    expect(m?.text).not.toContain("<script>");
    expect(m?.text).toContain("x&lt;y");
    expect(m?.text).toContain("A&lt;b&gt;");
  });

  it("needs_you without a snapshot gets Prepare (jh:f), with one gets the answer link; both get Applied and Skip", () => {
    const plain = roleButtons(1, role(1));
    expect(plain[0]?.[0]).toEqual({ text: "🚀 Prepare 1", callback_data: `jh:f:${id(1)}` });
    expect(plain[0]?.[1]).toEqual({ text: "🔗 Job 1", url: "https://jobs.example.com/1" });
    expect(plain[1]).toEqual([
      { text: "✅ Applied 1", callback_data: `jh:a:${id(1)}` },
      { text: "⏭ Skip 1", callback_data: `jh:n:${id(1)}` },
    ]);
    const linked = roleButtons(1, role(1, { answerUrl: "https://x.example/apply/tok" }));
    expect(linked[0]?.[0]).toEqual({ text: "✍ Answer 1", url: "https://x.example/apply/tok" });
  });

  it("hand_off gets Copy answers: the panel link when signed, else the prepare callback", () => {
    expect(roleButtons(3, role(3, { lane: "hand_off", answerUrl: "https://x.example/apply/tok/" }))[0]?.[0]).toEqual({
      text: "📋 Copy answers 3",
      url: "https://x.example/apply/tok/handoff",
    });
    expect(roleButtons(3, role(3, { lane: "hand_off" }))[0]?.[0]).toEqual({ text: "📋 Copy answers 3", callback_data: `jh:f:${id(3)}` });
  });

  it("drops the job link button for a missing or unusable url instead of failing", () => {
    expect(roleButtons(1, role(1, { url: null }))[0]).toHaveLength(1);
    expect(roleButtons(1, role(1, { url: "javascript:alert(1)" }))[0]).toHaveLength(1);
  });

  it("splits by size without dropping a row, numbers continue, buttons stay with their rows", () => {
    const long = "q".repeat(230);
    const roles = Array.from({ length: 40 }, (_, i) => role(i + 1, { reason: long, lane: i < 25 ? "needs_you" : "hand_off" }));
    const messages = buildEveningMessages("Tashi", roles);
    expect(messages.length).toBeGreaterThan(1);
    for (const m of messages) {
      expect(m.text.length).toBeLessThanOrEqual(4096);
      expect(m.keyboard.flat().length).toBeLessThanOrEqual(100);
    }
    const all = messages.map((m) => m.text).join("\n");
    for (let n = 1; n <= 40; n++) expect(all).toContain(`${n}. <b>Co`);
    const appliedIds = messages.flatMap((m) => m.keyboard.flat()).filter((b) => "callback_data" in b && b.callback_data.startsWith("jh:a:"));
    expect(appliedIds).toHaveLength(40);
    expect(messages[0]?.text).toContain("(1/");
    // a section that continues into the next message is titled again there
    expect(messages.slice(1).every((m) => /Needs you|Hand-off/.test(m.text))).toBe(true);
  });

  it("caps roles per message so buttons never pass Telegram's limit", () => {
    const messages = buildEveningMessages("T", Array.from({ length: EVENING_ROLES_PER_MESSAGE + 1 }, (_, i) => role(i + 1, { reason: "r" })));
    expect(messages).toHaveLength(2);
  });
});
