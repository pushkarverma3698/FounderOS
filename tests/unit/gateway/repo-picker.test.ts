/**
 * Unit tests — the repo picker, the thing that replaced `/task repo:app …`.
 *
 * Two properties carry the whole design: a tapped button is re-resolved against
 * the allowlist rather than trusted, and a keyboard never goes out over
 * Telegram's 64-byte callback budget. The first is a security boundary (the VPS
 * token can write to every repo it can reach); the second is a whole-message
 * rejection, so one oversized button costs the founder every button.
 */

import { describe, it, expect } from "vitest";
import {
  MAX_CALLBACK_BYTES,
  REPO_CALLBACK_PREFIX,
  buildRepoKeyboardRows,
  buildRepoPrompt,
  buildRepoQuestion,
  labelForRepo,
  repoCallbackData,
  repoChoices,
  repoFromCallbackData,
  repoFromPrompt,
} from "../../../src/gateway/repo-picker.js";
import { DISPATCH_REPO_ALLOWLIST } from "../../../src/tools/dispatch-repos.js";

const APP = "OplifyMessage/oplify-messaging-app";
const HULDA = "pushkarverma3698/House-of-Hulda-Website-frontend";

describe("repoChoices", () => {
  it("offers every hardcoded repo", () => {
    const slugs = repoChoices().map((c) => c.slug);
    expect(slugs).toEqual([...DISPATCH_REPO_ALLOWLIST]);
  });

  it("includes a repo this instance created from Telegram", () => {
    const slugs = repoChoices(["pushkarverma3698/turicks-pricing-api"]).map((c) => c.slug);
    expect(slugs).toContain("pushkarverma3698/turicks-pricing-api");
  });

  it("does not list a created repo twice when it is already hardcoded", () => {
    const slugs = repoChoices([APP]).map((c) => c.slug);
    expect(slugs.filter((s) => s === APP)).toHaveLength(1);
  });
});

describe("labelForRepo", () => {
  it("distinguishes the two Oplify repos, which differ by one character", () => {
    const app = labelForRepo(APP);
    const api = labelForRepo("OplifyMessage/oplify-messaging-api");
    expect(app).not.toBe(api);
    expect(app.toLowerCase()).toContain("app");
    expect(api.toLowerCase()).toContain("api");
  });

  it("falls back to the repo name for something it has never seen", () => {
    expect(labelForRepo("pushkarverma3698/turicks-pricing-api")).toContain("turicks-pricing-api");
  });
});

describe("repoCallbackData", () => {
  it("stays inside Telegram's 64-byte budget for every offered repo", () => {
    // Telegram rejects the ENTIRE keyboard on one oversized payload, so this is
    // not a per-button property — it is whether the founder gets any buttons.
    for (const choice of repoChoices()) {
      const data = repoCallbackData(choice.slug);
      expect(data).not.toBeNull();
      expect(Buffer.byteLength(data as string, "utf8")).toBeLessThanOrEqual(MAX_CALLBACK_BYTES);
    }
  });

  it("returns null rather than an oversized payload", () => {
    expect(repoCallbackData(`me/${"x".repeat(100)}`)).toBeNull();
  });

  it("drops an un-encodable repo from the keyboard instead of breaking it", () => {
    const rows = buildRepoKeyboardRows([`me/${"x".repeat(100)}`]);
    expect(rows.flat().every((b) => Buffer.byteLength(b.callback_data, "utf8") <= MAX_CALLBACK_BYTES)).toBe(true);
  });
});

describe("repoFromCallbackData", () => {
  it("round-trips every offered repo", () => {
    for (const choice of repoChoices()) {
      expect(repoFromCallbackData(repoCallbackData(choice.slug) as string)).toBe(choice.slug);
    }
  });

  it("REFUSES a repo that is not on the allowlist", () => {
    // Callback data made a round trip through a Telegram client. Trusting it
    // would make a hand-crafted payload a way past the one list standing between
    // a malformed dispatch and everything the VPS token can write to.
    expect(repoFromCallbackData(`${REPO_CALLBACK_PREFIX}someone-elses-private-repo`)).toBeNull();
  });

  it("refuses an ambiguous name instead of picking the first match", () => {
    // "oplify-messaging" is a prefix of both Oplify repos. Guessing puts the PR
    // in a repository the founder never named.
    expect(repoFromCallbackData(`${REPO_CALLBACK_PREFIX}oplify-messaging`)).toBeNull();
  });

  it("ignores a payload that is not ours", () => {
    expect(repoFromCallbackData("approve")).toBeNull();
  });
});

describe("buildRepoKeyboardRows", () => {
  it("lays the buttons out two per row so labels do not wrap on a phone", () => {
    const rows = buildRepoKeyboardRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(2);
    expect(rows.flat()).toHaveLength(DISPATCH_REPO_ALLOWLIST.length);
  });
});

describe("buildRepoQuestion", () => {
  it("echoes the work back, so he is not approving something off-screen", () => {
    expect(buildRepoQuestion("fix the flaky CSV export")).toContain("fix the flaky CSV export");
  });

  it("escapes HTML that would otherwise cost the whole message", () => {
    expect(buildRepoQuestion("fix <script> & spans")).toContain("&lt;script&gt;");
  });

  it("truncates a very long request rather than risking the send", () => {
    expect(buildRepoQuestion("x".repeat(5000)).length).toBeLessThan(600);
  });
});

describe("repoFromPrompt", () => {
  it("reads the repo back out of the prompt the founder replied to", () => {
    expect(repoFromPrompt(buildRepoPrompt(HULDA))).toBe(HULDA);
  });

  it("round-trips every offered repo", () => {
    for (const choice of repoChoices()) {
      expect(repoFromPrompt(buildRepoPrompt(choice.slug))).toBe(choice.slug);
    }
  });

  it("takes the LAST Repo: line, so quoted text cannot retarget the dispatch", () => {
    // Same reasoning as honouring `repo:` only as the first token of /task: a
    // repository mentioned in passing is not a decision about where work lands.
    const text = `Repo: ${APP}\n\n${buildRepoPrompt(HULDA)}`;
    expect(repoFromPrompt(text)).toBe(HULDA);
  });

  it("returns null for an ordinary message with no prompt in it", () => {
    expect(repoFromPrompt("fix the login button please")).toBeNull();
  });

  it("refuses a repo line naming something off the allowlist", () => {
    expect(repoFromPrompt("Repo: someone-else/private-thing")).toBeNull();
  });
});
