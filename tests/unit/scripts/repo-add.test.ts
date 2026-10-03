/**
 * `pnpm repo:add <owner/repo>` — one command instead of three hand edits and a checklist.
 * =======================================================================================
 * A repo is registered in three places that used to be edited by hand, and one of them
 * (`DEFAULT_REPOS`) silently stranded issues for a whole day when it was forgotten:
 *   src/tools/dispatch-repos.ts              DISPATCH_REPO_ALLOWLIST  what /task accepts
 *   deploy/agent-dispatch                    DEFAULT_REPOS            what the daemon sweeps
 *   tests/unit/tools/dispatch-repos.test.ts  PROVISIONED_REPOS        the reviewed pin
 * These tests run against a temp copy of the REAL files (so a reformat of any of them breaks
 * the script's parsers here, in CI, not on the day someone needs a new repo) and never touch
 * the checkout itself: the script takes a repo-root argument for exactly this.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REPO_ADD_TARGETS,
  RepoAddError,
  applyRepoAdd,
  onboardCommand,
  planRepoAdd,
  validateRepoSlug,
} from "../../../scripts/repo-add.js";

const REAL_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FILES = Object.values(REPO_ADD_TARGETS);
const NEW_REPO = "acme/widget-server";

let root: string;

const read = (rel: string): string => readFileSync(join(root, rel), "utf8");
const sha = (rel: string): string => createHash("sha256").update(readFileSync(join(root, rel))).digest("hex");
const snapshot = (): Record<string, string> => Object.fromEntries(FILES.map((rel) => [rel, sha(rel)]));

/** The real slugs inside `DISPATCH_REPO_ALLOWLIST = [ … ]`, `PROVISIONED_REPOS = [ … ]`, `DEFAULT_REPOS=( … )`. */
function listsIn(rel: string): string[] {
  const text = read(rel);
  if (rel === REPO_ADD_TARGETS.daemon) {
    const inner = /^DEFAULT_REPOS=\((.*)\)$/m.exec(text)?.[1] ?? "";
    return [...inner.matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
  }
  const opener = rel === REPO_ADD_TARGETS.allowlist ? "export const DISPATCH_REPO_ALLOWLIST = [" : "const PROVISIONED_REPOS = [";
  const body = text.slice(text.indexOf(opener) + opener.length, text.indexOf("] as const;", text.indexOf(opener)));
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "repo-add-"));
  for (const rel of FILES) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    copyFileSync(join(REAL_ROOT, rel), join(root, rel));
  }
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("validateRepoSlug: strict owner/repo, nothing that could reach a shell, a regex or a quote", () => {
  it.each([
    "acme/widget-server",
    "OplifyMessage/oplify-messaging-app",
    "pushkarverma3698/House-of-Hulda-Website-frontend",
    "a/b",
    "x/.github",
    "x/a.b_c-d",
    `${"o".repeat(39)}/r`,
    `o/${"r".repeat(100)}`,
  ])("accepts %s", (slug) => {
    expect(validateRepoSlug(slug)).toEqual({ ok: true, slug });
  });

  it.each([
    ["", "empty"],
    ["widget", "no owner"],
    ["a/b/c", "three parts"],
    ["/repo", "empty owner"],
    ["owner/", "empty repo"],
    ["https://github.com/acme/widget", "a URL"],
    ["github.com/acme/widget", "a host path"],
    ["acme/widget.git", "a .git suffix"],
    ["acme/widget/", "a trailing slash"],
    ["acme/wid get", "a space"],
    [" acme/widget", "a leading space"],
    ["acme/widget\n", "a newline"],
    ["acme/widget;rm -rf /", "a shell separator"],
    ["acme/$(id)", "command substitution"],
    ["acme/`id`", "backticks"],
    ["acme/wid'get", "a single quote"],
    ['acme/wid"get', "a double quote"],
    ["acme/wid\\get", "a backslash"],
    ["acme/a|b", "a pipe"],
    ["acme/a&b", "an ampersand"],
    ["acme/(a)", "parentheses"],
    ["acme/a*", "a glob"],
    ["acme/a?", "a wildcard"],
    ["acme/[a-z]+", "a regex class"],
    ["acme/.*", "a regex wildcard"],
    ["ac.me/widget", "a dot in the owner"],
    ["ac_me/widget", "an underscore in the owner"],
    ["-acme/widget", "an owner starting with a hyphen"],
    ["acme-/widget", "an owner ending with a hyphen"],
    [`${"o".repeat(40)}/r`, "an owner over 39 characters"],
    [`o/${"r".repeat(101)}`, "a repo over 100 characters"],
    ["acme/.", "a repo that is a dot"],
    ["acme/..", "a repo that is two dots"],
    ["../widget", "traversal"],
    ["@scope/pkg", "an npm scope"],
    ["acme/wídget", "a non-ASCII character"],
  ])("rejects %j (%s), and says why", (slug) => {
    const verdict = validateRepoSlug(slug);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? "" : verdict.reason).toMatch(/owner\/repo|owner|repository name|characters|slash|\.git/i);
  });

  it("tells the caller the bare form when given a URL or a .git suffix", () => {
    const url = validateRepoSlug("https://github.com/acme/widget.git");
    expect(url.ok ? "" : url.reason).toContain("acme/widget");
  });
});

