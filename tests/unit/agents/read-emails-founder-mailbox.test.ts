/**
 * J1 (2026-10-08): the mailbox the founder names in his message outranks the model's account
 * argument (configurable.founder_text, set by src/gateway/kernel-run.ts).
 */
import { describe, expect, it, vi } from "vitest";

const execute = vi.fn(async (_i: Record<string, unknown>) => ({ success: true, data: "mail" }));
vi.mock("../../../src/tools/email-reader.js", () => ({ readEmailsTool: { execute } }));
vi.mock("../../../src/infra/google-mailboxes.js", async (orig) => ({
  ...(await (orig() as Promise<Record<string, unknown>>)),
  listGoogleMailboxes: () => ["turicks", "personal", "naggar", "work"],
}));

const { readEmails } = await import("../../../src/agents/agent-tools/comms.js");

const run = (args: Record<string, unknown>, founderText?: string) =>
  readEmails.invoke(args, { configurable: { thread_id: "t", ...(founderText ? { founder_text: founderText } : {}) } });

describe("read_emails picks the mailbox the founder named", () => {
  it("'my work inbox' reads work even when the model passes turicks", async () => {
    await run({ query: "newer_than:1d", account: "turicks" }, "Anything important in my work inbox since yesterday?");
    expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({ account_key: "work" }));
  });

  it("'my work inbox' reads work when the model passes no account", async () => {
    await run({ query: "newer_than:1d" }, "Anything important in my work inbox since yesterday?");
    expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({ account_key: "work" }));
  });

  it("keeps the model's account when the founder named none", async () => {
    await run({ account: "personal" }, "anything important in my inbox?");
    expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({ account_key: "personal" }));
  });

  it("keeps the model's account outside a founder turn (no founder_text)", async () => {
    await run({ account: "naggar" });
    expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({ account_key: "naggar" }));
  });
});
