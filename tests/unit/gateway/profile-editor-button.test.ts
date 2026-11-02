/**
 * /profile "Edit answers" button: a web_app button in a private chat for the person whose profile is shown;
 * nothing in a group (Telegram refuses web_app there), for another candidate's profile, or without an https base.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleProfile } from "../../../src/gateway/profile-commands.js";
import { applyProfilePathFor } from "../../../src/tools/jobhunt/apply-profile.js";

const KEYS = ["APPLY_PROFILE_PATH", "FOUNDEROS_DATA_ROOT", "APPLY_LINK_SECRET", "APPLY_LINK_BASE_URL", "JOBHUNT_SENDER_PROFILES"];
const raw = { first_name: "F", last_name: "P", email: "f@example.com", phone: "+31 6 00000000", answers: {} };

describe("/profile Edit answers button", () => {
  let dir: string;
  const prev: Record<string, string | undefined> = {};

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "founderos-profile-button-"));
    for (const k of KEYS) prev[k] = process.env[k];
    process.env["FOUNDEROS_DATA_ROOT"] = dir;
    process.env["APPLY_PROFILE_PATH"] = path.join(dir, "apply-profile.json");
    process.env["APPLY_LINK_SECRET"] = "s3cret-for-tests-0123456789abcdef";
    process.env["APPLY_LINK_BASE_URL"] = "https://apply.example.test";
    process.env["JOBHUNT_SENDER_PROFILES"] = "111=pushkar,222=wife";
    for (const id of ["pushkar-nl-tech", "wife-nl-finance"]) await fs.writeFile(applyProfilePathFor(id), JSON.stringify(raw));
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function run(match: string, chatId: number, userId: number) {
    const sent: Array<{ text: string; opts: any }> = [];
    const ctx = { match, chat: { id: chatId }, from: { id: userId }, reply: async (text: string, opts?: unknown) => void sent.push({ text, opts }) };
    await handleProfile(ctx as never);
    return sent[0]!;
  }
  const button = (m: { opts: any }) => m.opts?.reply_markup?.inline_keyboard?.[0]?.[0];

  it("a private chat gets a web_app button to /apply/profile", async () => {
    const m = await run("", 111, 111);
    expect(button(m)).toEqual({ text: "Edit answers", web_app: { url: "https://apply.example.test/apply/profile" } });
  });

  it("the wife gets it for her own profile, via the sender mapping", async () => {
    const m = await run("wife", 222, 222);
    expect(button(m)?.web_app.url).toBe("https://apply.example.test/apply/profile");
  });

  it("a group chat keeps today's text and has no button", async () => {
    const m = await run("", -5319642142, 111);
    expect(m.opts.reply_markup).toBeUndefined();
    expect(m.opts.parse_mode).toBe("HTML");
  });

  it("no button when looking at another candidate's profile, or on a plain http base", async () => {
    expect(button(await run("wife", 111, 111))).toBeUndefined();
    process.env["APPLY_LINK_BASE_URL"] = "http://apply.example.test";
    expect(button(await run("", 111, 111))).toBeUndefined();
  });
});
