/**
 * Unit tests — the agent brief lint (src/tools/agent-brief-lint.ts).
 * ==================================================================
 * Issue #762 ("Jev AI") reached Antigravity naming src/agents/supervisor.ts and
 * src/tools/brain.ts, files that were never on main, and it carried 7 of the
 * template's 9 sections. The executor wrote a fake integration and it was reverted
 * in #765. Nothing looked at the brief first. These tests pin what the lint must
 * have caught, and the two ways it must NOT fire: on a file the task will create,
 * and on GitHub being down.
 *
 * The fixture is the verbatim body of #762 (tests/fixtures/agent-briefs/).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  AGENT_BRIEF_HEADINGS,
  BRIEF_PATH_CHECK_CONCURRENCY,
  MAX_BRIEF_CHARS,
  MAX_BRIEF_PATH_CHECKS,
  formatBriefRejection,
  lintAgentBrief,
  type AgentBriefHeading,
  type FileExists,
} from "../../../src/tools/agent-brief-lint.js";
import { filledBrief as brief } from "../../helpers/agent-brief.js";

const read = (repoRelative: string): string =>
  readFileSync(new URL(`../../../${repoRelative}`, import.meta.url), "utf8");

const ISSUE_762 = read("tests/fixtures/agent-briefs/issue-762-jev-ai.md");
const ISSUE_762_CORRECTED = read("tests/fixtures/agent-briefs/issue-762-jev-ai.corrected.md");

/** A fileExists that knows exactly these repo-relative paths, and records what it was asked. */
function existing(...paths: string[]): FileExists & { readonly asked: string[] } {
  const asked: string[] = [];
  const fn = ((path: string) => {
    asked.push(path);
    return paths.includes(path);
  }) as FileExists & { asked: string[] };
  fn.asked = asked;
  return fn;
}

const SCOPE: AgentBriefHeading = "Files or subsystem in scope";

describe("AGENT_BRIEF_HEADINGS", () => {
  it("is exactly the `##` headings of .github/ISSUE_TEMPLATE/agent-task.md, in template order", () => {
    const fromTemplate = read(".github/ISSUE_TEMPLATE/agent-task.md")
      .split("\n")
      .filter((line) => line.startsWith("## "))
      .map((line) => line.slice(3).trim());

    expect(fromTemplate).toHaveLength(9);
    expect([...AGENT_BRIEF_HEADINGS]).toEqual(fromTemplate);
  });
});

describe("issue #762, verbatim", () => {
  it("fails on BOTH the two missing template sections AND the paths that do not exist", async () => {
    const result = await lintAgentBrief(ISSUE_762, existing("src/tools/index.ts"));

    expect(result.ok).toBe(false);
    expect(result.missingHeadings).toEqual(["Evidence", "Constraints"]);
    expect(result.missingPaths).toEqual([
      "src/agents/supervisor.ts",
      "src/tools/brain.ts",
      "src/services/jev-ai.ts",
    ]);
    expect(result.missing).toHaveLength(5);
    expect(result.warnings).toEqual([]);
  });

  it("fails on the plain-text scope list alone: the most important list is not backticked", async () => {
    // In #762 the scope list is `src/a.ts, src/b.ts, …` with no backticks at all. A
    // backticks-only check finds supervisor.ts only because the Expected-behavior
    // section happened to repeat it.
    const body = brief({
      [SCOPE]: "src/agents/supervisor.ts, src/tools/index.ts, src/services/jev-ai.ts",
    });
    const result = await lintAgentBrief(body, existing("src/tools/index.ts"));

    expect(result.missingHeadings).toEqual([]);
    expect(result.missingPaths).toEqual(["src/agents/supervisor.ts", "src/services/jev-ai.ts"]);
  });

  it("returns the same verdict for CRLF line endings, which is what the GitHub web editor stores", async () => {
    const lf = await lintAgentBrief(ISSUE_762, existing("src/tools/index.ts"));
    const crlf = await lintAgentBrief(ISSUE_762.replace(/\n/g, "\r\n"), existing("src/tools/index.ts"));

    expect(crlf).toEqual(lf);
  });

  it("passes a corrected brief: real files, both missing sections added, the new file listed as new", async () => {
    const exists = existing("src/kernel/supervisor.ts", "src/tools/rag.ts", "src/tools/index.ts", "src/kernel");
    const result = await lintAgentBrief(ISSUE_762_CORRECTED, exists);

    expect(result).toEqual({
      ok: true,
      missing: [],
      missingHeadings: [],
      emptyHeadings: [],
      missingPaths: [],
      otherProblems: [],
      warnings: [],
    });
    // The file the task will create is under "### New files to create": never looked up.
    expect(exists.asked).not.toContain("src/tools/rag-prefilter.ts");
    // A directory is a legal path.
    expect(exists.asked).toContain("src/kernel");
  });
});

