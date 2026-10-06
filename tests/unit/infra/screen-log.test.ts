/**
 * Unit test — the screen log (src/infra/screen-log.ts): every Telegram send is appended to one
 * JSONL file, and the planner reads back what one chat saw recently.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendScreenEntry,
  installScreenCapture,
  readScreen,
  screenEntryFromCall,
  screenQuiet,
  SCREEN_LOG_MAX_BYTES,
} from "../../../src/infra/screen-log.js";

let dir: string;
let file: string;
const now = new Date("2026-10-04T13:46:06Z");
const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
const line = (o: Record<string, unknown>) => `${JSON.stringify(o)}\n`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "screen-log-"));
  file = join(dir, "screen.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("readScreen", () => {
  it("returns nothing when the file does not exist yet", async () => {
    expect(await readScreen("111", now, { file })).toEqual([]);
  });

  it("returns only the asking chat's entries: the family group never sees the founder's DM alerts", async () => {
    writeFileSync(
      file,
      line({ ts: ago(5), chat: "111", src: "pr-brain", text: "DM alert" }) +
        line({ ts: ago(4), chat: "-5319642142", src: "bot", text: "group message" }),
    );
    expect((await readScreen("111", now, { file })).map((e) => e.text)).toEqual(["DM alert"]);
    expect((await readScreen("-5319642142", now, { file })).map((e) => e.text)).toEqual(["group message"]);
  });

  it("drops entries older than the window and keeps them oldest first", async () => {
    writeFileSync(
      file,
      line({ ts: ago(13 * 60), chat: "111", src: "bot", text: "yesterday" }) +
        line({ ts: ago(30), chat: "111", src: "bot", text: "first" }) +
        line({ ts: ago(2), chat: "111", src: "bot", text: "second" }),
    );
    expect((await readScreen("111", now, { file })).map((e) => e.text)).toEqual(["first", "second"]);
  });

  it("treats a later entry with the same message id as an edit and a delete as gone", async () => {
    writeFileSync(
      file,
      line({ ts: ago(10), chat: "111", src: "agent-dispatch", mid: 7, text: "🔧 starting…" }) +
        line({ ts: ago(5), chat: "111", src: "agent-dispatch", mid: 7, text: "🔧 3 files changed" }) +
        line({ ts: ago(4), chat: "111", src: "bot", mid: 8, text: "⏳ working…" }) +
        line({ ts: ago(3), chat: "111", src: "bot", mid: 8, del: true }),
    );
    const got = await readScreen("111", now, { file });
    expect(got.map((e) => e.text)).toEqual(["🔧 3 files changed"]);
    expect(got[0]!.ts).toBe(ago(5));
  });

  it("skips malformed and partial lines instead of failing the read", async () => {
    writeFileSync(
      file,
      "not json\n" +
        '{"ts":"2026-10-04T13:40:00Z","chat":"111"\n' +
        line({ ts: "garbage", chat: "111", src: "bot", text: "bad time" }) +
        line({ ts: ago(1), chat: 111, src: "bot", text: "numeric chat" }) +
        line({ ts: ago(1), chat: "111", src: "bot", text: "good" }),
    );
    expect((await readScreen("111", now, { file })).map((e) => e.text)).toEqual(["good"]);
  });

  it("keeps the last `max` entries", async () => {
    writeFileSync(file, Array.from({ length: 30 }, (_, i) => line({ ts: ago(30 - i), chat: "111", src: "bot", text: `m${i}` })).join(""));
    const got = await readScreen("111", now, { file, max: 5 });
    expect(got.map((e) => e.text)).toEqual(["m25", "m26", "m27", "m28", "m29"]);
  });

  it("still sees recent entries right after a rotation by reading the rotated file too", async () => {
    writeFileSync(`${file}.1`, line({ ts: ago(20), chat: "111", src: "pr-brain", text: "before rotation" }));
    writeFileSync(file, line({ ts: ago(1), chat: "111", src: "bot", text: "after rotation" }));
    expect((await readScreen("111", now, { file })).map((e) => e.text)).toEqual(["before rotation", "after rotation"]);
  });
});

describe("appendScreenEntry", () => {
  it("writes one JSON line per entry that readScreen reads back", async () => {
    await appendScreenEntry({ chat: "111", src: "journey-where", text: 'red: "open PRs" 3 ≠ 4\nsecond line' }, file, now);
    const got = await readScreen("111", now, { file });
    expect(got).toEqual([{ ts: now.toISOString(), chat: "111", src: "journey-where", text: 'red: "open PRs" 3 ≠ 4\nsecond line' }]);
  });

  it("rotates the file once it passes the size cap", async () => {
    writeFileSync(file, "x".repeat(SCREEN_LOG_MAX_BYTES + 1));
    await appendScreenEntry({ chat: "111", src: "bot", text: "fresh" }, file, now);
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("fresh");
    expect(readFileSync(file, "utf8").length).toBeLessThan(500);
  });

  it("never throws when the file cannot be written", async () => {
    chmodSync(dir, 0o500);
    try {
      await expect(appendScreenEntry({ chat: "111", src: "bot", text: "x" }, file, now)).resolves.toBeUndefined();
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it("does nothing when the log is disabled (file null)", async () => {
    await appendScreenEntry({ chat: "111", src: "bot", text: "x" }, null, now);
    expect(existsSync(file)).toBe(false);
  });
});

describe("screenEntryFromCall", () => {
  it("records a sent message with its id, chat and text", () => {
    expect(screenEntryFromCall("sendMessage", { chat_id: 111, text: "hi" }, { message_id: 5 }, "bot")).toEqual({
      chat: "111",
      src: "bot",
      text: "hi",
      mid: 5,
    });
  });

  it("records an edit under the edited message's id", () => {
    expect(
      screenEntryFromCall("editMessageText", { chat_id: "111", message_id: 5, text: "new" }, true, "bot"),
    ).toEqual({ chat: "111", src: "bot", text: "new", mid: 5 });
  });

  it("records a photo or document by its caption, and a delete as a tombstone", () => {
    expect(screenEntryFromCall("sendPhoto", { chat_id: 111, caption: "shot" }, { message_id: 9 }, "bot")).toEqual({
      chat: "111",
      src: "bot",
      text: "shot",
      mid: 9,
    });
    expect(screenEntryFromCall("deleteMessage", { chat_id: 111, message_id: 9 }, true, "bot")).toEqual({
      chat: "111",
      src: "bot",
      mid: 9,
      del: true,
    });
  });

  it("ignores calls that put nothing on the screen", () => {
    expect(screenEntryFromCall("getMe", {}, {}, "bot")).toBeNull();
    expect(screenEntryFromCall("sendChatAction", { chat_id: 111, action: "typing" }, true, "bot")).toBeNull();
    expect(screenEntryFromCall("editMessageText", { inline_message_id: "x", text: "t" }, true, "bot")).toBeNull();
    expect(screenEntryFromCall("sendMessage", { chat_id: 111 }, { message_id: 1 }, "bot")).toBeNull();
  });
});

describe("installScreenCapture", () => {
  type Prev = (method: string, payload: Record<string, unknown>) => Promise<{ ok: boolean; result?: unknown }>;
  function fakeApi() {
    let transformer: ((prev: Prev, method: string, payload: Record<string, unknown>) => Promise<unknown>) | undefined;
    return {
      api: { config: { use: (t: unknown) => void (transformer = t as typeof transformer) } },
      call: (method: string, payload: Record<string, unknown>, res: { ok: boolean; result?: unknown }) =>
        transformer!(async () => res, method, payload),
    };
  }

  it("records a successful send and hands the response back untouched", async () => {
    const fake = fakeApi();
    installScreenCapture(fake.api, "bot", file);
    const res = { ok: true, result: { message_id: 3 } };
    expect(await fake.call("sendMessage", { chat_id: 111, text: "/where output" }, res)).toBe(res);
    expect((await readScreen("111", new Date(), { file })).map((e) => e.text)).toEqual(["/where output"]);
  });

  it("does not record a send Telegram refused", async () => {
    const fake = fakeApi();
    installScreenCapture(fake.api, "bot", file);
    await fake.call("sendMessage", { chat_id: 111, text: "refused" }, { ok: false });
    expect(existsSync(file)).toBe(false);
  });

  it("skips sends made inside screenQuiet — the kernel's own reply is already in history", async () => {
    const fake = fakeApi();
    installScreenCapture(fake.api, "bot", file);
    await screenQuiet(() => fake.call("sendMessage", { chat_id: 111, text: "kernel reply" }, { ok: true, result: { message_id: 1 } }));
    await fake.call("sendMessage", { chat_id: 111, text: "hitl card" }, { ok: true, result: { message_id: 2 } });
    expect((await readScreen("111", new Date(), { file })).map((e) => e.text)).toEqual(["hitl card"]);
  });

  it("survives an api object without a transformer hook (mocked grammy in other tests)", () => {
    expect(() => installScreenCapture({} as never, "bot", file)).not.toThrow();
  });
});
