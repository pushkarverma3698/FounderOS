/**
 * Unit tests — the cover letter, and the slop gate in front of it.
 *
 * WHY THIS EXISTS. `/draft N` produced a tailored CV PDF and nothing else. The
 * `cover_letter_s3_key` column has been in the schema since the table was
 * written and no code has ever set it — the answer to "are we also sending a
 * cover letter" was no, and had always been no. Most application forms have a
 * box for one, and leaving it empty on a role that cleared every gate is a
 * self-inflicted rejection.
 *
 * WHY THE SLOP GATE IS STRICTER HERE THAN FOR THE CV. `findSlop` was built for
 * a CV: a document of headings, bullets and noun phrases. A cover letter is
 * prose, and prose has failure modes a bullet list cannot have — binary
 * contrasts, throat-clearing openers, importance puffery, a summary paragraph
 * that restates the letter to someone who just read it. Those checks are
 * therefore opt-in (`{ prose: true }`), because turning them on globally would
 * fail every CV: the em-dash rule alone would reject all four of the founder's
 * CVs, which use "**Backend & Data** — Node.js, …" as their section format.
 *
 * These rules are taken from the `no-ai-slop` skill, which CLAUDE.md requires
 * for anything published outside this machine. A cover letter goes to a human
 * being at a company the founder wants to work for; it is exactly that.
 */

import { describe, it, expect } from "vitest";
import { findSlop } from "../../../src/tools/jobhunt/slop-rules.js";
import {
  buildCoverLetter,
  coverLetterPrompt,
  type CoverLetterModel,
} from "../../../src/tools/jobhunt/cover-letter.js";

// ── the slop gate ────────────────────────────────────────────────────────────

describe("findSlop — the CV rules are unchanged by default", () => {
  it("still catches a banned word", () => {
    expect(findSlop("I leverage TypeScript daily.")).toHaveLength(1);
  });

  it("leaves an em dash alone for a CV, where it is the section format", () => {
    // "**Backend & Data** — Node.js, TypeScript, …" is how all four CVs are
    // written. Flagging it would fail every tailoring run.
    expect(findSlop("**Backend & Data** — Node.js, TypeScript")).toEqual([]);
  });

  it("leaves prose patterns alone unless prose mode is asked for", () => {
    expect(findSlop("This is not a job application. It's a proposal.")).toEqual([]);
  });
});

describe("findSlop — prose mode, for the cover letter", () => {
  const prose = (text: string): string[] =>
    findSlop(text, { prose: true }).map((v) => v.rule);

  it("flags an em dash used as a rhythm crutch", () => {
    expect(prose("I build agent systems — and I ship them.")).toContain("Em dash");
  });

  it("flags a binary contrast", () => {
    expect(prose("This is not about tooling. It's about outcomes.")).toContain(
      "Binary contrast",
    );
  });

  it("flags a throat-clearing opener", () => {
    expect(prose("Here's the thing: I have shipped this exact system.")).toContain(
      "Throat-clearing opener",
    );
  });

  it("flags importance puffery", () => {
    expect(prose("The role plays a vital role in the platform team.")).toContain(
      "Importance puffery",
    );
  });

  it("flags weasel attribution, which a cover letter cannot source", () => {
    expect(prose("Studies show that reliability work compounds.")).toContain(
      "Weasel attribution",
    );
  });

  it("flags a summary-recap ending", () => {
    // The reader has just read four paragraphs. Recapping them is filler.
    expect(prose("I built the pipeline.\n\nIn conclusion, I would be a good fit.")).toContain(
      "Summary-recap ending",
    );
  });

  it("passes a letter written plainly", () => {
    const clean = [
      "I read that Ockto runs its identity checks on a Node and Postgres stack.",
      "",
      "At Turicks I built a job pipeline that polls 623 ATS boards every 30 minutes and",
      "screens about 31,000 postings a sweep. When one provider started rate-limiting us,",
      "I cut failures from 36 a sweep to 7 with jittered retries.",
      "",
      "I am available from September and would like to talk.",
    ].join("\n");
    expect(findSlop(clean, { prose: true })).toEqual([]);
  });
});

// ── the letter ───────────────────────────────────────────────────────────────

const CV = [
  "# Pushkar Verma",
  "## Experience",
  "### Turicks — Founding Engineer",
  "- Built a LangGraph agent kernel on Node and Postgres.",
  "## Skills",
  "- TypeScript, PostgreSQL, Docker",
].join("\n");

/**
 * A letter that clears every rule, and long enough to clear MIN_LETTER_CHARS.
 *
 * The floor matters to the fixture: a shorter draft would exercise the "the
 * model returned an acknowledgement" refusal while appearing to test the happy
 * path, which is how a test passes for the wrong reason.
 */
const CLEAN_LETTER = [
  "Dear Hiring Team,",
  "",
  "I read the Senior Site Reliability Engineer posting at Ockto and the line about",
  "owning reliability on a Node and Postgres stack is the work I have been doing.",
  "",
  "At Turicks I built a LangGraph agent kernel on Node and Postgres and kept it",
  "running in production on a single VPS. When one job board started rate-limiting",
  "our sweeps, I replaced the concurrency tuning with jittered retries and failures",
  "fell from 36 a sweep to 7, which put another 900 postings back in reach.",
  "",
  "I am available from September and would like to talk.",
  "",
  "Pushkar Verma",
].join("\n");