describe("template sections", () => {
  it("accepts a brief with all nine sections filled", async () => {
    expect((await lintAgentBrief(brief(), existing())).ok).toBe(true);
  });

  it("names each missing section as the template does, in template order", async () => {
    const body = brief().replace("## Goal\n\nFilled in.\n", "").replace("## Constraints\n\nFilled in.\n", "");
    const result = await lintAgentBrief(body, existing());

    expect(result.ok).toBe(false);
    expect(result.missingHeadings).toEqual(["Goal", "Constraints"]);
    expect(result.emptyHeadings).toEqual([]);
    expect(result.missing).toEqual([
      'Section "## Goal" is missing.',
      'Section "## Constraints" is missing.',
    ]);
  });

  it("counts a heading holding only whitespace as missing, and says it is empty", async () => {
    const result = await lintAgentBrief(brief({ Evidence: "   \n\n  \t\n" }), existing());

    expect(result.missingHeadings).toEqual(["Evidence"]);
    expect(result.emptyHeadings).toEqual(["Evidence"]);
    expect(result.missing).toEqual([
      'Section "## Evidence" is empty (only whitespace or an HTML comment).',
    ]);
  });

  it("counts a heading holding only an HTML comment as missing: that is the unfilled template", async () => {
    const result = await lintAgentBrief(
      brief({
        Goal: "<!-- One paragraph. What does \"done\" mean? -->",
        Evidence: "<!-- Logs, file:line references,\n     links to prior investigation. -->",
        Constraints: "<!-- one -->\n<!-- two -->",
      }),
      existing(),
    );

    expect(result.missingHeadings).toEqual(["Goal", "Evidence", "Constraints"]);
  });

  it("counts the verbatim template file as nine empty sections", async () => {
    const result = await lintAgentBrief(read(".github/ISSUE_TEMPLATE/agent-task.md"), existing());

    expect(result.ok).toBe(false);
    expect(result.missingHeadings).toEqual([...AGENT_BRIEF_HEADINGS]);
    expect(result.emptyHeadings).toEqual([...AGENT_BRIEF_HEADINGS]);
  });

  it("does not count a sub-heading as content, but does count the text under it", async () => {
    const onlySubheading = await lintAgentBrief(brief({ Goal: "### Details\n" }), existing());
    const withText = await lintAgentBrief(brief({ Goal: "### Details\n\nShip the thing." }), existing());

    expect(onlySubheading.missingHeadings).toEqual(["Goal"]);
    expect(withText.missingHeadings).toEqual([]);
  });

  it("matches headings case-insensitively and ignores a trailing colon or closing hashes", async () => {
    const body = [
      "## goal:\n\nx\n",
      "##   Problem / observed behavior   \n\nx\n",
      "## Expected behavior ##\n\nx\n",
      "## EVIDENCE\n\nx\n",
      "## Files or subsystem in scope\n\nx\n",
      "## Constraints\n\nx\n",
      "## Explicitly forbidden\n\nx\n",
      "## Verification commands\n\nx\n",
      "## Acceptance criteria\n\nx\n",
    ].join("\n");

    expect((await lintAgentBrief(body, existing())).missingHeadings).toEqual([]);
  });

  it("requires a level-2 heading, like the template: a level-3 heading is not the section", async () => {
    const body = brief().replace("## Goal", "### Goal");
    expect((await lintAgentBrief(body, existing())).missingHeadings).toEqual(["Goal"]);
  });

  it("does not see a heading inside a fenced code block or an HTML comment", async () => {
    const hidden = brief().replace("## Evidence\n\nFilled in.\n", "```md\n## Evidence\n\nquoted\n```\n<!-- ## Evidence -->\n");
    expect((await lintAgentBrief(hidden, existing())).missingHeadings).toEqual(["Evidence"]);
  });

  it("counts a section that holds only a fenced block as filled, and an empty fence as empty", async () => {
    const commands = await lintAgentBrief(brief({ "Verification commands": "```bash\npnpm test\n```" }), existing());
    const hollow = await lintAgentBrief(brief({ "Verification commands": "```\n```" }), existing());

    expect(commands.missingHeadings).toEqual([]);
    expect(hollow.missingHeadings).toEqual(["Verification commands"]);
  });

  it("reports an unclosed fence as the sections it swallowed, never as a pass", async () => {
    // Loud direction: everything after an unclosed ``` is code as far as Markdown is
    // concerned, so the sections after it are reported missing instead of silently ignored.
    const body = brief().replace("## Acceptance criteria", "```\n## Acceptance criteria");
    const result = await lintAgentBrief(body, existing());

    expect(result.missingHeadings).toEqual(["Acceptance criteria"]);
  });
});

