/**
 * FounderOS — the cover letter
 * ============================
 * The second half of an application. `/draft N` produced a tailored CV PDF and
 * stopped there; `cover_letter_s3_key` has been in the schema since the table
 * was written and nothing has ever set it. So the honest answer to "are we also
 * sending a cover letter" was no, and had always been no — on roles that had
 * cleared every screening gate, with a box on the form waiting for one.
 *
 * THREE RULES, IN PRIORITY ORDER.
 *
 * 1. Nothing that is not in the CV. The letter is read by a person who will
 *    later interview him about it. A model that infers "5 years of Kubernetes"
 *    from a posting that asks for it produces a claim he has to walk back in
 *    the room. The CV is the only source of fact here, and the prompt says so
 *    three times because this is the failure that costs the most.
 *
 * 2. No slop. Enforced by `findSlop(text, { prose: true })` rather than by
 *    asking the model nicely — an instruction in a prompt is a wish, and a
 *    check that runs on the output is a mechanism (rule #27). The prose rules
 *    exist because a letter can fail in ways a CV cannot: throat-clearing
 *    openers, binary contrasts, a closing paragraph that recaps the letter to
 *    someone who just read it.
 *
 * 3. Short. Under 300 words. A long cover letter is not read, and most forms
 *    put it in a box that truncates without saying so.
 *
 * Delivered as chat text, not a PDF, because of how an application is actually
 * submitted: the CV gets uploaded and the letter gets pasted. A PDF he has to
 * open and copy out of is a worse version of a message he can already read.
 */

import { childLogger } from "../../infra/logger.js";
import {
  checkLetterFacts,
  describeViolation,
  readsWhole,
  removeSentences,
  type FactViolation,
} from "./cover-letter-facts.js";
import { findSlop } from "./slop-rules.js";

const log = childLogger({ module: "tool:cover_letter" });

/** Enough of a posting to write about it; short enough not to blow the context. */
const POSTING_CHARS = 6000;
/** Below this, the model returned an acknowledgement rather than a letter. */
const MIN_LETTER_CHARS = 300;
/** A letter longer than this is not being read by anyone. */
const MAX_LETTER_CHARS = 3000;

export interface CoverLetterOptions {
  readonly companyName: string;
  readonly jobTitle: string;
  readonly jobDescription: string;
  readonly track?: string;
  /** The CV this letter must not exceed. Every claim comes from here. */
  readonly cvText: string;
  /**
   * True, founder-authored facts that are not always in the CV — relocation
   * status, the self-employment story. Same trust tier as the CV: named as a
   * source in the prompt, nothing invented beyond it either.
   */
  readonly founderContext?: string;
  /** The row's `country`: NL | IN | other | unknown. Told to the model; the fact check enforces it. */
  readonly postingCountry?: string;
  /** More true text the fact check accepts numbers and places from (the candidate dossier). */
  readonly dossierText?: string;
  /** The stored notice period. Without one, any start-date claim is removed. */
  readonly notice?: { readonly days?: number; readonly detail?: string };
  /** Test seam for "over a year" checks. */
  readonly now?: Date;
}

