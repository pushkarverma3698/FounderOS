/**
 * Unit tests — where a brief's paths are looked up (src/tools/dispatch-brief-check.ts).
 * =====================================================================================
 * FounderOS paths are read from the checkout the process runs from. Every other repo is asked
 * on GitHub's default branch. The properties that matter here are the ones that protect the
 * loop from its own infrastructure: a definite 404 rejects, anything else warns, a GitHub
 * token that cannot see the repo never turns every path into "missing", a big brief cannot
 * burn the rate limit, and the same brief is not looked up three times per dispatch.
 *
 * No network: the GitHub client is a fake, and tests/setup.ts would throw on a real fetch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BRIEF_CHECK_MEMO_MAX_ENTRIES,
  BRIEF_CHECK_MEMO_TTL_MS,
  GITHUB_PATH_LOOKUP_TIMEOUT_MS,
  checkDispatchBrief,
  checkoutFileExists,
  githubFileExists,
  resetBriefCheckMemo,
  type ContentsClient,
} from "../../../src/tools/dispatch-brief-check.js";
import { MAX_BRIEF_PATH_CHECKS } from "../../../src/tools/agent-brief-lint.js";
import { repoRoot } from "../../../src/evolution/repo-root.js";
import { filledBrief } from "../../helpers/agent-brief.js";

const SCOPE = "Files or subsystem in scope";
const FOUNDEROS = { owner: "pushkarverma3698", repo: "FounderOS" };
const OPLIFY = { owner: "OplifyMessage", repo: "oplify-messaging-api" };

type Reply = "found" | number | Error;

/** A GitHub client whose answers are decided per path; `repos.get` decides repository visibility. */
function fakeGitHub(answer: (path: string) => Reply = () => "found", repoAnswer: Reply = "found") {
  const respond = (reply: Reply) => {
    if (reply === "found") return Promise.resolve({ data: {} });
    if (typeof reply === "number") {
      return Promise.reject(Object.assign(new Error(`HTTP ${reply}`), { status: reply }));
    }
    return Promise.reject(reply);
  };
  const getContent = vi.fn((params: { path: string }) => respond(answer(params.path)));
  const get = vi.fn(() => respond(repoAnswer));
  const client: ContentsClient = { rest: { repos: { getContent, get } } };
  return { client, getContent, get };
}

