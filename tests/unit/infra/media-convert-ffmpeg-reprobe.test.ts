import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const execFileMock = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

import { checkFfmpeg, resetFfmpegCache } from "../../../src/infra/media-convert.js";

type Cb = (err: Error | null, stdout?: string, stderr?: string) => void;

describe("checkFfmpeg — re-probes a missing ffmpeg at most once per 60s", () => {
  let ffmpegInstalled = false;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-07T00:00:00Z"));
    resetFfmpegCache();
    ffmpegInstalled = false;
    execFileMock.mockReset();
    execFileMock.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as Cb;
      if (ffmpegInstalled) cb(null, "ffmpeg version 6.1", "");
      else cb(Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" }));
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    resetFfmpegCache();
  });

  it("returns false, does not re-probe within 60s, then returns true after 61s once ffmpeg is installed", async () => {
    expect(await checkFfmpeg()).toBe(false);
    expect(execFileMock).toHaveBeenCalledTimes(1);

    // ffmpeg gets installed on the VPS
    ffmpegInstalled = true;

    // Within the 60s window: cached failure, no re-probe
    vi.advanceTimersByTime(30_000);
    expect(await checkFfmpeg()).toBe(false);
    vi.advanceTimersByTime(29_000);
    expect(await checkFfmpeg()).toBe(false);
    expect(execFileMock).toHaveBeenCalledTimes(1);

    // 61s after the failed probe: re-probe and pick up the install
    vi.advanceTimersByTime(2_000);
    expect(await checkFfmpeg()).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("caches success: no further probes after ffmpeg is found", async () => {
    ffmpegInstalled = true;
    expect(await checkFfmpeg()).toBe(true);
    vi.advanceTimersByTime(10 * 60_000);
    expect(await checkFfmpeg()).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });
});