describe("which paths are checked", () => {
  it("checks a backticked path under src/, scripts/, deploy/ or tests/ anywhere in the brief", async () => {
    const body = brief({
      "Expected behavior": "Edit `src/tools/nope.ts`, `scripts/nope.ts`, `deploy/nope`, and `tests/unit/nope.test.ts`.",
    });
    const result = await lintAgentBrief(body, existing());

    expect(result.missingPaths).toEqual([
      "src/tools/nope.ts",
      "scripts/nope.ts",
      "deploy/nope",
      "tests/unit/nope.test.ts",
    ]);
  });

  it("does NOT check a path outside the scope section that is not backticked (documented limit)", async () => {
    const exists = existing();
    const body = brief({ "Expected behavior": "Edit src/tools/nope.ts and also src/tools/other.ts." });

    expect((await lintAgentBrief(body, exists)).ok).toBe(true);
    expect(exists.asked).toEqual([]);
  });

  it("checks only the four roots when a path is backticked outside the scope section", async () => {
    const exists = existing();
    const body = brief({ Evidence: "See `docs/plans/x.md`, `package.json`, `.github/workflows/ci.yml`." });

    await lintAgentBrief(body, exists);
    expect(exists.asked).toEqual([]);
  });

  it("checks path-shaped tokens in the scope section whether comma, space or newline separated", async () => {
    const body = brief({
      [SCOPE]: "src/a.ts, src/b.ts src/c.ts\n- src/d.ts\n* `src/e.ts` and docs/plans/f.md; packages/api/g.ts",
    });
    const exists = existing();
    await lintAgentBrief(body, exists);

    expect(exists.asked).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
      "src/d.ts",
      "src/e.ts",
      "docs/plans/f.md",
      "packages/api/g.ts",
    ]);
  });

  it("does not mistake prose for paths in the scope section", async () => {
    const exists = existing();
    const prose =
      "Handle the read/write path, and/or the input/output split, 24/7, for Node.js and Next.js, " +
      "e.g. TCP/IP, i.e. client/server, see README.md/CHANGELOG.md and @langchain/core/tools, " +
      "docs at example.com/a/b.ts and github.com/o/r/blob/main/src/a.ts, version 1.2/3.4.";

    const result = await lintAgentBrief(brief({ [SCOPE]: prose }), exists);

    expect(result.ok).toBe(true);
    expect(exists.asked).toEqual([]);
  });

  it("skips globs, placeholders and ellipses", async () => {
    const exists = existing();
    const body = brief({
      [SCOPE]:
        "src/**/*.ts, src/tools/*.ts, src/<name>/x.ts, tests/unit/<mirrored path>.test.ts, src/…, src/{a,b}.ts, src/x?.ts",
      "Expected behavior":
        "`src/**/*.ts` `src/tools/*.test.ts` `src/<name>/index.ts` `tests/unit/<mirrored path>.test.ts` `src/…` `src/{a,b}.ts`",
    });

    expect((await lintAgentBrief(body, exists)).ok).toBe(true);
    expect(exists.asked).toEqual([]);
  });

  it("skips URLs, absolute paths and paths that leave the repository", async () => {
    const exists = existing();
    const body = brief({
      [SCOPE]:
        "https://github.com/o/r/blob/main/src/a.ts /opt/founderos/src/a.ts ../outside/x.ts ./../x/y.ts",
      "Expected behavior": "`src/../../etc/passwd` `/etc/passwd` `../src/a.ts`",
    });

    expect((await lintAgentBrief(body, exists)).ok).toBe(true);
    expect(exists.asked).toEqual([]);
  });

  it("normalises before asking: leading ./, doubled slashes, and .. inside the repo", async () => {
    const exists = existing();
    await lintAgentBrief(brief({ [SCOPE]: "./src/a.ts, src//b.ts, src/x/../c.ts" }), exists);

    expect(exists.asked).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  it("strips a trailing :123, :12:5, :10-20 or #L12 line reference before checking", async () => {
    const exists = existing();
    await lintAgentBrief(
      brief({ [SCOPE]: "src/a.ts:120, src/b.ts:12:5, src/c.ts:10-20, src/d.ts#L12, src/e.ts#L12-L20, src/f.ts:L7" }),
      exists,
    );

    expect(exists.asked).toEqual(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts", "src/f.ts"]);
  });

  it("strips punctuation and markdown decoration around a path", async () => {
    const exists = existing();
    await lintAgentBrief(
      brief({ [SCOPE]: "(src/a.ts), **src/b.ts**, 'src/c.ts'. [src/d.ts] see [the file](src/e.ts)." }),
      exists,
    );

    expect(exists.asked).toEqual(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"]);
  });

  it("allows a directory, with or without a trailing slash, and asks about it once", async () => {
    const exists = existing("src/tools");
    const result = await lintAgentBrief(brief({ [SCOPE]: "src/tools/ and src/tools" }), exists);

    expect(result.ok).toBe(true);
    expect(exists.asked).toEqual(["src/tools"]);
  });

  it("asks about each distinct path once, wherever it is repeated", async () => {
    const exists = existing();
    await lintAgentBrief(
      brief({ [SCOPE]: "src/a.ts, src/a.ts", "Expected behavior": "`src/a.ts` `src/b.ts` `src/b.ts`" }),
      exists,
    );

    expect(exists.asked).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("asks scope-section paths first, so the cap can never spend itself on the less important ones", async () => {
    const exists = existing();
    await lintAgentBrief(
      brief({ "Expected behavior": "`src/ticked.ts`", [SCOPE]: "src/scoped.ts" }),
      exists,
    );

    expect(exists.asked).toEqual(["src/scoped.ts", "src/ticked.ts"]);
  });
});

describe("files the task will create", () => {
  it("exempts every path under a heading containing 'new file' (section and sub-section)", async () => {
    const exists = existing();
    const body =
      brief({ [SCOPE]: "src/old.ts\n\n### New files to create\n\nsrc/new-in-scope.ts\n`src/new-ticked.ts`" }) +
      "\n## New files\n\n`src/new-section.ts`\nsrc/new-plain.ts\n";
    const result = await lintAgentBrief(body, exists);

    expect(result.missingPaths).toEqual(["src/old.ts"]);
    expect(exists.asked).toEqual(["src/old.ts"]);
  });

  it("ends the exemption at the next heading of the same or higher level", async () => {
    const body = [
      brief({ [SCOPE]: "### New files\n\nsrc/new.ts\n\n### Existing files\n\nsrc/after-subsection.ts" }),
      "## New file to create\n\n`src/new-section.ts`\n\n## Notes\n\n`src/after-section.ts`\n",
    ].join("\n");
    const result = await lintAgentBrief(body, existing());

    expect(result.missingPaths).toEqual(["src/after-subsection.ts", "src/after-section.ts"]);
  });

  it("matches 'new file' case-insensitively, and a heading that merely mentions files does not exempt", async () => {
    const shouting = await lintAgentBrief(brief({ [SCOPE]: "### NEW FILE\n\nsrc/n.ts" }), existing());
    const renamed = await lintAgentBrief(brief({ [SCOPE]: "### Renamed files\n\nsrc/r.ts" }), existing());

    expect(shouting.missingPaths).toEqual([]);
    expect(renamed.missingPaths).toEqual(["src/r.ts"]);
  });
});

describe("fenced code blocks are not scanned (documented limit)", () => {
  it("does not fail a brief for a path inside a ``` or ~~~ fence", async () => {
    const exists = existing();
    const body = brief({
      Evidence: "```ts\nimport x from \"`src/tools/nope.ts`\";\n```\n\n~~~\n`scripts/nope.ts`\n~~~\n\n````\n```\n`tests/nope.ts`\n```\n````",
      [SCOPE]: "```\nsrc/nope-in-fence.ts\n```\nsrc/real.ts",
    });
    const result = await lintAgentBrief(body, exists);

    expect(result.missingPaths).toEqual(["src/real.ts"]);
    expect(exists.asked).toEqual(["src/real.ts"]);
  });

  it("scans again after the fence closes, and only a matching fence closes it", async () => {
    const body = brief({
      Evidence: "```\n~~~\n`src/still-in-fence.ts`\n```\n`src/after-fence.ts`",
    });
    const result = await lintAgentBrief(body, existing());

    expect(result.missingPaths).toEqual(["src/after-fence.ts"]);
  });
});

describe("the check budget", () => {
  const manyPaths = (n: number): string => Array.from({ length: n }, (_, i) => `src/gen/f${i}.ts`).join(", ");

  it("asks about at most MAX_BRIEF_PATH_CHECKS paths and says how many it did not check", async () => {
    const paths = manyPaths(45).split(", ");
    const exists = existing(...paths);
    const result = await lintAgentBrief(brief({ [SCOPE]: paths.join(", ") }), exists);

    expect(MAX_BRIEF_PATH_CHECKS).toBe(30);
    expect(exists.asked).toHaveLength(MAX_BRIEF_PATH_CHECKS);
    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("first 30 of 45");
    expect(result.warnings[0]).toContain("15 were not checked");
  });

  it("never has more than BRIEF_PATH_CHECK_CONCURRENCY lookups in flight, and does use the parallelism", async () => {
    let inFlight = 0;
    let peak = 0;
    const slow: FileExists = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return true;
    };

    await lintAgentBrief(brief({ [SCOPE]: manyPaths(20) }), slow);

    expect(BRIEF_PATH_CHECK_CONCURRENCY).toBeLessThanOrEqual(4);
    expect(peak).toBe(BRIEF_PATH_CHECK_CONCURRENCY);
  });

  it("reports missing paths in document order even when the lookups finish out of order", async () => {
    const lateFirst: FileExists = async (path) => {
      await new Promise((resolve) => setTimeout(resolve, path.endsWith("a.ts") ? 20 : 0));
      return false;
    };
    const result = await lintAgentBrief(brief({ [SCOPE]: "src/a.ts, src/b.ts, src/c.ts" }), lateFirst);

    expect(result.missingPaths).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  it("makes no lookup at all when the brief names no path", async () => {
    const exists = existing();
    expect((await lintAgentBrief(brief(), exists)).ok).toBe(true);
    expect(exists.asked).toEqual([]);
  });
});

describe("GitHub or the network being down never blocks a dispatch", () => {
  const unavailable = (): never => {
    throw Object.assign(new Error("Service Unavailable"), { status: 503 });
  };

  it("treats a lookup that throws as a warning, not a missing path", async () => {
    const result = await lintAgentBrief(brief({ [SCOPE]: "src/a.ts, src/b.ts" }), unavailable);

    expect(result.ok).toBe(true);
    expect(result.missingPaths).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Could not verify 2 of 2 paths");
    expect(result.warnings[0]).toContain("Service Unavailable");
    expect(result.warnings[0]).toContain("src/a.ts");
    expect(result.warnings[0]).toContain("not blocking");
  });

  it("treats a rejected promise and an explicit 'unknown' the same way", async () => {
    const rejects: FileExists = () => Promise.reject(new Error("fetch failed"));
    const unknown: FileExists = () => "unknown";

    const a = await lintAgentBrief(brief({ [SCOPE]: "src/a.ts" }), rejects);
    const b = await lintAgentBrief(brief({ [SCOPE]: "src/a.ts" }), unknown);

    expect(a.ok && b.ok).toBe(true);
    expect(a.warnings[0]).toContain("fetch failed");
    expect(b.warnings[0]).toContain("Could not verify 1 of 1 path");
  });

  it("still fails on a definite 'no' when other lookups were unavailable", async () => {
    const mixed: FileExists = (path) => {
      if (path === "src/gone.ts") return false;
      return unavailable();
    };
    const result = await lintAgentBrief(brief({ [SCOPE]: "src/gone.ts, src/unsure.ts" }), mixed);

    expect(result.ok).toBe(false);
    expect(result.missingPaths).toEqual(["src/gone.ts"]);
    expect(result.warnings[0]).toContain("Could not verify 1 of 2 paths");
    expect(result.warnings[0]).toContain("src/unsure.ts");
  });

  it("keeps the warning to one readable line, however many paths were unverifiable", async () => {
    const result = await lintAgentBrief(brief({ [SCOPE]: Array.from({ length: 20 }, (_, i) => `src/p${i}.ts`).join(", ") }), unavailable);

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("(+15 more)");
    expect(result.warnings[0]?.length).toBeLessThan(400);
  });
});

describe("size: a body GitHub would refuse, and text that must not stall the bot", () => {
  it("refuses a body over GitHub's 65,536-character limit up front, with the size, and looks nothing up", async () => {
    // Filed anyway it fails with a 422 at issues.create, AFTER the founder approved the card.
    const exists = existing();
    const body = brief({ Goal: "x".repeat(MAX_BRIEF_CHARS) });
    const result = await lintAgentBrief(body, exists);

    expect(MAX_BRIEF_CHARS).toBe(65_536);
    expect(result.ok).toBe(false);
    expect(result.otherProblems).toHaveLength(1);
    expect(result.otherProblems[0]).toContain(`${body.length.toLocaleString("en-US")} characters`);
    expect(result.otherProblems[0]).toContain("65,536");
    expect(result.missing).toEqual([...result.otherProblems]);
    expect(exists.asked).toEqual([]);
    expect(formatBriefRejection(result, { target: "o/r" })).toContain("1. The brief is");
  });

  it("accepts a body of exactly the limit", async () => {
    const padded = brief();
    const body = padded + "y".repeat(MAX_BRIEF_CHARS - padded.length);

    expect(body.length).toBe(MAX_BRIEF_CHARS);
    expect((await lintAgentBrief(body, existing())).ok).toBe(true);
  });

  // Each of these is a few dozen characters short of the limit and took 1.5 to 7 seconds of
  // event-loop time when a regex backtracked quadratically. The bot is single-threaded: that is
  // the whole Telegram gateway frozen, so each is held to a second (they run in milliseconds).
  const filled = (scope: string, tail = ""): string => brief({ [SCOPE]: scope }, tail);
  it.each([
    ["an open bracket, 65,000 times, in the scope section", filled("[".repeat(65_000))],
    ["one 60,000-character token of ':1' pairs ending in x", filled(":1".repeat(30_000) + "x")],
    ["a heading made of 60,000 colons and an x", filled("src/a.ts", `\n## ${":".repeat(60_000)}x\n`)],
    ["a heading with 60,000 spaces between two words", filled("src/a.ts", `\n## a${" ".repeat(60_000)}b\n`)],
    ["a 60,000-character run of dots ending in x, in the scope section", filled(".".repeat(60_000) + "x")],
    ["'[a](' 15,000 times", filled("[a](".repeat(15_000))],
    ["65,000 backticks", filled("`".repeat(65_000))],
    ["65,000 angle brackets", filled("<".repeat(65_000))],
  ])("stays linear on %s", async (_label, body) => {
    expect(body.length).toBeLessThan(MAX_BRIEF_CHARS);
    const started = Date.now();
    await lintAgentBrief(body, () => true);

    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("formatBriefRejection", () => {
  it("prints every problem with its own reason, and tells the author where files-to-be-created go", async () => {
    const result = await lintAgentBrief(ISSUE_762, existing("src/tools/index.ts"));
    const text = formatBriefRejection(result, { target: "pushkarverma3698/FounderOS" });

    expect(text).toContain("nothing was filed on pushkarverma3698/FounderOS");
    expect(text).toContain('1. Section "## Evidence" is missing.');
    expect(text).toContain('2. Section "## Constraints" is missing.');
    expect(text).toContain("3. `src/agents/supervisor.ts` does not exist in pushkarverma3698/FounderOS.");
    expect(text).toContain("5. `src/services/jev-ai.ts` does not exist in pushkarverma3698/FounderOS.");
    expect(text).toContain('a heading that contains "new file"');
    expect(text).toContain("ask the founder");
  });

  it("appends the caller's per-section hints and new-file hint, and carries warnings along", async () => {
    const result = await lintAgentBrief(brief({ Evidence: "", [SCOPE]: "src/gone.ts, src/unsure.ts" }), (p) =>
      p === "src/gone.ts" ? false : "unknown",
    );
    const text = formatBriefRejection(result, {
      target: "o/r",
      hints: { Evidence: "Pass the `evidence` input." },
      newFilesHint: "Use the `new_files` input.",
    });

    expect(text).toContain('Section "## Evidence" is empty (only whitespace or an HTML comment). Pass the `evidence` input.');
    expect(text).toContain("Use the `new_files` input.");
    expect(text).toContain("Could not verify 1 of 2 paths");
  });

  it("is a single problem singular", async () => {
    const result = await lintAgentBrief(brief({ Goal: "" }), existing());
    expect(formatBriefRejection(result, { target: "o/r" })).toContain("1 problem to fix");
  });
});