let tmp: string;
beforeEach(() => {
  resetBriefCheckMemo();
  tmp = mkdtempSync(join(tmpdir(), "brief-check-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("checkoutFileExists", () => {
  it("answers for files and directories inside the checkout", () => {
    mkdirSync(join(tmp, "repo", "src", "dir"), { recursive: true });
    writeFileSync(join(tmp, "repo", "src", "a.ts"), "");
    const exists = checkoutFileExists(join(tmp, "repo"));

    expect(exists("src/a.ts")).toBe(true);
    expect(exists("src/dir")).toBe(true);
    expect(exists("src/missing.ts")).toBe(false);
  });

  it("never answers for a path outside the checkout", () => {
    mkdirSync(join(tmp, "repo"), { recursive: true });
    writeFileSync(join(tmp, "secret.txt"), "");
    const exists = checkoutFileExists(join(tmp, "repo"));

    expect(exists("../secret.txt")).toBe(false);
    expect(exists("src/../../secret.txt")).toBe(false);
  });

  it("reads the real checkout: the dispatch tool exists, and the path issue #762 named does not", () => {
    const exists = checkoutFileExists(repoRoot());

    expect(exists("src/tools/dispatch-antigravity.ts")).toBe(true);
    expect(exists("src/tools")).toBe(true);
    // #762 briefed this file; the dispatcher is src/kernel/supervisor.ts and the v2 name is a tombstone.
    expect(exists("src/agents/supervisor.ts")).toBe(false);
  });
});

describe("githubFileExists", () => {
  it("is true when GitHub returns the content, for a file or a directory alike", async () => {
    const { client } = fakeGitHub();
    expect(await githubFileExists(client, "o", "r")("src/a.ts")).toBe(true);
  });

  it("asks for the default branch, once, without retries, with a timeout", async () => {
    const { client, getContent } = fakeGitHub();
    await githubFileExists(client, "o", "r")("src/a.ts");

    expect(getContent).toHaveBeenCalledTimes(1);
    const params = getContent.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(params).toMatchObject({ owner: "o", repo: "r", path: "src/a.ts" });
    expect(params).not.toHaveProperty("ref");
    const request = params["request"] as { retries: number; signal: AbortSignal };
    // The octokit retry plugin would otherwise sleep 1s + 4s + 9s on every 5xx.
    expect(request.retries).toBe(0);
    expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(GITHUB_PATH_LOOKUP_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });

  it("is false on a definite 404 when the repository itself is visible", async () => {
    const { client } = fakeGitHub(() => 404);
    expect(await githubFileExists(client, "o", "r")("src/gone.ts")).toBe(false);
  });

  it("cannot say when the repository itself is a 404: the token cannot see it, so no path is 'missing'", async () => {
    // GitHub answers 404, not 403, for a private repo the token cannot read. Without this, every
    // path of every brief for that repo would be "missing" and no dispatch could ever get through.
    const { client, get } = fakeGitHub(() => 404, 404);
    const exists = githubFileExists(client, "o", "r");

    await expect(exists("src/a.ts")).rejects.toThrow(/cannot see o\/r/);
    await expect(exists("src/b.ts")).rejects.toThrow(/cannot see o\/r/);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("rethrows a 5xx, a 403 and a network error unchanged, so the lint reports a warning", async () => {
    for (const reply of [503, 403, new Error("fetch failed")] as const) {
      const { client } = fakeGitHub(() => reply);
      await expect(githubFileExists(client, "o", "r")("src/a.ts")).rejects.toThrow(
        typeof reply === "number" ? `HTTP ${reply}` : "fetch failed",
      );
    }
  });
});

describe("checkDispatchBrief: which source answers", () => {
  const body = filledBrief({ [SCOPE]: "src/a.ts, src/gone.ts" });

  it("reads FounderOS paths from the checkout and never builds a GitHub client", async () => {
    mkdirSync(join(tmp, "src"), { recursive: true });
    writeFileSync(join(tmp, "src", "a.ts"), "");
    const getClient = vi.fn();

    const result = await checkDispatchBrief({ ...FOUNDEROS, body }, { getClient, checkoutRoot: () => tmp });

    expect(result.missingPaths).toEqual(["src/gone.ts"]);
    expect(getClient).not.toHaveBeenCalled();
  });

  it("recognises FounderOS whatever the case of the slug", async () => {
    const getClient = vi.fn();
    await checkDispatchBrief({ owner: "PushkarVerma3698", repo: "founderos", body }, { getClient, checkoutRoot: () => tmp });

    expect(getClient).not.toHaveBeenCalled();
  });

  it("falls back to GitHub for FounderOS when the process cannot find its own checkout", async () => {
    const { client, getContent } = fakeGitHub();
    await checkDispatchBrief({ ...FOUNDEROS, body }, { getClient: () => client, checkoutRoot: () => null });

    expect(getContent).toHaveBeenCalledTimes(2);
  });

  it("asks GitHub about any other repo", async () => {
    const { client, getContent } = fakeGitHub((path) => (path === "src/gone.ts" ? 404 : "found"));
    const result = await checkDispatchBrief({ ...OPLIFY, body }, { getClient: () => client, checkoutRoot: () => tmp });

    expect(getContent.mock.calls.map((c) => (c[0] as { owner: string; repo: string; path: string }))).toEqual([
      expect.objectContaining({ ...OPLIFY, path: "src/a.ts" }),
      expect.objectContaining({ ...OPLIFY, path: "src/gone.ts" }),
    ]);
    expect(result.missingPaths).toEqual(["src/gone.ts"]);
  });
});

describe("checkDispatchBrief: the loop never blocks on its own infrastructure", () => {
  const body = filledBrief({ [SCOPE]: "src/ok.ts, src/gone.ts, src/flaky.ts" });

  it("rejects on a definite 404 and only warns about the 503 in the same brief", async () => {
    const { client } = fakeGitHub((path) => (path === "src/gone.ts" ? 404 : path === "src/flaky.ts" ? 503 : "found"));
    const result = await checkDispatchBrief({ ...OPLIFY, body }, { getClient: () => client });

    expect(result.ok).toBe(false);
    expect(result.missingPaths).toEqual(["src/gone.ts"]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("src/flaky.ts");
  });

  it("accepts the brief, with a warning, when GitHub is down for every lookup", async () => {
    const { client } = fakeGitHub(() => 503);
    const result = await checkDispatchBrief({ ...OPLIFY, body }, { getClient: () => client });

    expect(result.ok).toBe(true);
    expect(result.warnings[0]).toContain("Could not verify 3 of 3 paths");
    expect(result.warnings[0]).toContain("HTTP 503");
  });

  it("accepts the brief, with a warning that names the cause, when there is no GitHub token", async () => {
    const result = await checkDispatchBrief(
      { ...OPLIFY, body },
      {
        getClient: () => {
          throw new Error("GITHUB_TOKEN not configured — set it in .env");
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(result.warnings[0]).toContain("GITHUB_TOKEN not configured");
  });

  it("does not turn 'the token cannot see this repo' into a rejection of every path", async () => {
    const { client } = fakeGitHub(() => 404, 404);
    const result = await checkDispatchBrief({ ...OPLIFY, body }, { getClient: () => client });

    expect(result.ok).toBe(true);
    expect(result.missingPaths).toEqual([]);
    expect(result.warnings[0]).toContain("cannot see OplifyMessage/oplify-messaging-api");
  });

  it("makes at most MAX_BRIEF_PATH_CHECKS lookups for a huge brief", async () => {
    const paths = Array.from({ length: 60 }, (_, i) => `src/gen/f${i}.ts`);
    const { client, getContent } = fakeGitHub();
    const result = await checkDispatchBrief(
      { ...OPLIFY, body: filledBrief({ [SCOPE]: paths.join(", ") }) },
      { getClient: () => client },
    );

    expect(getContent).toHaveBeenCalledTimes(MAX_BRIEF_PATH_CHECKS);
    expect(result.ok).toBe(true);
    expect(result.warnings[0]).toContain("first 30 of 60");
  });
});

describe("checkDispatchBrief: one set of lookups per dispatch", () => {
  const body = filledBrief({ [SCOPE]: "src/a.ts, src/b.ts" });

  it("reuses a passing verdict for the same repo and body: the HITL replay and execute() share it", async () => {
    // hitlGate re-runs the tool from the top on resume, and execute() lints again as defence in
    // depth. Without the memo that is three sets of GitHub lookups for one dispatch.
    const { client, getContent } = fakeGitHub();
    const deps = { getClient: () => client };

    const first = await checkDispatchBrief({ ...OPLIFY, body }, deps);
    const replay = await checkDispatchBrief({ ...OPLIFY, body }, deps);
    const inExecute = await checkDispatchBrief({ ...OPLIFY, body }, deps);

    expect(getContent).toHaveBeenCalledTimes(2);
    expect(replay).toBe(first);
    expect(inExecute).toBe(first);
  });

  it("keys the memo on the repo, ignoring case, and on the exact body", async () => {
    const { client, getContent } = fakeGitHub();
    const deps = { getClient: () => client };

    await checkDispatchBrief({ ...OPLIFY, body }, deps);
    await checkDispatchBrief({ owner: "OPLIFYMESSAGE", repo: "OPLIFY-MESSAGING-API", body }, deps);
    expect(getContent).toHaveBeenCalledTimes(2);

    await checkDispatchBrief({ ...OPLIFY, body: `${body}\nOne more line.` }, deps);
    expect(getContent).toHaveBeenCalledTimes(4);

    await checkDispatchBrief({ owner: "OplifyMessage", repo: "oplify-messaging-app", body }, deps);
    expect(getContent).toHaveBeenCalledTimes(6);
  });

  it("does not memoize a failing verdict, so a path created since is seen on the next attempt", async () => {
    let created = false;
    const { client, getContent } = fakeGitHub((path) => (path === "src/b.ts" && !created ? 404 : "found"));
    const deps = { getClient: () => client };

    expect((await checkDispatchBrief({ ...OPLIFY, body }, deps)).ok).toBe(false);
    created = true;
    expect((await checkDispatchBrief({ ...OPLIFY, body }, deps)).ok).toBe(true);
    expect(getContent).toHaveBeenCalledTimes(4);
  });

  it("forgets a verdict after BRIEF_CHECK_MEMO_TTL_MS", async () => {
    const { client, getContent } = fakeGitHub();
    let now = 1_000_000;
    const deps = { getClient: () => client, now: () => now };

    await checkDispatchBrief({ ...OPLIFY, body }, deps);
    now += BRIEF_CHECK_MEMO_TTL_MS - 1;
    await checkDispatchBrief({ ...OPLIFY, body }, deps);
    expect(getContent).toHaveBeenCalledTimes(2);

    now += 2;
    await checkDispatchBrief({ ...OPLIFY, body }, deps);
    expect(getContent).toHaveBeenCalledTimes(4);
  });

  it("stays bounded: the oldest verdict is evicted once BRIEF_CHECK_MEMO_MAX_ENTRIES is exceeded", async () => {
    const { client, getContent } = fakeGitHub();
    const deps = { getClient: () => client };
    const bodyN = (n: number) => filledBrief({ [SCOPE]: `src/n${n}.ts` });

    for (let n = 0; n <= BRIEF_CHECK_MEMO_MAX_ENTRIES; n++) await checkDispatchBrief({ ...OPLIFY, body: bodyN(n) }, deps);
    const calls = getContent.mock.calls.length;

    await checkDispatchBrief({ ...OPLIFY, body: bodyN(BRIEF_CHECK_MEMO_MAX_ENTRIES) }, deps);
    expect(getContent.mock.calls.length).toBe(calls);

    await checkDispatchBrief({ ...OPLIFY, body: bodyN(0) }, deps);
    expect(getContent.mock.calls.length).toBe(calls + 1);
  });
});
