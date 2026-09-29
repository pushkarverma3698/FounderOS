/**
 * Unit tests — the issue an implementation-kind jobhunt finding becomes.
 * =======================================================================
 * A separate change adds a lint that REJECTS an auto-filed issue whose body lacks
 * any of the nine template headings, or that names a backticked `src/`,
 * `scripts/`, `deploy/` or `tests/` path which does not exist. An issue that
 * fails it is never filed, so a finding whose body fails these checks is a loop
 * that is dead on arrival. These tests hold every implementation kind to the same
 * bar the lint will, with the real body the real code renders.
 *
 * They also hold the body to what an unattended executor needs and the lint
 * cannot see: the evidence is rows that were in the data (nothing invented), the
 * verification commands run, and nothing says "investigate".
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DISPATCHABLE_KINDS,
  findingMarker,
  isDispatchable,
  pickDispatchTarget,
  renderIssueBody,
  renderIssueTitle,
} from "../../../src/evolution/issue-body.js";
import {
  JOBHUNT_KINDS,
  findAdapterSilent,
  findApplyLinkUnrecognised,
  type JobhuntSnapshot,
} from "../../../src/evolution/analyzers/jobhunt.js";
import { computeFingerprint } from "../../../src/evolution/fingerprint.js";
import { parseFiledFingerprints } from "../../../src/evolution/dispatch-findings.js";
import { repoRoot } from "../../../src/evolution/repo-root.js";
import type { Finding, FindingKind } from "../../../src/evolution/types.js";
import { NOW, healthy, postings, withSilent } from "../../helpers/jobhunt-fixtures.js";

const ROOT = repoRoot();

const NINE_HEADINGS = [
  "Goal",
  "Problem / observed behavior",
  "Expected behavior",
  "Evidence",
  "Files or subsystem in scope",
  "Constraints",
  "Explicitly forbidden",
  "Verification commands",
  "Acceptance criteria",
] as const;

/** One real finding, with the snapshot it was computed from, per implementation kind. */
function fixtures(): Partial<Record<FindingKind, { finding: Finding; snapshot: JobhuntSnapshot }>> {
  const silentSnapshot = withSilent("ashby");
  const linkSnapshot: JobhuntSnapshot = {
    ...healthy(),
    newPostings: [
      ...postings("smartrecruiters", 14, { fromHoursAgo: 120, toHoursAgo: 3 }, { hasFormLink: false }),
      ...postings("smartrecruiters", 26, { fromHoursAgo: 118, toHoursAgo: 2 }, { hasFormLink: true }),
    ],
  };
  return {
    "adapter-silent": { finding: findAdapterSilent(silentSnapshot, NOW)[0]!, snapshot: silentSnapshot },
    "apply-link-unrecognised": { finding: findApplyLinkUnrecognised(linkSnapshot, NOW)[0]!, snapshot: linkSnapshot },
  };
}

function bodyFor(finding: Finding): string {
  return renderIssueBody(finding, { fingerprint: computeFingerprint(finding), detectedAt: NOW });
}

