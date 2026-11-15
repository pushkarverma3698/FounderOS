/**
 * parseAnswerDoc on a messy filled-in document (invented candidate): CRLF, answers inline and below,
 * bullets and "A:" prefixes, blank lines, headings, numbers that drifted, skips and blanks.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAnswerDoc } from "../../../src/tools/jobhunt/answer-doc-parse.js";

const messy = readFileSync(new URL("../../fixtures/answer-docs/messy-mira.md", import.meta.url), "utf8");
const byNumber = (text: string) => new Map(parseAnswerDoc(text).map((p) => [p.number, p]));

describe("parseAnswerDoc", () => {
  const got = byNumber(messy);

  it("reads answers on the following line, across blank lines", () => {
    expect(got.get(1)?.answer).toBe("Mira Haldane");
    expect(got.get(4)?.answer).toBe("Utrecht, Netherlands");
  });

  it("strips bullets and A: prefixes", () => {
    expect(got.get(2)?.answer).toBe("mira.haldane@example.test");
    expect(got.get(15)?.answer).toBe("Q: 1 March 2027");
  });

  it("reads an answer on the same line as the question, with or without the (yes / no) hint", () => {
    expect(got.get(3)?.answer).toBe("+31 6 5550 0142");
    expect(got.get(8)?.answer).toBe("Yes");
  });

  it("matches by question text when the number drifted", () => {
    expect(got.get(8)?.question).toMatch(/legally allowed to work there today/);
    expect(got.get(9)?.answer).toBe("No");
    expect(got.get(10)?.answer).toMatch(/dependant permit/);
    expect(got.get(11)?.answer).toBe("yes");
    expect(got.get(12)?.answer).toBe("Fictionlander");
  });

  it("returns skip for a skipped question in any case, and null for blank ones", () => {
    expect(got.get(5)?.answer).toBe("skip");
    expect(got.get(20)?.answer).toBe("skip");
    expect(got.get(6)?.answer).toBeNull();
    expect(got.get(22)?.answer).toBeNull();
  });

  it("keeps bold and joins a multi-word answer", () => {
    expect(got.get(7)?.answer).toBe("Finance CV for every role");
  });

  it("does not take section headings for questions, and does not read the preamble", () => {
    expect([...got.keys()].every((n) => n >= 1 && n <= 50)).toBe(true);
    expect(parseAnswerDoc("# Questions for Mira\n\n## 2. Right to work\n")).toEqual([]);
  });

  it("is the same with LF endings and without the heading markers", () => {
    const plain = messy.replace(/\r\n/g, "\n").replace(/^##? .*$/gm, "");
    expect(parseAnswerDoc(plain)).toEqual(parseAnswerDoc(messy));
  });

  it("treats a bare numbered section title as a heading, not a question", () => {
    const out = parseAnswerDoc("2. Right to work\n8. Netherlands: are you legally allowed to work there today? (yes / no)\nyes\n");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ number: 8, answer: "yes", recognised: true });
  });

  it("keeps a question it does not know under her own wording", () => {
    const out = parseAnswerDoc("51. Do you hold a driving licence? Yes, category B\n");
    expect(out[0]).toMatchObject({ number: 51, recognised: false, question: "Do you hold a driving licence?", answer: "Yes, category B" });
  });

  it("takes the later answer when a question appears twice", () => {
    const out = parseAnswerDoc("14. Notice period in days.\n30\n14. Notice period in days.\n45\n");
    expect(out).toHaveLength(1);
    expect(out[0]?.answer).toBe("45");
  });

  it("matches an abbreviated question by its number", () => {
    expect(parseAnswerDoc("3. Phone: +31 6 5550 0142\n")[0]).toMatchObject({ number: 3, answer: "+31 6 5550 0142", recognised: true });
  });
});