/** One turn of the conversation, in the shape LangChain accepts directly. */
export interface ChatTurn {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

/**
 * The narrow slice of a chat model this module needs, injected so the tests
 * cost nothing. Typed against the concrete message shape rather than `unknown[]`
 * so a real `BaseChatModel` satisfies it without a cast.
 */
export interface CoverLetterModel {
  invoke(messages: ChatTurn[]): Promise<{ content: unknown }>;
}

export interface CoverLetterResult {
  readonly success: boolean;
  readonly letter?: string;
  readonly error?: string;
  /** Why there is no letter, so a caller can fall back on `empty` only. */
  readonly kind?: "empty" | "slop" | "facts" | "length" | "error";
  /** Violations that survived the revision, for the failure message. */
  readonly violations?: readonly string[];
  /** Sentences the fact check cut out of an otherwise whole letter. */
  readonly removed?: readonly string[];
}

const SYSTEM_PROMPT = `You are writing a cover letter as the candidate, in the first person.

FACTS
1. Every claim must be traceable to the CV you are given. Never state a skill, a
   year count, an employer, a title or a metric that is not in it.
2. If the posting asks for something the CV does not show, do not mention it.
   Do not hedge it, do not promise to learn it, do not imply it.
3. Never invent a recipient's name. Address it "Dear Hiring Team," unless the
   posting itself names a person.

SHAPE
4. Under 300 words. Three or four short paragraphs.
5. Open with the specific thing about this role or company you are responding
   to. No summary of your career, no "I am writing to apply for".
6. The middle is one concrete piece of evidence from the CV that maps to what
   the posting asks for. Names, numbers, mechanisms. One example told properly
   beats four listed.
7. End with a plain sentence about availability or a next step. No recap.

VOICE — these are hard rules, and the output is checked against them
8. No em dashes. Use a comma, a full stop or parentheses.
9. Banned words: delve, foster, leverage, utilize, facilitate, empower,
   streamline, robust, cutting-edge, paradigm shift, game changer, tapestry,
   realm, beacon, multifaceted, meticulous, intricate, paramount, transformative,
   elevate, embark, supercharge, harness, ever-evolving.
10. Banned patterns: "This is not X, it's Y"; "Here's the thing"; "plays a vital
    role"; "studies show"; "In conclusion"; a noun phrase, a colon, then a
    dramatic lowercase reveal.
11. Active voice. Direct verbs: "decided", not "made a decision".
12. No flattery of the company and no adjectives about yourself. State what you
    did and let it stand.

FACTS THE CODE CHECKS AFTER YOU (a sentence that breaks one is deleted)
13. Say nothing about relocating, moving or where you live unless the CV or the
    additional context says it AND it is about the country the role is in.
14. Say nothing about a start date or availability unless it is in the context.
15. Every number (counts, percentages, years, "over a year") must be copied from
    the CV or the context, never rounded, updated or recomputed.
16. Never mention work permits, visas, sponsorship or the right to work.

Output the letter only. No preamble, no notes, no markdown fences.`;

function countryLabel(code: string | undefined): string {
  if (code === "NL") return "the Netherlands";
  if (code === "IN") return "India";
  if (code === "other") return "a country other than the Netherlands and India";
  return "not known (make no claim about location, relocation or start date)";
}

/** The user turn: who, what role, what the posting says, what the CV says. */
export function coverLetterPrompt(options: CoverLetterOptions): string {
  return [
    `Company: ${options.companyName}`,
    `Role: ${options.jobTitle}`,
    options.track ? `Discipline: ${options.track}` : "",
    `Role location: ${countryLabel(options.postingCountry)}`,
    "",
    "POSTING:",
    options.jobDescription.slice(0, POSTING_CHARS),
    "",
    "CV — the only source of fact about work history and skills. Nothing about work history or skills outside this may appear in the letter:",
    options.cvText,
    "",
    options.founderContext
      ? "ADDITIONAL CONTEXT, also a true source of fact — use at most one relevant detail from this, not all of them:"
      : "",
    options.founderContext ?? "",
    "",
    `Write the cover letter for ${options.jobTitle} at ${options.companyName} now.`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** Models sometimes wrap prose in a fence despite being told not to. */
function unfence(raw: string): string {
  return raw
    .replace(/^```(?:markdown|text)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
}

function textOf(content: unknown): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

/**
 * Replace a guessed recipient with a neutral salutation.
 *
 * The prompt forbids inventing a name and the model does it anyway often enough
 * to matter. A hallucinated name is the one slop failure that lands on a real
 * person's desk addressed to somebody else, so it is corrected in code rather
 * than spent on a revision round.
 */
function neutraliseSalutation(letter: string): string {
  return letter.replace(
    /^\s*Dear\s+(?!Hiring\b|Team\b|Sir\b|Madam\b|Recruit)[^,\n]{2,40},/im,
    "Dear Hiring Team,",
  );
}

function failure(kind: NonNullable<CoverLetterResult["kind"]>, error: string, violations?: readonly string[]): CoverLetterResult {
  return { success: false, kind, error, ...(violations ? { violations } : {}) };
}

/** One call, and one retry if what came back is too short to be a letter (the "0 characters" defect). */
async function generate(model: CoverLetterModel, messages: ChatTurn[]): Promise<{ raw: string; letter: string }> {
  let raw = textOf((await model.invoke(messages)).content);
  let letter = neutraliseSalutation(unfence(raw));
  if (letter.length < MIN_LETTER_CHARS) {
    log.warn({ chars: letter.length }, "Cover letter too short — retrying once");
    raw = textOf((await model.invoke(messages)).content);
    letter = neutraliseSalutation(unfence(raw));
  }
  return { raw, letter };
}

function factsListing(violations: readonly FactViolation[]): string[] {
  return violations.map(describeViolation);
}

/**
 * Write the letter, check it, and give the model at most one revision for voice
 * and one regeneration for facts.
 *
 * One chance each, not a loop. A model that produced cliches twice in a row is
 * not converging, and another paid call to find that out is spending the
 * founder's budget to postpone a "no". Failing here is cheap: `/draft` still
 * delivers the tailored CV, and the reason is printed.
 *
 * Facts are enforced by `checkLetterFacts`, not by the prompt: a sentence that
 * breaks a rule is cut when the letter still reads whole, else regenerated once
 * with the violations listed, else there is no letter.
 */
export async function buildCoverLetter(
  options: CoverLetterOptions,
  model: CoverLetterModel,
): Promise<CoverLetterResult> {
  const userPrompt = coverLetterPrompt(options);
  const base: ChatTurn[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];
  const factCtx = {
    postingCountry: options.postingCountry,
    sourceText: [options.cvText, options.founderContext ?? "", options.dossierText ?? ""].join("\n"),
    exemptText: `${options.companyName} ${options.jobTitle}`,
    notice: options.notice,
    now: options.now,
  };

  try {
    const first = await generate(model, base);
    let raw = first.raw;
    let letter = first.letter;

    let violations = findSlop(letter, { prose: true });
    if (violations.length > 0) {
      log.warn(
        { company: options.companyName, violations: violations.length },
        "Cover letter contained AI slop — requesting one revision",
      );
      const revision = await model.invoke([
        ...base,
        { role: "assistant", content: raw },
        {
          role: "user",
          content:
            "That draft broke the voice rules. Fix only these, keep everything else:\n\n" +
            violations.map((v) => `- ${v.rule}: "${v.matchedText}"`).join("\n") +
            "\n\nOutput the corrected letter only.",
        },
      ]);
      raw = textOf(revision.content);
      letter = neutraliseSalutation(unfence(raw));
      violations = findSlop(letter, { prose: true });
    }

    if (violations.length > 0) {
      log.error(
        { company: options.companyName, violations: violations.length },
        "Cover letter still contains AI slop after one revision — not sending it",
      );
      // Sending a letter full of cliches is worse than sending none. This is
      // his one impression at a company that cleared every gate.
      return failure(
        "slop",
        `The cover letter still reads as AI slop after a revision, so it was not used: ` +
          violations.map((v) => `${v.rule} ("${v.matchedText}")`).join("; "),
        violations.map((v) => `${v.rule}: "${v.matchedText}"`),
      );
    }

    if (letter.length < MIN_LETTER_CHARS) {
      return failure("empty", `The model returned ${letter.length} characters (after one retry), which is an acknowledgement rather than a letter.`);
    }

    let removed: string[] = [];
    const facts = checkLetterFacts(letter, factCtx);
    if (facts.length > 0) {
      const cut = removeSentences(letter, facts.map((v) => v.sentence));
      if (readsWhole(cut) && checkLetterFacts(cut, factCtx).length === 0) {
        log.warn({ company: options.companyName, removed: facts.length }, "Cover letter facts failed — cut the sentences");
        removed = facts.map((v) => v.sentence);
        letter = cut;
      } else {
        const again = await model.invoke([
          ...base,
          { role: "assistant", content: raw },
          {
            role: "user",
            content:
              "That draft states facts the candidate's data does not support. Remove or correct exactly these, keep everything else:\n\n" +
              factsListing(facts).map((l) => `- ${l}`).join("\n") +
              "\n\nOutput the corrected letter only.",
          },
        ]);
        letter = neutraliseSalutation(unfence(textOf(again.content)));
        const left = letter.length < MIN_LETTER_CHARS ? facts : checkLetterFacts(letter, factCtx);
        const slopLeft = findSlop(letter, { prose: true });
        if (left.length > 0 || slopLeft.length > 0) {
          const lines = [...factsListing(left), ...slopLeft.map((v) => `${v.rule}: "${v.matchedText}"`)];
          return failure("facts", `The letter states facts the profile does not support, so it was not used: ${lines.join("; ")}`, lines);
        }
      }
    }

    if (letter.length > MAX_LETTER_CHARS) {
      return failure(
        "length",
        `The letter is ${letter.length} characters. Application forms truncate at around ${MAX_LETTER_CHARS} without saying so, which would drop the ending.`,
      );
    }

    log.info({ company: options.companyName, chars: letter.length }, "Cover letter written");
    return { success: true, letter, ...(removed.length > 0 ? { removed } : {}) };
  } catch (err) {
    // Returned, not thrown: the caller has already built a CV PDF and must still
    // deliver it. A provider outage costs the letter, not the application.
    return failure("error", (err as Error).message);
  }
}
