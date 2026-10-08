/**
 * AG-039: /task refuses a repo the bot's GITHUB_TOKEN cannot reach.
 * The decision is a pure function over what GitHub answered; the probe maps one repos.get call onto it.
 */

import { describe, it, expect, vi } from "vitest";
import { checkRepoReach, decideRepoReach, type RepoReachClient } from "../../../src/tools/repo-reach.js";

const SLUG = "OplifyMessage/oplify-messaging-api";

describe("decideRepoReach", () => {
  it.each([
    [404, "Not Found"],
    [403, "Resource not accessible by personal access token"],
    [401, "Bad credentials"],
  ])("refuses when GitHub answers %i, naming the repo, the status and GitHub's message", (status, message) => {
    const verdict = decideRepoReach(SLUG, { kind: "failed", status, message });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.message).toContain(SLUG);
    expect(verdict.message).toContain(String(status));
    expect(verdict.message).toContain(message);
    expect(verdict.message).toContain("the bot's GITHUB_TOKEN cannot reach this repo");
  });

  it("refuses a repo the token can only read", () => {
    const verdict = decideRepoReach(SLUG, { kind: "answered", permissions: { admin: false, maintain: false, push: false, pull: true } });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.message).toContain(SLUG);
    expect(verdict.message).toContain("200");
    expect(verdict.message).toContain("no push permission");
    expect(verdict.message).toContain("the bot's GITHUB_TOKEN cannot reach this repo");
  });

  it.each([
    ["push", { push: true }],
    ["admin", { admin: true, push: false }],
    ["maintain", { maintain: true, push: false }],
  ])("accepts a repo where the token has %s", (_name, permissions) => {
    expect(decideRepoReach(SLUG, { kind: "answered", permissions })).toEqual({ ok: true });
  });

  it("proceeds when GitHub sends no permissions block: it cannot say, so the brief lint and issues.create still speak", () => {
    expect(decideRepoReach(SLUG, { kind: "answered", permissions: undefined })).toEqual({ ok: true });
    expect(decideRepoReach(SLUG, { kind: "answered", permissions: null })).toEqual({ ok: true });
  });

  it.each([[500], [502], [503], [undefined]])("proceeds on status %s: an outage is not proof the repo is unreachable", (status) => {
    expect(decideRepoReach(SLUG, { kind: "failed", status, message: "boom" })).toEqual({ ok: true });
  });
});

describe("checkRepoReach", () => {
  const clientReturning = (get: ReturnType<typeof vi.fn>): RepoReachClient => ({ rest: { repos: { get } } });

  it("asks GitHub once, for exactly the repo", async () => {
    const get = vi.fn().mockResolvedValue({ data: { permissions: { push: true } } });
    await expect(checkRepoReach({ owner: "OplifyMessage", repo: "oplify-messaging-api" }, clientReturning(get))).resolves.toEqual({ ok: true });
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0]?.[0]).toMatchObject({ owner: "OplifyMessage", repo: "oplify-messaging-api" });
  });

  it("turns a thrown 404 into a refusal carrying GitHub's message", async () => {
    const get = vi.fn().mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));
    const verdict = await checkRepoReach({ owner: "OplifyMessage", repo: "oplify-messaging-api" }, clientReturning(get));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.message).toContain("404");
    expect(verdict.message).toContain("Not Found");
  });

  it("turns a thrown 403 into a refusal", async () => {
    const get = vi.fn().mockRejectedValue(Object.assign(new Error("Forbidden"), { status: 403 }));
    expect((await checkRepoReach({ owner: "a", repo: "b" }, clientReturning(get))).ok).toBe(false);
  });

  it("proceeds when the probe itself fails with no status (network)", async () => {
    const get = vi.fn().mockRejectedValue(new Error("socket hang up"));
    expect(await checkRepoReach({ owner: "a", repo: "b" }, clientReturning(get))).toEqual({ ok: true });
  });

  it("proceeds when the client answers nothing usable (a bare mock)", async () => {
    const get = vi.fn().mockResolvedValue(undefined);
    expect(await checkRepoReach({ owner: "a", repo: "b" }, clientReturning(get))).toEqual({ ok: true });
  });

  it("gives up on a probe that never answers rather than holding the /task", async () => {
    vi.useFakeTimers();
    try {
      const get = vi.fn().mockReturnValue(new Promise(() => undefined));
      const pending = checkRepoReach({ owner: "a", repo: "b" }, clientReturning(get));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await pending).toEqual({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });
});
