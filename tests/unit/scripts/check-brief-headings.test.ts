/**
 * Is this issue body a complete brief? — `agent-dispatch --check-brief` (check_brief_headings).
 * ============================================================================================
 * Antigravity reads an issue with no other context. #762 "Jev AI" was written from a brief
 * that named a file which does not exist, shipped a fake integration, and was reverted in
 * #765. ISSUE-DRIVEN-CONTRACT.md calls agent:ready an "intake gate", but nothing checked the
 * body against .github/ISSUE_TEMPLATE/agent-task.md. This is the daemon's half of that check
 * (the TypeScript half runs before an issue is filed): every one of the template's nine
 * sections must be present and say something.
 *
 * The check is a pure function of the body, so it is driven here through the CLI entry point
 * that needs no gh, no network and no state. The integration test that a real /task body and a
 * real self-improvement body pass it lives with whoever owns those renderers; it calls the
 * same entry point:   bash deploy/agent-dispatch --check-brief < body.md ; echo $?
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BRIEF_HEADINGS, goodBrief } from "./dispatch-sandbox.js";

const SCRIPT = fileURLToPath(new URL("../../../deploy/agent-dispatch", import.meta.url));
const TEMPLATE = fileURLToPath(new URL("../../../.github/ISSUE_TEMPLATE/agent-task.md", import.meta.url));

function check(body: string): { status: number | null; lines: string[]; stderr: string } {
  const home = mkdtempSync(join(tmpdir(), "check-brief-"));
  try {
    const r = spawnSync("bash", [SCRIPT, "--check-brief"], {
      input: body,
      env: { PATH: "/usr/bin:/bin:/usr/local/bin", HOME: home },
      encoding: "utf8",
      timeout: 20_000,
    });
    return { status: r.status, lines: r.stdout.split("\n").filter(Boolean), stderr: r.stderr };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** goodBrief() with the given sections removed. */
const without = (...names: string[]): string =>
  BRIEF_HEADINGS.filter((h) => !names.includes(h))
    .map((h) => `## ${h}\n\nSomething concrete for ${h}.\n`)
    .join("\n");

/** goodBrief() with one section's body replaced. */
const withSection = (name: string, content: string): string =>
  BRIEF_HEADINGS.map((h) => `## ${h}\n\n${h === name ? content : `Something concrete for ${h}.`}\n`).join("\n");

