/**
 * Mac worker plan: the VPS packet's answers become fill actions for the form the Mac scraped itself.
 */

import { describe, expect, it } from "vitest";
import type { ScrapedField } from "../../../src/tools/jobhunt/form-brain.js";
import type { MacPacket } from "../../../src/gateway/mac-worker-packet.js";
import { applyPacketSources, planFromPacket } from "../../../src/gateway/mac-worker-plan.js";
import { summariseFormPlan } from "../../../src/tools/jobhunt/form-filled.js";

const f = (selector: string, label: string, type: ScrapedField["type"], extra: Partial<ScrapedField> = {}): ScrapedField =>
  ({ selector, label, type, required: false, ...extra });

const packet = (filledAnswers: NonNullable<MacPacket["plan"]>["filledAnswers"]): MacPacket => ({
  rowId: "r", company: "Acme", title: "Dev", url: "u", answers: [], cv: { filename: "cv.pdf", bytes: 1 }, auditKey: "k",
  plan: { filledAnswers, requiredUnanswered: [] },
});

describe("planFromPacket", () => {
  const answers = [
    { label: "Full name", value: "A B", fieldType: "text", source: "profile" as const, confidence: 1 },
    { label: "Notice period", value: "1 month", fieldType: "select", source: "profile" as const, confidence: 1 },
  ];

  it("types text answers, chooses select answers, and attaches the CV to the resume upload", () => {
    const fields = [f("#n", "Full name", "text"), f("#np", "notice period", "select"), f("#cv", "Resume/CV", "file", { required: true })];
    const plan = planFromPacket(fields, packet(answers), "/tmp/cv.pdf");
    expect(plan.map((a) => [a.kind, a.selector])).toEqual([["value", "#n"], ["choose", "#np"], ["file", "#cv"]]);
    expect(plan[2]).toMatchObject({ path: "/tmp/cv.pdf" });
  });

  it("asks for a field the VPS gave no answer for, and skips CAPTCHA fields", () => {
    const fields = [f("#v", "Visa status?", "text", { required: true }), f("#c", "CAPTCHA", "captcha", { isCaptcha: true })];
    const plan = planFromPacket(fields, packet(answers), "/tmp/cv.pdf");
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ kind: "ask", required: true });
  });

  it("does not hand the CV to a cover-letter-only upload", () => {
    const plan = planFromPacket([f("#cl", "Cover letter", "file")], packet(answers), "/tmp/cv.pdf");
    expect(plan[0]).toMatchObject({ kind: "ask" });
  });
});

describe("applyPacketSources", () => {
  it("restores the source and confidence the VPS recorded, so canAutoSend can judge the answers", () => {
    const fields = [f("#n", "Full name", "text"), f("#cv", "Resume/CV", "file")];
    const pkt = packet([{ label: "Full name", value: "A B", fieldType: "text", source: "dossier", confidence: 0.95 }]);
    const plan = planFromPacket(fields, pkt, "/tmp/cv.pdf");
    const s = applyPacketSources(summariseFormPlan(plan, fields, new Set(["#n", "#cv"])), pkt);
    expect(s.filledAnswers.find((a) => a.label === "Full name")).toMatchObject({ source: "dossier", confidence: 0.95 });
    expect(s.filledAnswers.find((a) => a.label === "Resume/CV")).toMatchObject({ source: "file", confidence: 1 });
  });

  it("leaves an answer with no recorded source untrusted", () => {
    const fields = [f("#n", "Full name", "text")];
    const pkt = packet([{ label: "Full name", value: "A B", fieldType: "text" }]);
    const plan = planFromPacket(fields, pkt, "/tmp/cv.pdf");
    const s = applyPacketSources(summariseFormPlan(plan, fields, new Set(["#n"])), pkt);
    expect(s.filledAnswers[0]!.source).toBe("unknown");
  });
});