describe("planRepoAdd + applyRepoAdd", () => {
  it("adds the repo to all three files, each with the same one-line insertion and nothing else changed", () => {
    const before = Object.fromEntries(FILES.map((rel) => [rel, read(rel)]));
    const lengthBefore = Object.fromEntries(FILES.map((rel) => [rel, listsIn(rel).length]));
    const plan = planRepoAdd(root, NEW_REPO);
    applyRepoAdd(root, plan);

    expect(plan.changed).toBe(true);
    expect(plan.edits.map((e) => [e.file, e.status])).toEqual([
      [REPO_ADD_TARGETS.daemon, "added"],
      [REPO_ADD_TARGETS.allowlist, "added"],
      [REPO_ADD_TARGETS.fixture, "added"],
    ]);
    for (const rel of FILES) {
      const list = listsIn(rel);
      expect(list.at(-1)).toBe(NEW_REPO);
      expect(list).toHaveLength((lengthBefore[rel] ?? 0) + 1);
    }
    // Removing the inserted text gives back the original bytes: nothing else moved or reformatted.
    expect(read(REPO_ADD_TARGETS.daemon).replace(` "${NEW_REPO}")`, ")")).toBe(before[REPO_ADD_TARGETS.daemon]);
    for (const rel of [REPO_ADD_TARGETS.allowlist, REPO_ADD_TARGETS.fixture]) {
      expect(read(rel).replace(`  "${NEW_REPO}",\n`, "")).toBe(before[rel]);
    }
  });

  it("keeps DEFAULT_REPOS on ONE line, in the format the serviceability test and the daemon read", () => {
    applyRepoAdd(root, planRepoAdd(root, NEW_REPO));
    const daemon = read(REPO_ADD_TARGETS.daemon);

    expect(daemon.match(/^DEFAULT_REPOS=\(.*\)$/gm)).toHaveLength(1);
    expect(daemon).toMatch(/^DEFAULT_REPOS=\(("[^"]+" )+"acme\/widget-server"\)$/m);
  });

  it("preserves the executable bit on deploy/agent-dispatch", () => {
    expect(statSync(join(root, REPO_ADD_TARGETS.daemon)).mode & 0o111).not.toBe(0);
    applyRepoAdd(root, planRepoAdd(root, NEW_REPO));
    expect(statSync(join(root, REPO_ADD_TARGETS.daemon)).mode & 0o777).toBe(
      statSync(join(REAL_ROOT, REPO_ADD_TARGETS.daemon)).mode & 0o777,
    );
  });

  it("leaves no temp files behind", () => {
    applyRepoAdd(root, planRepoAdd(root, NEW_REPO));
    for (const rel of FILES) {
      expect(readdirSync(dirname(join(root, rel))).filter((name) => name.includes(".tmp"))).toEqual([]);
    }
  });

  it("is idempotent: a second run changes nothing, byte for byte, and says so", () => {
    applyRepoAdd(root, planRepoAdd(root, NEW_REPO));
    const afterFirst = snapshot();

    const second = planRepoAdd(root, NEW_REPO);
    applyRepoAdd(root, second);

    expect(second.changed).toBe(false);
    expect(second.edits.map((e) => e.status)).toEqual(["present", "present", "present"]);
    expect(snapshot()).toEqual(afterFirst);
  });

  it("treats a slug that differs only by case as already registered, and names the entry as written", () => {
    const before = snapshot();
    const plan = planRepoAdd(root, "oplifymessage/OPLIFY-MESSAGING-API");
    applyRepoAdd(root, plan);

    expect(plan.changed).toBe(false);
    expect(plan.canonical).toBe("OplifyMessage/oplify-messaging-api");
    expect(snapshot()).toEqual(before);
  });

  it("heals a half-applied state: only the files that lack the repo are edited", () => {
    applyRepoAdd(root, planRepoAdd(root, NEW_REPO));
    // Simulate a crash after the daemon list was written but before the other two were.
    for (const rel of [REPO_ADD_TARGETS.allowlist, REPO_ADD_TARGETS.fixture]) {
      copyFileSync(join(REAL_ROOT, rel), join(root, rel));
    }
    const daemonBefore = sha(REPO_ADD_TARGETS.daemon);

    const plan = planRepoAdd(root, NEW_REPO);
    applyRepoAdd(root, plan);

    expect(plan.edits.map((e) => [e.file, e.status])).toEqual([
      [REPO_ADD_TARGETS.daemon, "present"],
      [REPO_ADD_TARGETS.allowlist, "added"],
      [REPO_ADD_TARGETS.fixture, "added"],
    ]);
    expect(sha(REPO_ADD_TARGETS.daemon)).toBe(daemonBefore);
    for (const rel of FILES) expect(listsIn(rel).at(-1)).toBe(NEW_REPO);
  });

  it("parses the current shape of the real files (through the temp copy), so a reformat fails here and not on repo-add day", () => {
    // `root` holds byte-for-byte copies of the real files (see beforeEach). Planning against it,
    // and never against REAL_ROOT itself, keeps every test away from the real files.
    const before = snapshot();
    const plan = planRepoAdd(root, "acme/never-written");

    expect(plan.edits.map((e) => e.status)).toEqual(["added", "added", "added"]);
    expect(snapshot()).toEqual(before);
    for (const rel of FILES) {
      expect(sha(rel)).toBe(createHash("sha256").update(readFileSync(join(REAL_ROOT, rel))).digest("hex"));
    }
  });

  it("writes NOTHING when any one file cannot be edited safely (all-or-nothing)", () => {
    const before = snapshot();
    // The daemon list reformatted over several lines: not the format the daemon test reads.
    writeFileSync(
      join(root, REPO_ADD_TARGETS.daemon),
      read(REPO_ADD_TARGETS.daemon).replace(/^DEFAULT_REPOS=\((.*)\)$/m, 'DEFAULT_REPOS=(\n  $1\n)'),
    );
    const damaged = snapshot();

    expect(() => planRepoAdd(root, NEW_REPO)).toThrow(RepoAddError);
    expect(() => planRepoAdd(root, NEW_REPO)).toThrow(/deploy\/agent-dispatch/);
    expect(() => planRepoAdd(root, NEW_REPO)).toThrow(/DEFAULT_REPOS/);
    expect(snapshot()).toEqual(damaged);
    expect(damaged[REPO_ADD_TARGETS.allowlist]).toBe(before[REPO_ADD_TARGETS.allowlist]);
  });

  it("writes nothing even when the file it cannot edit is the LAST one, after two that it could", () => {
    // Guards the order of work: every file is parsed before the first byte is written.
    writeFileSync(
      join(root, REPO_ADD_TARGETS.fixture),
      read(REPO_ADD_TARGETS.fixture).replace("const PROVISIONED_REPOS = [", "const PINNED_REPOS = ["),
    );
    const before = snapshot();

    expect(() => planRepoAdd(root, NEW_REPO)).toThrow(/tests\/unit\/tools\/dispatch-repos\.test\.ts/);
    // The CLI-level path: run the whole command, not just the planner.
    const result = spawnSync(process.execPath, ["--import", "tsx/esm", join(REAL_ROOT, "scripts/repo-add.ts"), NEW_REPO, "--root", root], {
      cwd: REAL_ROOT,
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(result.status).toBe(1);
    expect(snapshot()).toEqual(before);
  });

  it("refuses an allowlist whose shape it cannot edit rather than guessing", () => {
    writeFileSync(
      join(root, REPO_ADD_TARGETS.allowlist),
      read(REPO_ADD_TARGETS.allowlist).replace('  "pushkarverma3698/FounderOS",\n', "  ...OTHER_REPOS,\n"),
    );
    const before = snapshot();

    expect(() => planRepoAdd(root, NEW_REPO)).toThrow(/DISPATCH_REPO_ALLOWLIST/);
    expect(snapshot()).toEqual(before);
  });

  it("names the missing file when the root is not a FounderOS checkout", () => {
    const empty = mkdtempSync(join(tmpdir(), "repo-add-empty-"));
    try {
      expect(() => planRepoAdd(empty, NEW_REPO)).toThrow(/src\/tools\/dispatch-repos\.ts/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("rejects an invalid slug before reading or writing anything", () => {
    const before = snapshot();
    expect(() => planRepoAdd(root, "acme/widget;rm -rf /")).toThrow(RepoAddError);
    expect(snapshot()).toEqual(before);
  });
});

describe("onboardCommand", () => {
  it("is the exact line the founder pastes", () => {
    expect(onboardCommand("acme/widget-server")).toBe("ssh founderos-vps '~/bin/onboard-repo.sh acme/widget-server'");
  });
});

describe("the CLI (spawned for real, always against a temp root)", () => {
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx/esm", join(REAL_ROOT, "scripts/repo-add.ts"), ...args], {
      cwd: REAL_ROOT,
      encoding: "utf8",
      timeout: 60_000,
    });

  it("edits the three files, prints what changed and the exact VPS command, and exits 0", () => {
    const result = run(NEW_REPO, "--root", root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("changed  deploy/agent-dispatch");
    expect(result.stdout).toContain("changed  src/tools/dispatch-repos.ts");
    expect(result.stdout).toContain("changed  tests/unit/tools/dispatch-repos.test.ts");
    expect(result.stdout).toContain("ssh founderos-vps '~/bin/onboard-repo.sh acme/widget-server'");
    for (const rel of FILES) expect(listsIn(rel).at(-1)).toBe(NEW_REPO);
  });

  it("run twice: the second run says nothing changed, still prints the VPS command, and exits 0", () => {
    run(NEW_REPO, "--root", root);
    const afterFirst = snapshot();
    const second = run(NEW_REPO, "--root", root);

    expect(second.status).toBe(0);
    expect(second.stdout).toContain("Nothing changed");
    expect(second.stdout).toContain("ssh founderos-vps '~/bin/onboard-repo.sh acme/widget-server'");
    expect(snapshot()).toEqual(afterFirst);
  });

  it("--dry-run reports what it would change and writes nothing", () => {
    const before = snapshot();
    const result = run(NEW_REPO, "--root", root, "--dry-run");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("would change  deploy/agent-dispatch");
    expect(snapshot()).toEqual(before);
  });

  it("an invalid slug exits 2 with the reason on stderr and touches nothing", () => {
    const before = snapshot();
    const result = run("acme/widget;rm -rf /", "--root", root);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("owner/repo");
    expect(snapshot()).toEqual(before);
  });

  it("a missing slug exits 2 with the usage line", () => {
    const result = run("--root", root);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("pnpm repo:add <owner/repo>");
  });

  it("a file it cannot edit safely exits 1, names the file, and writes nothing", () => {
    writeFileSync(join(root, REPO_ADD_TARGETS.daemon), "#!/usr/bin/env bash\nDEFAULT_REPOS=()\nDEFAULT_REPOS=()\n");
    const before = snapshot();
    const result = run(NEW_REPO, "--root", root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("deploy/agent-dispatch");
    expect(snapshot()).toEqual(before);
  });
});
