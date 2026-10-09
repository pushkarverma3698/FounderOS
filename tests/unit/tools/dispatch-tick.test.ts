/**
 * Unit tests for starting a dispatch job (src/tools/dispatch-tick.ts).
 *
 * One /task = one process that owns the job to its end. The bot's only act is to write one JSON line to the
 * fos-job socket (systemd starts deploy/job-run for it, outside the bot's NoNewPrivileges sandbox). Unlike the
 * kick file this replaced, this is THE path: when it cannot start a run the caller must be able to tell the
 * founder, so the result says so. Nothing here may start a process.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { startDispatchJob, startFixJob, startPromoteJob, jobSocketPath, jobRequestLine, startFailureNote } = await import("../../../src/tools/dispatch-tick.js");

const ORIGINAL_BIN = process.env["AGENT_DISPATCH_BIN"];
const ORIGINAL_SOCK = process.env["FOS_JOB_SOCKET"];
const REPO = "pushkarverma3698/FounderOS";

beforeEach(() => {
  delete process.env["AGENT_DISPATCH_BIN"];
  delete process.env["FOS_JOB_SOCKET"];
});

afterEach(() => {
  if (ORIGINAL_BIN) process.env["AGENT_DISPATCH_BIN"] = ORIGINAL_BIN;
  else delete process.env["AGENT_DISPATCH_BIN"];
  if (ORIGINAL_SOCK) process.env["FOS_JOB_SOCKET"] = ORIGINAL_SOCK;
  else delete process.env["FOS_JOB_SOCKET"];
});

describe("startDispatchJob", () => {
  it("is inert when AGENT_DISPATCH_BIN is unset: tests, CI and the laptop never touch a socket", async () => {
    const send = vi.fn();
    expect(await startDispatchJob(123, REPO, "build", send)).toEqual({ status: "inert" });
    expect(send).not.toHaveBeenCalled();
  });

  it("is inert when AGENT_DISPATCH_BIN is blank", async () => {
    process.env["AGENT_DISPATCH_BIN"] = "   ";
    const send = vi.fn();
    expect((await startDispatchJob(123, REPO, "spec", send)).status).toBe("inert");
    expect(send).not.toHaveBeenCalled();
  });

  it("writes exactly one JSON line {repo, issue, stage} to /run/fos-job.sock by default", async () => {
    process.env["AGENT_DISPATCH_BIN"] = "/home/founderos/bin/agent-dispatch";
    const send = vi.fn().mockResolvedValue(undefined);

    const r = await startDispatchJob(670, REPO, "spec", send);

    expect(r).toEqual({ status: "started" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("/run/fos-job.sock", `${JSON.stringify({ repo: REPO, issue: 670, stage: "spec" })}\n`);
  });

  it("FOS_JOB_SOCKET overrides the socket path", async () => {
    process.env["AGENT_DISPATCH_BIN"] = "/x";
    process.env["FOS_JOB_SOCKET"] = "/tmp/other.sock";
    const send = vi.fn().mockResolvedValue(undefined);

    await startDispatchJob(1, REPO, "build", send);

    expect(send.mock.calls[0]?.[0]).toBe("/tmp/other.sock");
    expect(jobSocketPath()).toBe("/tmp/other.sock");
  });

  it("a refused or missing socket comes back as a failure with the reason, never a throw", async () => {
    process.env["AGENT_DISPATCH_BIN"] = "/x";
    const send = vi.fn().mockRejectedValue(new Error("connect ENOENT /run/fos-job.sock"));

    const r = await startDispatchJob(670, REPO, "build", send);

    expect(r).toEqual({ status: "failed", reason: "connect ENOENT /run/fos-job.sock" });
  });

  it("refuses a bad issue number or repo before it reaches the socket", async () => {
    process.env["AGENT_DISPATCH_BIN"] = "/x";
    const send = vi.fn();

    for (const n of [0, -1, Number.NaN, 1.5]) expect((await startDispatchJob(n, REPO, "build", send)).status).toBe("failed");
    for (const repo of ["", "  ", "no-slash", "a/b/c", "o/r;rm -rf", "o/r\nx"]) {
      expect((await startDispatchJob(5, repo, "build", send)).status).toBe("failed");
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("jobRequestLine carries the repo exactly as given (trimmed): the dispatcher matches it by name", () => {
    expect(jobRequestLine(7, ` ${REPO} `, "build")).toBe(`{"repo":"${REPO}","issue":7,"stage":"build"}\n`);
  });

  it("startFailureNote names the issue and gives the founder the check to run", () => {
    const note = startFailureNote(41, REPO, "connect ENOENT /run/fos-job.sock");
    expect(note).toContain(`${REPO}#41`);
    expect(note).toContain("connect ENOENT /run/fos-job.sock");
    expect(note).toContain("systemctl status fos-job.socket");
  });

  it("really delivers one line over a unix socket, and fails when nothing listens", async () => {
    const dir = mkdtempSync(join(tmpdir(), "job-sock-"));
    const path = join(dir, "s.sock");
    const received: string[] = [];
    let server: Server | undefined;
    try {
      server = createServer((c) => {
        let buf = "";
        c.on("data", (d) => (buf += d.toString()));
        c.on("end", () => received.push(buf));
      });
      await new Promise<void>((res) => server!.listen(path, res));
      process.env["AGENT_DISPATCH_BIN"] = "/x";
      process.env["FOS_JOB_SOCKET"] = path;

      expect(await startDispatchJob(9, REPO, "build")).toEqual({ status: "started" });
      await vi.waitFor(() => expect(received).toHaveLength(1));
      expect(JSON.parse(received[0]!.trim())).toEqual({ repo: REPO, issue: 9, stage: "build" });

      await new Promise((res) => server!.close(res));
      server = undefined;
      const r = await startDispatchJob(9, REPO, "build");
      expect(r.status).toBe("failed");
    } finally {
      server?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never starts a process: that is exactly what could not work under the bot's sandbox", () => {
    const source = readFileSync(new URL("../../../src/tools/dispatch-tick.ts", import.meta.url), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/child_process|spawn\(|exec\(|execFile/);
  });
});

describe("startFixJob", () => {
  const HEAD = "5c0ffee5c0ffee5c0ffee5c0ffee5c0ffee5c0ff";

  it("is inert off the VPS and never touches the socket", async () => {
    const send = vi.fn();
    expect(await startFixJob(115, REPO, HEAD, send)).toEqual({ status: "inert" });
    expect(send).not.toHaveBeenCalled();
  });

  it("writes one {repo, issue, stage: fix, head} line: the head is the commit the founder was shown", async () => {
    process.env["AGENT_DISPATCH_BIN"] = "/x";
    const send = vi.fn().mockResolvedValue(undefined);

    expect(await startFixJob(115, REPO, HEAD, send)).toEqual({ status: "started" });

    expect(send).toHaveBeenCalledWith("/run/fos-job.sock", `${JSON.stringify({ repo: REPO, issue: 115, stage: "fix", head: HEAD })}\n`);
  });

  it("refuses a head that is not a commit sha, a bad issue or a bad repo before the socket", async () => {
    process.env["AGENT_DISPATCH_BIN"] = "/x";
    const send = vi.fn();
    for (const head of ["", "main", "abc", "xyz".repeat(5), `${HEAD}0`, "5c0ffee; rm -rf /"]) {
      expect((await startFixJob(115, REPO, head, send)).status).toBe("failed");
    }
    expect((await startFixJob(0, REPO, HEAD, send)).status).toBe("failed");
    expect((await startFixJob(115, "no-slash", HEAD, send)).status).toBe("failed");
    expect(send).not.toHaveBeenCalled();
  });

  it("reports a dead socket instead of throwing", async () => {
    process.env["AGENT_DISPATCH_BIN"] = "/x";
    const dead = vi.fn().mockRejectedValue(new Error("connect ENOENT /run/fos-job.sock"));
    expect(await startFixJob(115, REPO, HEAD, dead)).toEqual({ status: "failed", reason: "connect ENOENT /run/fos-job.sock" });
  });
});

describe("startPromoteJob", () => {
  const SHA = "b".repeat(40);

  it("is inert off the VPS and never touches the socket", async () => {
    const send = vi.fn();
    expect(await startPromoteJob(REPO, SHA, send)).toEqual({ status: "inert" });
    expect(send).not.toHaveBeenCalled();
  });

  it("writes one {repo, stage: promote, beta_sha} line to the job socket", async () => {
    process.env["AGENT_DISPATCH_BIN"] = "/x";
    const send = vi.fn().mockResolvedValue(undefined);

    expect(await startPromoteJob(REPO, SHA, send)).toEqual({ status: "started" });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("/run/fos-job.sock", `${JSON.stringify({ repo: REPO, stage: "promote", beta_sha: SHA, base: "main", deploy: "box" })}\n`);
  });

  it("refuses another repo or a bad sha before the socket, and reports a dead socket", async () => {
    process.env["AGENT_DISPATCH_BIN"] = "/x";
    const send = vi.fn();
    expect((await startPromoteJob("o/other", SHA, send)).status).toBe("failed");
    expect((await startPromoteJob(REPO, "abc", send)).status).toBe("failed");
    expect(send).not.toHaveBeenCalled();

    const dead = vi.fn().mockRejectedValue(new Error("connect ENOENT /run/fos-job.sock"));
    expect(await startPromoteJob(REPO, SHA, dead)).toEqual({ status: "failed", reason: "connect ENOENT /run/fos-job.sock" });
  });
});
