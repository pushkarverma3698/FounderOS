import { describe, expect, it, vi } from "vitest";

const read = vi.fn(async (i: { account_key?: string }) =>
  i.account_key === "naggar" ? { success: false, error: "needs re-authorization" } : { success: true, data: `mail ${i.account_key}` },
);
vi.mock("../../../src/infra/providers/index.js", () => ({ providerReadEmails: read }));
vi.mock("../../../src/infra/google-mailboxes.js", () => ({ listGoogleMailboxes: () => ["turicks", "personal", "naggar", "wife"] }));

const { readEmailsTool } = await import("../../../src/tools/email-reader.js");

describe("read_emails account", () => {
  it("passes one account through", async () => {
    await readEmailsTool.execute({ query: "x", account_key: "wife" });
    expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ account_key: "wife" }));
  });

  it("'all' reads every mailbox, labelled, and keeps a failed one visible", async () => {
    const r = await readEmailsTool.execute({ query: "x", account_key: "all" });
    expect(r.success).toBe(true);
    expect(String(r.data)).toContain("## wife\nmail wife");
    expect(String(r.data)).toContain("## naggar\nError: needs re-authorization");
  });
});