/** A model that returns whatever it is told to, and records what it was asked. */
function scriptedModel(...replies: string[]): CoverLetterModel & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  let turn = 0;
  return {
    calls,
    invoke: async (messages: unknown[]) => {
      calls.push(messages);
      const reply = replies[Math.min(turn, replies.length - 1)] as string;
      turn += 1;
      return { content: reply };
    },
  };
}

const options = {
  companyName: "Ockto",
  jobTitle: "Senior Site Reliability Engineer",
  jobDescription: "We run Node and Postgres. You will own reliability.",
  track: "backend",
  cvText: CV,
};

describe("buildCoverLetter", () => {
  it("returns the letter when it is already clean", async () => {
    const result = await buildCoverLetter(options, scriptedModel(CLEAN_LETTER));
    expect(result.success).toBe(true);
    expect(result.letter).toContain("Ockto");
  });

  it("strips a markdown fence the model wrapped the letter in", async () => {
    const result = await buildCoverLetter(
      options,
      scriptedModel("```markdown\n" + CLEAN_LETTER + "\n```"),
    );
    expect(result.success).toBe(true);
    expect(result.letter).not.toContain("```");
  });

  it("asks for one revision when the first draft is sloppy, and accepts the fix", async () => {
    const model = scriptedModel("I leverage cutting-edge tooling.", CLEAN_LETTER);
    const result = await buildCoverLetter(options, model);

    expect(result.success).toBe(true);
    expect(result.letter).toContain("Ockto");
    expect(model.calls).toHaveLength(2);
  });

  it("fails loudly rather than sending slop that survived a revision", async () => {
    // Sending a letter full of cliches is worse than sending none: it is the
    // founder's one impression at a company that cleared every gate.
    const model = scriptedModel("I leverage cutting-edge tooling.");
    const result = await buildCoverLetter(options, model);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/slop|cliche/i);
    expect(model.calls).toHaveLength(2);
  });

  it("fails when the model returns something too short to be a letter", async () => {
    const result = await buildCoverLetter(options, scriptedModel("Sure!"));
    expect(result.success).toBe(false);
  });

  it("never invents a hiring manager's name", async () => {
    const named = CLEAN_LETTER.replace("Dear Hiring Team,", "Dear Sarah Jenkins,");
    const result = await buildCoverLetter(options, scriptedModel(named, CLEAN_LETTER));
    // A guessed name is a hallucination that lands on a real person's desk.
    expect(result.success).toBe(true);
    expect(result.letter).not.toContain("Sarah Jenkins");
  });

  it("surfaces a model failure as a result, not a throw", async () => {
    const model: CoverLetterModel = {
      invoke: async () => {
        throw new Error("503 Service Unavailable");
      },
    };
    const result = await buildCoverLetter(options, model);
    expect(result.success).toBe(false);
    expect(result.error).toContain("503");
  });
});

describe("coverLetterPrompt", () => {
  it("gives the model the CV, so every claim has a source", async () => {
    const prompt = coverLetterPrompt(options);
    expect(prompt).toContain("Turicks");
  });

  it("gives the model the posting, so the letter is about this role", () => {
    expect(coverLetterPrompt(options)).toContain("own reliability");
  });

  it("bounds the job description rather than pasting an entire careers page", () => {
    const huge = { ...options, jobDescription: "x".repeat(50_000) };
    expect(coverLetterPrompt(huge).length).toBeLessThan(20_000);
  });

  it("names the company and the title", () => {
    const prompt = coverLetterPrompt(options);
    expect(prompt).toContain("Ockto");
    expect(prompt).toContain("Senior Site Reliability Engineer");
  });
});

describe("coverLetterPrompt — founder context", () => {
  const BASE = {
    companyName: "Altura",
    jobTitle: "Senior Backend Engineer",
    jobDescription: "We build tender-spotting software.",
    cvText: "PUSHKAR VERMA\nBackend Engineer",
  };

  it("includes founderContext as a separate, clearly-bounded fact source when present", () => {
    const prompt = coverLetterPrompt({ ...BASE, founderContext: "Relocating to the Netherlands." });
    expect(prompt).toContain("Relocating to the Netherlands.");
    expect(prompt).toContain("ADDITIONAL CONTEXT");
  });

  it("omits the ADDITIONAL CONTEXT section entirely when founderContext is not given", () => {
    const prompt = coverLetterPrompt(BASE);
    expect(prompt).not.toContain("ADDITIONAL CONTEXT");
  });
});

describe("the letter is delivered as text, not a file", () => {
  it("is short enough to paste into an application form", async () => {
    const result = await buildCoverLetter(options, scriptedModel(CLEAN_LETTER));
    expect(result.success).toBe(true);
    // Most forms cap the box; anything longer gets truncated by the site rather
    // than by us, which is how a letter loses its last paragraph silently.
    expect((result.letter ?? "").length).toBeLessThan(3000);
  });
});
