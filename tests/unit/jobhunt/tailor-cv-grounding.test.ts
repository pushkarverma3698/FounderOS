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

import { describe, it, expect, vi, beforeEach } from "vitest";

const BASE_CV = `# Test Candidate

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

/** A tailored CV that names Kubernetes — a technology the base CV never states. */
const FABRICATED_CV = `# Test Candidate

## SKILLS
Python, Docker, PostgreSQL, Kubernetes

## EXPERIENCE

### Turicks — Founding Engineer
Jan 2023 — Present
- Built agent orchestration in Python on Postgres.
`;

/** The same CV with the fabrication removed — every term grounded in BASE_CV. */
const GROUNDED_CV = `# Test Candidate

## SKILLS
Python, Docker, PostgreSQL

## EXPERIENCE

### Turicks — Founding Engineer
Jan 2023 — Present
- Built agent orchestration in Python on Postgres.
`;

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
    invokeMock.mockResolvedValue({ content: GROUNDED_CV });
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
    invokeMock.mockResolvedValue({ content: GROUNDED_CV });
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
      .mockResolvedValueOnce({ content: FABRICATED_CV })
      .mockResolvedValueOnce({ content: GROUNDED_CV });

    const res = await run(await loadTailorCv());

    expect(res.success).toBe(true);
    expect(res.tailoredMarkdown).toContain("PostgreSQL");
    expect(res.tailoredMarkdown).not.toContain("Kubernetes");
    expect(invokeMock).toHaveBeenCalledTimes(2);
    // The repair turn must name the offending claim, not restate the rules.
    expect(promptOfCall(1)).toContain("Kubernetes");
  });

  it("still refuses a CV whose fabrication survives the repair round", async () => {
    invokeMock.mockResolvedValue({ content: FABRICATED_CV });

    const res = await run(await loadTailorCv());

    expect(res.success).toBe(false);
    expect(res.tailoredMarkdown).toBeUndefined();
    expect(res.error).toContain("Kubernetes");
    // Exactly one repair round — never an unbounded retry loop against a paid model.
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("reports the refusal compactly enough to survive the Telegram clip", async () => {
    invokeMock.mockResolvedValue({ content: FABRICATED_CV });

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