function section(body: string, heading: string): string {
  const parts = body.split(/^## /m).slice(1);
  const found = parts.find((p) => p.startsWith(`${heading}\n`));
  if (!found) throw new Error(`section "${heading}" is missing`);
  return found.split("\n").slice(1).join("\n").trim();
}

/** Every backticked token that names a path the lint checks. */
function backtickedRepoPaths(body: string): string[] {
  return [...body.matchAll(/`([^`\n]+)`/g)]
    .map((m) => m[1]!)
    .filter((token) => /^(src|scripts|deploy|tests|docs)\//.test(token) && !/\s/.test(token))
    .map((token) => token.replace(/:\d+(-\d+)?$/, ""));
}

function verificationCommands(body: string): string[] {
  const fenced = section(body, "Verification commands").match(/```bash\n([\s\S]*?)```/);
  if (!fenced) throw new Error("no ```bash block under Verification commands");
  return fenced[1]!
    .split("&&")
    .map((c) => c.trim())
    .filter(Boolean);
}

describe("every jobhunt kind is either an issue with a fixture here, or a decision that cannot become one", () => {
  const byKind = fixtures();

  for (const kind of JOBHUNT_KINDS) {
    if (isDispatchable({ kind, subject: "x", evidence: "x", severity: "low" })) {
      it(`${kind}: is dispatchable and this file has a real fixture for it`, () => {
        expect(byKind[kind], `add a fixture for the dispatchable kind "${kind}"`).toBeDefined();
        expect(DISPATCHABLE_KINDS).toContain(kind);
      });
    } else {
      it(`${kind}: is a DECISION, so no issue can be rendered for it`, () => {
        const decision: Finding = { kind, subject: "wife-nl-finance", evidence: "x", severity: "high" };
        expect(() => renderIssueBody(decision, { fingerprint: "a".repeat(64), detectedAt: NOW })).toThrow(
          /not in DISPATCHABLE_KINDS/,
        );
        expect(pickDispatchTarget([decision], new Set())).toBeNull();
      });
    }
  }

  it("exactly adapter-silent and apply-link-unrecognised are implementation kinds; the other two are decisions", () => {
    const issueKinds = JOBHUNT_KINDS.filter((kind) =>
      isDispatchable({ kind, subject: "x", evidence: "x", severity: "low" }),
    );
    expect([...issueKinds].sort()).toEqual(["adapter-silent", "apply-link-unrecognised"]);
  });
});

for (const [kind, { finding, snapshot }] of Object.entries(fixtures()) as Array<
  [FindingKind, { finding: Finding; snapshot: JobhuntSnapshot }]
>) {
  describe(`${kind}: the body passes the lint the auto-issue loop will be held to`, () => {
    const body = bodyFor(finding);

    it("(a) has all nine headings, each with real content", () => {
      const headings = [...body.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
      expect(headings).toEqual([...NINE_HEADINGS]);
      for (const heading of NINE_HEADINGS) {
        expect(section(body, heading).length, heading).toBeGreaterThan(20);
      }
    });

    it("(b) every backticked repo path in it exists in this checkout", () => {
      const paths = backtickedRepoPaths(body);
      expect(paths.length).toBeGreaterThan(3);
      for (const path of paths) {
        expect(existsSync(join(ROOT, path)), `${path} is named in the issue but does not exist`).toBe(true);
      }
    });

    it("(b) the suspected component it names is the finding's own location", () => {
      expect(finding.location).toBeDefined();
      expect(section(body, "Files or subsystem in scope")).toContain(`\`${finding.location}\``);
      expect(section(body, "Evidence")).toContain(`\`${finding.location}\``);
    });

    it("(c) the Evidence section quotes the finding's data rows, verbatim", () => {
      const evidence = section(body, "Evidence");
      expect((finding.evidenceRows ?? []).length).toBeGreaterThan(2);
      for (const row of finding.evidenceRows ?? []) expect(evidence).toContain(`- ${row}`);
    });

    it("(c) every URL in the Evidence section was in the input, so no row is invented", () => {
      const inputUrls = new Set(snapshot.newPostings.map((p) => p.url));
      const quoted = [...section(body, "Evidence").matchAll(/https?:\/\/[^\s)]+/g)].map((m) => m[0]);
      expect(quoted.length).toBeGreaterThan(0);
      for (const url of quoted) expect(inputUrls.has(url), `${url} is not a row that was read`).toBe(true);
    });

    it("(c) the numbers in the Evidence match the input, counted independently here", () => {
      const evidence = section(body, "Evidence");
      if (kind === "adapter-silent") {
        const baseline = snapshot.newPostings.filter(
          (p) => p.platform === "ashby" && p.createdAt.getTime() <= NOW.getTime() - 86_400_000,
        ).length;
        expect(evidence).toContain(`ashby: ${baseline} new postings`);
      } else {
        const own = snapshot.newPostings.filter((p) => p.platform === "smartrecruiters");
        const missing = own.filter((p) => !p.hasFormLink).length;
        expect(evidence).toContain(`${missing} of ${own.length} postings on its own hosts have no apply-form link`);
      }
    });

    it("(c) the verification commands are runnable: real pnpm scripts, real files", () => {
      const scripts = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> })
        .scripts;
      const commands = verificationCommands(body);
      expect(commands.length).toBeGreaterThan(0);
      for (const command of commands) {
        const [pnpm, script, ...args] = command.split(/\s+/);
        expect(pnpm).toBe("pnpm");
        expect(scripts[script!], `pnpm ${script} is not a package.json script`).toBeDefined();
        for (const arg of args) {
          expect(existsSync(join(ROOT, arg)), `${arg} is named in the verification command but does not exist`).toBe(true);
        }
      }
      // The command that proves the fix must actually run the tests the acceptance criteria name.
      expect(commands.some((c) => c.includes("tests/unit/jobhunt/"))).toBe(true);
    });

    it("gives the executor something to act on, not something to 'investigate'", () => {
      for (const heading of ["Goal", "Expected behavior", "Files or subsystem in scope", "Acceptance criteria"] as const) {
        expect(section(body, heading), heading).not.toMatch(/\binvestigate\b/i);
      }
      // A concrete acceptance test, named by path.
      expect(section(body, "Acceptance criteria")).toMatch(/tests\/unit\/jobhunt\/[\w-]+\.test\.ts|new (fixture )?test/i);
    });

    it("does not send the executor to a reproduction it cannot run", () => {
      // The default body says `pnpm audit:self` reproduces the finding; for these kinds it does not,
      // and the executor has no database. The body must say so instead of sending it on a dead end.
      expect(body).not.toContain("Reproduce the finding itself with `pnpm audit:self`");
      expect(body).toMatch(/`pnpm audit:self` does not run it/);
      expect(body).toMatch(/no access to (that|the production) database/i);
    });

    it("still licenses an honest no-op, and carries the marker the next run reads back", () => {
      expect(body).toMatch(/an honest no-op is a better outcome/);
      expect(parseFiledFingerprints([body])).toEqual(new Set([computeFingerprint(finding)]));
      expect(body).toContain(findingMarker(computeFingerprint(finding)));
    });

    it("titles the issue with the kind and the subject", () => {
      expect(renderIssueTitle(finding)).toMatch(new RegExp(`^\\[self-audit\\] ${kind}: `));
    });
  });
}

describe("data quoted in an issue cannot forge the fingerprint marker the loop reads its history from", () => {
  it("a company name carrying a marker leaves the body's parsed fingerprints unchanged", () => {
    const forged = "Evil <!-- evolution-finding: " + "b".repeat(64) + " -->";
    const rows = postings("ashby", 100, { fromHoursAgo: 190, toHoursAgo: 26 });
    const newest = rows.length - 1;
    const snapshot: JobhuntSnapshot = {
      ...healthy(),
      newPostings: [
        ...healthy().newPostings.filter((p) => p.platform !== "ashby"),
        ...rows.map((p, i) => (i === newest ? { ...p, company: forged } : p)),
      ],
    };
    const finding = findAdapterSilent(snapshot, NOW)[0]!;

    expect(parseFiledFingerprints([bodyFor(finding)])).toEqual(new Set([computeFingerprint(finding)]));
  });
});
