import { describe, expect, it } from "vitest";
import { findWebAppButton, newestWebAppMessage, parseWebAppArgs, webViewPeer } from "../../../scripts/lib/webapp-args.js";
import type { TapButton } from "../../../scripts/lib/tap-guard.js";

const BTNS: TapButton[] = [
  { label: "Yes", data: "jh:q:x:0" },
  { label: "Docs", url: "https://example.com/docs" },
  { label: "Open answer page", url: "https://node.ts.net/apply/x", webApp: true },
  { label: "Other app", url: "https://node.ts.net/other", webApp: true },
];

describe("telegram-webapp: parseWebAppArgs", () => {
  it("parses open <msgId>", () => {
    expect(parseWebAppArgs(["open", "42"])).toEqual({ cmd: "open", msgId: 42 });
  });
  it("parses menu and latest", () => {
    expect(parseWebAppArgs(["menu"])).toEqual({ cmd: "menu" });
    expect(parseWebAppArgs(["latest"])).toEqual({ cmd: "latest" });
  });
  it("rejects open without a numeric id, and unknown commands", () => {
    expect(() => parseWebAppArgs(["open"])).toThrow(/usage/);
    expect(() => parseWebAppArgs(["open", "abc"])).toThrow(/usage/);
    expect(() => parseWebAppArgs(["open", "-3"])).toThrow(/usage/);
    expect(() => parseWebAppArgs(["nope"])).toThrow(/usage/);
    expect(() => parseWebAppArgs([])).toThrow(/usage/);
  });
});

describe("telegram-webapp: findWebAppButton", () => {
  it("returns the first web_app button, ignoring callback and plain url buttons", () => {
    expect(findWebAppButton(BTNS)?.label).toBe("Open answer page");
  });
  it("returns undefined when there is none", () => {
    expect(findWebAppButton(BTNS.slice(0, 2))).toBeUndefined();
    expect(findWebAppButton([])).toBeUndefined();
  });
});

describe("telegram-webapp: newestWebAppMessage", () => {
  it("picks the highest-id bot message that has a web_app button", () => {
    const msgs = [
      { id: 5, out: false, buttons: BTNS },
      { id: 9, out: true, buttons: BTNS },
      { id: 8, out: false, buttons: BTNS.slice(0, 2) },
      { id: 7, out: false, buttons: BTNS },
    ];
    expect(newestWebAppMessage(msgs)?.id).toBe(7);
  });
  it("returns undefined when no bot message has one", () => {
    expect(newestWebAppMessage([{ id: 1, out: false, buttons: [] }])).toBeUndefined();
  });
});

describe("telegram-webapp: webViewPeer", () => {
  it("opens the bot menu button in the bot's own chat, never in the probe chat (a group gave USER_BOT_REQUIRED)", () => {
    expect(webViewPeer(true, "probe-chat", "bot-chat")).toBe("bot-chat");
  });
  it("opens an inline web_app button in the chat that holds the message", () => {
    expect(webViewPeer(false, "probe-chat", "bot-chat")).toBe("probe-chat");
  });
});