describe("--check-brief: the required sections", () => {
  it("passes a brief with all nine sections filled in: exit 0, no output", () => {
    const r = check(goodBrief());
    expect(r.status).toBe(0);
    expect(r.lines).toEqual([]);
  });

  it("names every missing section, in template order, and exits 1", () => {
    const r = check(without("Constraints", "Evidence"));
    expect(r.status).toBe(1);
    expect(r.lines).toEqual(["missing: Evidence", "missing: Constraints"]);
  });

  it("an empty body is nine missing sections", () => {
    const r = check("");
    expect(r.status).toBe(1);
    expect(r.lines).toEqual(BRIEF_HEADINGS.map((h) => `missing: ${h}`));
  });

  it("reports a section that has a heading but says nothing as EMPTY, not missing", () => {
    for (const blank of ["", "   \n\t\n", "\n\n\n"]) {
      const r = check(withSection("Acceptance criteria", blank));
      expect(r.lines, `content ${JSON.stringify(blank)}`).toEqual(["empty: Acceptance criteria"]);
    }
  });

  it("does not count the template's own guidance comment as content, even across several lines", () => {
    const oneLine = withSection("Goal", "<!-- One paragraph. What does done mean? -->");
    const multiLine = withSection("Goal", "<!--\nOne paragraph.\nWhat does done mean?\n-->\n");
    expect(check(oneLine).lines).toEqual(["empty: Goal"]);
    expect(check(multiLine).lines).toEqual(["empty: Goal"]);
  });

  it("counts real text that follows a comment on the same line", () => {
    expect(check(withSection("Goal", "<!-- guidance --> Ship the thing.")).status).toBe(0);
  });

  it("the unedited issue template is rejected with all nine sections empty [the real template file]", () => {
    const template = readFileSync(TEMPLATE, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
    const r = check(template);
    expect(r.status).toBe(1);
    expect(r.lines).toEqual(BRIEF_HEADINGS.map((h) => `empty: ${h}`));
  });

  it("the template with every section filled in passes [the real template file]", () => {
    const template = readFileSync(TEMPLATE, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
    const filled = template.replace(/^## (.+)$/gm, (_m, h: string) => `## ${h}\n\nReal content for ${h}.`);
    expect(check(filled).lines).toEqual([]);
  });
});

describe("--check-brief: how a body is read", () => {
  it("matches headings case-insensitively and tolerates trailing spaces and closing hashes", () => {
    const body = BRIEF_HEADINGS.map((h, i) => {
      const styled = i % 3 === 0 ? h.toLowerCase() : i % 3 === 1 ? `${h}   ` : `${h} ##`;
      return `## ${styled}\n\ntext\n`;
    }).join("\n");
    expect(check(body).lines).toEqual([]);
  });

  it("reads a CRLF body, which is what GitHub's web editor sends", () => {
    expect(check(goodBrief().replace(/\n/g, "\r\n")).lines).toEqual([]);
    expect(check(without("Evidence").replace(/\n/g, "\r\n")).lines).toEqual(["missing: Evidence"]);
  });

  it("does not accept a heading at another level: '# Goal' and '### Goal' are not the template's '## Goal'", () => {
    const h1 = goodBrief().replace("## Goal", "# Goal");
    const h3 = goodBrief().replace("## Goal", "### Goal");
    expect(check(h1).lines).toEqual(["missing: Goal"]);
    expect(check(h3).lines).toEqual(["missing: Goal"]);
  });

  it("does not count a heading inside a fenced code block", () => {
    const body = `${without("Evidence")}\n## Files or subsystem in scope\n\n\`\`\`md\n## Evidence\nlooks like one\n\`\`\`\n`;
    expect(check(body).lines).toEqual(["missing: Evidence"]);
  });

  it("counts a fenced code block as the content of its section", () => {
    expect(check(withSection("Verification commands", "```\npnpm test\n```")).lines).toEqual([]);
  });

  it("a level-3 sub-heading belongs to its section and ends nothing", () => {
    expect(check(withSection("Evidence", "### Logs\nline 1")).lines).toEqual([]);
    expect(check(withSection("Evidence", "### Logs")).lines).toEqual([]);
  });

  it("text before the first heading and unrelated sections are ignored", () => {
    const body = `Intro paragraph nobody needs.\n\n## Notes\n\nextra\n\n${goodBrief()}`;
    expect(check(body).lines).toEqual([]);
  });

  it("an unrelated ## section does not swallow the section above it", () => {
    const body = `## Goal\n\n## Notes\n\nGoal text would be wrong here.\n\n${without("Goal")}`;
    expect(check(body).lines).toEqual(["empty: Goal"]);
  });
});

describe("--check-brief: input and exit codes", () => {
  it("reads a file argument, and '-' means stdin", () => {
    const dir = mkdtempSync(join(tmpdir(), "check-brief-file-"));
    try {
      const file = join(dir, "body.md");
      writeFileSync(file, without("Goal"));
      const r = spawnSync("bash", [SCRIPT, "--check-brief", file], {
        env: { PATH: "/usr/bin:/bin", HOME: dir },
        encoding: "utf8",
      });
      expect(r.status).toBe(1);
      expect(r.stdout).toBe("missing: Goal\n");

      const stdin = spawnSync("bash", [SCRIPT, "--check-brief", "-"], {
        input: goodBrief(),
        env: { PATH: "/usr/bin:/bin", HOME: dir },
        encoding: "utf8",
      });
      expect(stdin.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an unreadable file is exit 2 with a message, never a silent 'all nine missing'", () => {
    const home = mkdtempSync(join(tmpdir(), "check-brief-home-"));
    try {
      const r = spawnSync("bash", [SCRIPT, "--check-brief", join(home, "nope.md")], {
        env: { PATH: "/usr/bin:/bin", HOME: home },
        encoding: "utf8",
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/cannot read/);
      expect(r.stdout).toBe("");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("needs no gh, no network and writes no state: it works with an empty PATH-less HOME", () => {
    const home = mkdtempSync(join(tmpdir(), "check-brief-clean-"));
    try {
      const r = spawnSync("bash", [SCRIPT, "--check-brief"], {
        input: goodBrief(),
        env: { PATH: "/usr/bin:/bin", HOME: home },
        encoding: "utf8",
      });
      expect(r.status).toBe(0);
      expect(spawnSync("ls", ["-A", home], { encoding: "utf8" }).stdout).toBe("");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("the AGENT_BRIEF_HEADINGS contract", () => {
  const script = readFileSync(SCRIPT, "utf8");

  /** The array exactly as the script declares it: one quoted heading per line. */
  function declared(): string[] {
    const block = /^AGENT_BRIEF_HEADINGS=\(\n([\s\S]*?)\n\)$/m.exec(script);
    if (!block?.[1]) throw new Error("deploy/agent-dispatch no longer declares AGENT_BRIEF_HEADINGS=( … ) one heading per line");
    return block[1].split("\n").map((l) => {
      const m = /^ {2}"(.+)"$/.exec(l);
      if (!m?.[1]) throw new Error(`AGENT_BRIEF_HEADINGS line is not '  "Heading"': ${JSON.stringify(l)}`);
      return m[1];
    });
  }

  it("is the template's nine '## ' headings, in order, byte for byte", () => {
    const template = readFileSync(TEMPLATE, "utf8");
    const fromTemplate = [...template.matchAll(/^## (.+)$/gm)].map((m) => m[1] as string);
    expect(fromTemplate).toHaveLength(9);
    expect(declared()).toEqual(fromTemplate);
  });

  it("matches the constant the tests use, so a rename cannot leave them checking the old names", () => {
    expect(declared()).toEqual([...BRIEF_HEADINGS]);
  });
});
