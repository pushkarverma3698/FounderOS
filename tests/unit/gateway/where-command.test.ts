import { describe, it, expect, vi } from "vitest";
import { handleWhere } from "../../../src/gateway/where-command.js";
import { OWNER_ONLY_COMMANDS } from "../../../src/gateway/chat-access.js";

const ctxFor = (match: string) => {
  const reply = vi.fn(async (..._a: unknown[]) => undefined);
  return { ctx: { match, reply } as never, reply };
};

describe("/where", () => {
  it("is owner-only", () => expect(OWNER_ONLY_COMMANDS.has("where")).toBe(true));

  it("unknown repo lists valid names and does not fetch", async () => {
    const { ctx, reply } = ctxFor("nope");
    const fetch = vi.fn();
    await handleWhere(ctx, { fetch });
    expect(fetch).not.toHaveBeenCalled();
    expect(String(reply.mock.calls[0]?.[0])).toContain("FounderOS");
  });

  it("passes only the matched repo to fetch", async () => {
    const { ctx } = ctxFor("founderos");
    const fetch = vi.fn(async (_r: readonly string[]) => ({ summaries: [], unreachable: [] }));
    await handleWhere(ctx, { fetch });
    expect(fetch).toHaveBeenCalledWith(["pushkarverma3698/FounderOS"]);
  });
});
