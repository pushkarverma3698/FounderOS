/**
 * Form answer drafts: what may reach the model, and what survives the validator.
 * A fake model stands in for the worker, so nothing here spends a token.
 */
import { describe, expect, it } from "vitest";
import {
  buildDraftPrompt,
  draftFormAnswers,
  isDraftable,
  parseDraftResponse,
  validateDrafts,
  type DraftModel,
  type DraftQuestion,
} from "../../../src/tools/jobhunt/form-answer-drafts.js";

const SOURCE = "Test Person has 6 years of AWS experience.\nQ: preferred name: Test\nOpen to hybrid work, 3 days per week in an office.";

const q = (label: string, over: Partial<DraftQuestion> = {}): DraftQuestion => ({ label, fieldType: "text", ...over });

function fake(reply: string): { model: DraftModel; seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    model: {
      invoke: async (messages) => {
        seen.push(messages.map((m) => m.content).join("\n"));
        return { content: reply };
      },
    },
  };
}

describe("isDraftable", () => {
  it.each([
    ["What salary do you expect?", "text"],
    ["Expected compensation (EUR)", "text"],
    ["Do you require visa sponsorship?", "text"],
    ["Are you legally authorized to work in the EU?", "text"],
    ["Gender", "select"],
    ["Do you have a disability?", "text"],
    ["Veteran status", "select"],
    ["I agree to the privacy policy", "text"],
    ["Upload your portfolio", "file"],
    ["I consent", "checkbox"],
  ])("never drafts %s", (label, fieldType) => {
    expect(isDraftable(q(label, { fieldType: fieldType as DraftQuestion["fieldType"] }))).toBe(false);
  });

  it("drafts an ordinary job question", () => {
    expect(isDraftable(q("Years of AWS experience"))).toBe(true);
  });
});

describe("validateDrafts", () => {
  const qs = [q("Years of AWS experience"), q("Work mode", { fieldType: "select", options: ["Remote", "Hybrid", "On-site"] })];

  it("keeps a draft whose quote is in the source (case and whitespace normalised)", () => {
    const kept = validateDrafts([{ index: 0, answer: "6", sourceQuote: "6 YEARS  of aws\nexperience" }], qs, SOURCE);
    expect(kept.get(0)).toEqual({ answer: "6", sourceQuote: "6 YEARS  of aws\nexperience" });
  });

  it("drops a draft whose quote is not in the source", () => {
    expect(validateDrafts([{ index: 0, answer: "10", sourceQuote: "10 years of AWS" }], qs, SOURCE).size).toBe(0);
  });

  it("drops an answer that is not one of the options, and maps a match to the exact option", () => {
    const quote = "Open to hybrid work";
    expect(validateDrafts([{ index: 1, answer: "Fully flexible", sourceQuote: quote }], qs, SOURCE).size).toBe(0);
    expect(validateDrafts([{ index: 1, answer: "hybrid", sourceQuote: quote }], qs, SOURCE).get(1)?.answer).toBe("Hybrid");
  });

  it("ignores an index that is out of range", () => {
    expect(validateDrafts([{ index: 9, answer: "x", sourceQuote: "6 years of AWS" }], qs, SOURCE).size).toBe(0);
  });
});

describe("parseDraftResponse", () => {
  it("returns nothing for malformed or wrongly shaped output, without throwing", () => {
    for (const raw of ["not json", "{", "[]", '{"drafts":"x"}', '{"drafts":[{"index":"0"}]}', ""]) {
      expect(parseDraftResponse(raw)).toEqual([]);
    }
  });

  it("accepts a fenced reply", () => {
    const raw = '```json\n{"drafts":[{"index":0,"answer":"a","sourceQuote":"b"}]}\n```';
    expect(parseDraftResponse(raw)).toEqual([{ index: 0, answer: "a", sourceQuote: "b" }]);
  });
});

describe("draftFormAnswers", () => {
  it("never sends sensitive, visa, salary or file questions to the model", async () => {
    const { model, seen } = fake('{"drafts":[]}');
    await draftFormAnswers(
      [
        q("Years of AWS experience"),
        q("Do you need visa sponsorship?"),
        q("Salary expectations"),
        q("Gender"),
        q("CV upload", { fieldType: "file" }),
        q("Are you legally allowed to work here?"),
      ],
      SOURCE,
      model,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("Years of AWS experience");
    for (const banned of ["visa", "Salary", "Gender", "CV upload", "legally"]) expect(seen[0]).not.toContain(banned);
  });

  it("makes no call when nothing is draftable", async () => {
    const { model, seen } = fake("{}");
    expect(await draftFormAnswers([q("Salary expectations")], SOURCE, model)).toEqual({});
    expect(seen).toHaveLength(0);
  });

  it("returns no drafts for malformed model JSON", async () => {
    const { model } = fake("sorry, I cannot");
    expect(await draftFormAnswers([q("Years of AWS experience")], SOURCE, model)).toEqual({});
  });

  it("happy path: keyed by question key, unsupported drafts dropped", async () => {
    const reply = JSON.stringify({
      drafts: [
        { index: 0, answer: "6", sourceQuote: "6 years of AWS experience" },
        { index: 1, answer: "Test", sourceQuote: "preferred name: Test" },
        { index: 2, answer: "LinkedIn", sourceQuote: "found on LinkedIn" },
      ],
    });
    const { model } = fake(reply);
    const out = await draftFormAnswers([q("Years of AWS experience?"), q("Preferred name"), q("How did you hear about us?")], SOURCE, model);
    expect(Object.values(out).map((d) => d.answer)).toEqual(["6", "Test"]);
    expect(Object.keys(out)).toHaveLength(2);
  });
});

describe("buildDraftPrompt", () => {
  it("lists options and indices", () => {
    const text = buildDraftPrompt([q("Work mode", { fieldType: "select", options: ["Remote", "Hybrid"] })], SOURCE)[1]!.content;
    expect(text).toContain('0. [select] Work mode OPTIONS: "Remote" | "Hybrid"');
    expect(text).toContain("SOURCE:");
  });
});
