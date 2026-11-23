import { describe, expect, it, vi } from "vitest";

const mockRead = vi.hoisted(() => vi.fn());
vi.mock("../../../src/infra/providers/google-direct.js", () => ({ directReadEmails: mockRead }));
import { EMAIL_POLL_MAX_MS, EMAIL_POLL_MS, pollEmailCode, readRecentMail, type PollDeps } from "../../../src/tools/jobhunt/email-code-poll.js";
import type { CodeMail } from "../../../src/tools/jobhunt/email-code.js";

const T0 = Date.parse("2026-11-22T10:00:00Z");
const input = { rowId: "row-1", company: "Acme Robotics", sentAfter: T0 };

const codeMail = (code: string, at: number): CodeMail => ({
  sender: "Greenhouse <no-reply@us.greenhouse-mail.io>",
  subject: "Security code for your application to Acme Robotics",
  body: `Copy and paste this code into the security code field: ${code}`,
  receivedAt: at,
});

function harness(reads: Array<readonly CodeMail[] | null>, held = () => true) {
  let t = T0;
  const enter = vi.fn(async () => undefined);
  let i = 0;
  const read = vi.fn(async () => reads[Math.min(i++, reads.length - 1)] ?? null);
  const deps: PollDeps = { read, isHeld: held, enter, now: () => t, sleep: async (ms) => void (t += ms) };
  return { deps, enter, read, clock: () => t };
}

describe("pollEmailCode", () => {
  it("enters the code once when it shows up", async () => {
    const h = harness([[], [], [codeMail("k3Jd9sLm", T0 + 20_000)]]);
    expect(await pollEmailCode(input, h.deps)).toBe("entered");
    expect(h.enter).toHaveBeenCalledTimes(1);
    expect(h.enter).toHaveBeenCalledWith("k3Jd9sLm");
    expect(h.read).toHaveBeenCalledTimes(3);
  });
  it("times out after 8 minutes with no call", async () => {
    const h = harness([[]]);
    expect(await pollEmailCode(input, h.deps)).toBe("not-found");
    expect(h.enter).not.toHaveBeenCalled();
    expect(h.clock() - T0).toBeGreaterThanOrEqual(EMAIL_POLL_MAX_MS);
    expect(h.read.mock.calls.length).toBe(Math.ceil(EMAIL_POLL_MAX_MS / EMAIL_POLL_MS));
  });
  it("stops without entering when two different codes arrive", async () => {
    const h = harness([[codeMail("k3Jd9sLm", T0 + 5_000), codeMail("Qw3rTy9Z", T0 + 9_000)]]);
    expect(await pollEmailCode(input, h.deps)).toBe("ambiguous");
    expect(h.enter).not.toHaveBeenCalled();
  });
  it("stops when the hold is released", async () => {
    let calls = 0;
    const h = harness([[]], () => ++calls < 3);
    expect(await pollEmailCode(input, h.deps)).toBe("released");
    expect(h.enter).not.toHaveBeenCalled();
  });
  it("keeps polling through a failed read", async () => {
    const h = harness([null, [codeMail("k3Jd9sLm", T0 + 20_000)]]);
    expect(await pollEmailCode(input, h.deps)).toBe("entered");
    expect(h.enter).toHaveBeenCalledTimes(1);
  });
  it("ignores a stale code from before the submit", async () => {
    const h = harness([[codeMail("k3Jd9sLm", T0 - 120_000)]]);
    expect(await pollEmailCode(input, h.deps)).toBe("not-found");
    expect(h.enter).not.toHaveBeenCalled();
  });
  it("reports error and does not throw when entering fails", async () => {
    const h = harness([[codeMail("k3Jd9sLm", T0 + 5_000)]]);
    h.enter.mockRejectedValueOnce(new Error("boom"));
    expect(await pollEmailCode(input, h.deps)).toBe("error");
  });
});

describe("readRecentMail", () => {
  it("asks the provider for the full body, not the snippet", async () => {
    mockRead.mockResolvedValue({ success: true, data: "1. From: a@example.com · Mon, 23 Nov 2026 10:00:00 +0000\n   Subject: s\n   body" });
    const mails = await readRecentMail();
    expect(mockRead).toHaveBeenCalledWith(expect.objectContaining({ full_body: true }));
    expect(mails).toHaveLength(1);
  });
});
