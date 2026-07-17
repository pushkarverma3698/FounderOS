/**
 * Malformed-payload resilience: content types the bot can't process must get a
 * clear acknowledgement, never silence. Before this, a founder sending a video,
 * sticker, or location matched no grammY handler and got zero reply (silent drop).
 */

import { describe, it, expect } from "vitest";
import { unsupportedMediaReply, registerMediaHandlers } from "../../../src/gateway/media.js";

describe("unsupported media — no more silent drops", () => {
  it("unsupportedMediaReply names the content type and steers to supported inputs", () => {
    const msg = unsupportedMediaReply("videos");
    expect(msg).toContain("videos");
    expect(msg.toLowerCase()).toContain("text");
  });

  it("registers acknowledgement handlers for video/sticker/location (not just photo/voice)", () => {
    const filters: unknown[] = [];
    const fakeBot = {
      on: (f: unknown) => {
        filters.push(f);
        return fakeBot;
      },
    };
    registerMediaHandlers(fakeBot as never, async () => {});
    const flat = filters.flat();
    expect(flat).toContain("message:video");
    expect(flat).toContain("message:sticker");
    expect(flat).toContain("message:location");
  });
});
