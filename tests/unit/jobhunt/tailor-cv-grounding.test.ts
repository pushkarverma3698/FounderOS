/**
 * tailor_cv — the tailoring step must not invent technologies
 * ============================================================
 * MEASURED IN PROD, 2026-09-07. `agents.job_applications`: 1,409 rows screened,
 * 22 tailoring attempts, 21 of them `tailor_status='failed'`, 2 applications
 * ever sent. Every one of those failures was `verifyCvClaims` correctly refusing
 * a CV that named a technology the base CV never states. Driving `/draft 1`
 * through real Telegram twice against the same KPN row produced two DIFFERENT
 * fabrications — "Vector Database", then "ETL" — and `grep -ioc etl` on
 * `/opt/founderos-data/cv/ai/cv.md` returns 0. The model was pulling terms
 * straight out of the job description.
 *
 * It was pulling them because THE PROMPT ASKED IT TO. `tailorCv` handed the
 * model every skill term the JD mentioned under the heading "JD KEYWORDS TO
 * HIGHLIGHT (ONLY IF TRUTHFUL TO BASE CV)" — a list mixing grounded and
 * ungrounded terms, with the model left to sort them. `/jobs` had already
 * printed "Not on your CV: Java, Reinforcement Learning, ETL, ..." for that
 * exact row, so the system knew which ones were traps and passed them in
 * anyway.
 *
 * These tests pin the two properties that close it:
 *   1. The prompt states the permitted technology vocabulary (base-CV terms)
 *      and names the JD-only terms as forbidden. It never invites the model to
 *      highlight a term the base CV does not support.
 *   2. A fabrication that survives the prompt gets ONE repair round against the
 *      guard's own violations — and if the repair still fabricates, the CV is
 *      still refused. The guard's strictness is the thing being protected here,
 *      not the success rate: a guard that passes a fabricated CV is worse than
 *      a blocked application.
 */

/**
 * UPDATED 2026-09-15, when the model stopped writing the CV. It now returns the
 * SUMMARY PARAGRAPH and cv-compose.ts pastes the locked body underneath, so the
 * mocks below are paragraphs rather than documents. Every property these tests
 * protected still holds and one is now stronger: a fabrication can only enter
 * through three lines, and `refuses to let the body drift` pins that the rest of
 * the document is byte-identical to the base CV.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const BASE_CV = `# Test Candidate

## SUMMARY

Engineer who builds agent orchestration on Postgres.

## SKILLS
Python, Docker, PostgreSQL, LangGraph, vector databases

## EXPERIENCE

### Turicks — Founding Engineer
Jan 2023 — Present
- Built agent orchestration in Python on Postgres.
`;

const JOB_DESCRIPTION = `We are hiring an AI Engineer.
You will work with Python, Kubernetes, ETL pipelines and Terraform.
Experience with PostgreSQL is a plus.`;

/** A summary that names Kubernetes — a technology the base CV never states. */
const FABRICATED_SUMMARY =
  "Engineer who builds agent orchestration in Python on PostgreSQL, running on Kubernetes.";

/** The same summary with the fabrication removed — every term grounded in BASE_CV. */
const GROUNDED_SUMMARY =
  "Engineer who builds agent orchestration in Python on PostgreSQL, packaged with Docker.";

const invokeMock = vi.fn();

beforeEach(() => {
  vi.resetModules();
  invokeMock.mockReset();
  vi.doMock("../../../src/agents/worker-invoke.js", () => ({
    invokeWorkerWithFallbacks: invokeMock,
  }));
});

async function loadTailorCv() {
  const { tailorCv } = await import("../../../src/tools/jobhunt/tailor-cv.js");
  return tailorCv;
}

function run(tailorCv: Awaited<ReturnType<typeof loadTailorCv>>) {
  return tailorCv({
    cvText: BASE_CV,
    jobDescription: JOB_DESCRIPTION,
    companyName: "KPN",
    jobTitle: "AI Engineer - Network",
    track: "ai",
  });
}

/** Every message body of the Nth `invokeWorkerWithFallbacks` call, concatenated. */
function promptOfCall(n: number): string {
  const turns = invokeMock.mock.calls[n]?.[0] as ReadonlyArray<{ content: string }>;
  return turns.map((t) => t.content).join("\n");
}

