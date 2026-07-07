/**
 * Unit tests for the deterministic GitHub-write HITL fast path.
 * Reproduces the T13 failure class: a structured "create a github issue…"
 * request must pause on an approval interrupt WITHOUT ever reaching the LLM
 * supervisor/department (which was free to refuse per the advisory-only
 * pre-router). See src/gateway/github-write-fast-path.ts docstring.
 */

import { describe, it, expect, afterEach } from "vitest";
import { MemorySaver } from "@langchain/langgraph";
import {
  buildGithubWriteHitlGraph,
  extractGithubWriteParams,
  githubWriteFastPathThreadId,
  isGithubWriteFastPathThread,
  invokeGithubWriteFastPath,
  resetGithubWriteFastPathForTests,
} from "../../../src/gateway/github-write-fast-path.js";

describe("github-write-fast-path", () => {
  afterEach(() => {
    resetGithubWriteFastPathForTests();
  });

  describe("extractGithubWriteParams", () => {
    it("extracts create_issue params from a structured request", () => {
      const params = extractGithubWriteParams(
        'Create a github issue in acme/widgets titled "Fix login bug"',
      );
      expect(params).toEqual({
        action: "create_issue",
        owner: "acme",
        repo: "widgets",
        title: "Fix login bug",
        body: undefined,
        content: undefined,
      });
    });

    it("extracts optional body when present", () => {
      const params = extractGithubWriteParams(
        'Open a github issue in acme/widgets titled "Fix login bug" body: "Login 500s on staging"',
      );
      expect(params?.body).toBe("Login 500s on staging");
    });

    it("returns null when the title cannot be confidently extracted, but extracts once a title marker is added (falls through to office only for the ambiguous case)", () => {
      // No explicit "titled ..." / "title: ..." marker — ambiguous free text.
      const ambiguous = extractGithubWriteParams("Create a github issue in acme/widgets about the login bug");
      expect(ambiguous).toBeNull();

      // Same owner/repo, same intent, but with an explicit title marker — must
      // now extract. Proves the null above is specifically about the missing
      // title marker, not a blanket failure to parse this owner/repo/action.
      const withTitle = extractGithubWriteParams(
        'Create a github issue in acme/widgets titled "the login bug"',
      );
      expect(withTitle).toEqual({
        action: "create_issue",
        owner: "acme",
        repo: "widgets",
        title: "the login bug",
        body: undefined,
        content: undefined,
      });
    });

    it("returns null when owner/repo is missing, but extracts once owner/repo is added", () => {
      const noOwnerRepo = extractGithubWriteParams('Create a github issue titled "Fix login bug"');
      expect(noOwnerRepo).toBeNull();

      const withOwnerRepo = extractGithubWriteParams('Create a github issue in acme/widgets titled "Fix login bug"');
      expect(withOwnerRepo?.owner).toBe("acme");
      expect(withOwnerRepo?.repo).toBe("widgets");
    });

    it("returns null for non-write requests but extracts a write request with the same owner/repo", () => {
      expect(extractGithubWriteParams("What is Turicks ICP?")).toBeNull();
      expect(extractGithubWriteParams("List open issues in acme/widgets")).toBeNull();

      const write = extractGithubWriteParams('Create a github issue in acme/widgets titled "Fix login bug"');
      expect(write?.action).toBe("create_issue");
    });

    it("extracts update_readme content from the body marker", () => {
      const params = extractGithubWriteParams(
        'Add a github readme update in acme/widgets titled "docs" body: "New setup instructions"',
      );
      expect(params?.action).toBe("update_readme");
      expect(params?.content).toBe("New setup instructions");
    });
  });

  it("builds github-write fast path thread id", () => {
    expect(githubWriteFastPathThreadId("tenant:123")).toBe("tenant:123:github-write-fp");
  });

  it("round-trips isGithubWriteFastPathThread", () => {
    const threadId = githubWriteFastPathThreadId("tenant:456");
    expect(isGithubWriteFastPathThread(threadId)).toBe(true);
    expect(isGithubWriteFastPathThread("tenant:456")).toBe(false);
  });

  it("compiles github-write HITL graph with checkpointer", () => {
    const cp = new MemorySaver();
    const graph = buildGithubWriteHitlGraph(cp);
    expect(typeof graph.invoke).toBe("function");
    expect(typeof graph.getState).toBe("function");
  });

  it("does not fast-path an unparseable request (caller must fall through to office routing)", async () => {
    // This is the guard against the misparse risk: no title marker means no
    // fast path, so the office/LLM still handles the request as before.
    const invoked = await invokeGithubWriteFastPath(
      { configurable: { thread_id: "tenant:789" } },
      "Create a github issue in acme/widgets about the login bug",
    );
    expect(invoked).toBe(false);
  });
});