describe("tailorCv — grounded technology vocabulary", () => {
  it("gives the model the base CV's terms as the permitted vocabulary", async () => {
    invokeMock.mockResolvedValue({ content: GROUNDED_SUMMARY });
    const res = await run(await loadTailorCv());

    expect(res.success).toBe(true);
    const prompt = promptOfCall(0);
    // Terms the base CV states — including ones the JD never mentions, because
    // the model must be free to keep what is already true on the CV.
    expect(prompt).toMatch(/PERMITTED TECHNOLOGY VOCABULARY/i);
    expect(prompt).toContain("Docker");
    expect(prompt).toContain("LangGraph");
  });

  it("names the JD-only terms as forbidden instead of inviting them", async () => {
    invokeMock.mockResolvedValue({ content: GROUNDED_SUMMARY });
    await run(await loadTailorCv());

    const prompt = promptOfCall(0);
    // The heading that caused the prod fabrications is gone.
    expect(prompt).not.toMatch(/KEYWORDS TO HIGHLIGHT/i);
    // ETL and Kubernetes are asked for by the JD and absent from the base CV.
    const forbidden = /NOT ON THIS CV[^\n]*\n([^\n]*)/i.exec(prompt)?.[1] ?? "";
    expect(forbidden).toContain("ETL");
    expect(forbidden).toContain("Kubernetes");
    // Python is on the base CV — forbidding it would strip a truthful match.
    expect(forbidden).not.toContain("Python");
  });

  it("repairs one ungrounded claim and succeeds on the retry", async () => {
    invokeMock
      .mockResolvedValueOnce({ content: FABRICATED_SUMMARY })
      .mockResolvedValueOnce({ content: GROUNDED_SUMMARY });

    const res = await run(await loadTailorCv());

    expect(res.success).toBe(true);
    expect(res.tailoredMarkdown).toContain("PostgreSQL");
    expect(res.tailoredMarkdown).not.toContain("Kubernetes");
    expect(invokeMock).toHaveBeenCalledTimes(2);
    // The repair turn must name the offending claim, not restate the rules.
    expect(promptOfCall(1)).toContain("Kubernetes");
  });

  it("still refuses a CV whose fabrication survives the repair round", async () => {
    invokeMock.mockResolvedValue({ content: FABRICATED_SUMMARY });

    const res = await run(await loadTailorCv());

    expect(res.success).toBe(false);
    expect(res.tailoredMarkdown).toBeUndefined();
    expect(res.error).toContain("Kubernetes");
    // Exactly one repair round — never an unbounded retry loop against a paid model.
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("refuses to let the body drift — everything below the summary is byte-identical", async () => {
    // Founder direction, 2026-09-15: "the Base CV is locked." This is the
    // assertion that makes that a mechanism rather than a wish. Before this the
    // model regenerated the whole document, so two runs against one posting
    // produced two different CVs and nothing compared them.
    invokeMock.mockResolvedValue({ content: GROUNDED_SUMMARY });
    const res = await run(await loadTailorCv());

    expect(res.success).toBe(true);
    const out = res.tailoredMarkdown ?? "";

    // Every line of the base CV survives, except the one summary line replaced.
    const dropped = BASE_CV.split("\n")
      .filter((line) => line.trim().length > 0)
      .filter((line) => !out.split("\n").includes(line));
    expect(dropped).toEqual(["Engineer who builds agent orchestration on Postgres."]);

    // And the model's paragraph is the only thing added.
    expect(out).toContain(GROUNDED_SUMMARY);
    expect(out).toContain("### Turicks — Founding Engineer");
    expect(out).toContain("Python, Docker, PostgreSQL, LangGraph, vector databases");
  });

  it("refuses a base CV with no summary section, before spending a model call", async () => {
    // A silent pass-through here would return a "tailored" CV identical to the
    // base with nothing saying so — and would bill for the privilege.
    const tailorCv = await loadTailorCv();
    const res = await tailorCv({
      cvText: "# Test Candidate\n\n## EXPERIENCE\n- did things\n",
      jobDescription: JOB_DESCRIPTION,
      companyName: "KPN",
      jobTitle: "AI Engineer - Network",
      track: "ai",
    });

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/summary/i);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("reports the refusal compactly enough to survive the Telegram clip", async () => {
    invokeMock.mockResolvedValue({ content: FABRICATED_SUMMARY });

    const res = await run(await loadTailorCv());

    expect(res.success).toBe(false);
    const error = res.error ?? "";
    // Prod 2026-09-07: the founder saw `... [technology] "TD)` because the
    // gateway clipped a 200-char prose blob mid-word. The message itself has to
    // be short enough to arrive whole.
    expect(error.length).toBeLessThan(200);
    // ...and it must still say WHAT was ungrounded, without internal jargon.
    expect(error).toContain("Kubernetes");
    expect(error).not.toContain("extractSkillTerms");
  });
});
