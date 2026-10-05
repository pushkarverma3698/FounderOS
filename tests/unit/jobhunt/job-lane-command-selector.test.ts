/**
 * A job message that goes to the shared jobs group must suggest commands that act on the right queue.
 *
 * Unqualified `/draft j3a9f2c1`, `/jobs`, `/csv`, `/replied 2` and `/rejected 2` resolve to the default profile
 * (resolveProfileArg, jobhunt-profile-arg.ts). Before JOBHUNT_CHAT_ID the second candidate's alerts went to
 * the founder's private chat and he knew whose they were. In the group, she taps what the alert prints, so
 * the alert has to name her: `/draft tashi j3a9f2c1`. The check below runs every printed command through the real
 * command parser and asks which profile it resolves to.
 */

import { describe, it, expect } from "vitest";
import { resolveProfileArg, isProfileArgMiss } from "../../../src/gateway/jobhunt-profile-arg.js";
import { DEFAULT_PROFILE_ID, getProfile, listProfiles, profileSelector } from "../../../src/tools/jobhunt/profile-config.js";
import {
  afterQuietSweep,
  formatBackfillLine,
  formatNewRowsAlert,
  initialHeartbeat,
  ALIVE_PING_INTERVAL_MS,
} from "../../../src/tools/jobhunt/sweep-heartbeat.js";
import { formatFollowupNudge, formatPipelineDigest } from "../../../src/tools/jobhunt/pipeline-followup.js";
import { dedupeKey } from "../../../src/tools/jobhunt/filters.js";
import type { IngestLine } from "../../../src/tools/jobhunt/ingest-batch.js";
import type { JobApplication } from "../../../src/db/schema.js";

const DEFAULT = getProfile(DEFAULT_PROFILE_ID);
const SECOND = listProfiles().find((p) => p.id !== DEFAULT_PROFILE_ID)!;

const roleLine: IngestLine = {
  company: "Adyen",
  title: "Analyst",
  outcome: "pass",
  detail: "every check cleared",
  isNew: true,
  postedAt: new Date("2026-09-08T10:00:00Z"),
  url: "https://example.com/role",
};
const ids = new Map([[dedupeKey(roleLine.company, roleLine.title), "j3a9f2c1"]]);

const application = {
  id: "11111111-1111-1111-1111-111111111111",
  tenant_id: "turicks",
  company: "Ockto",
  title: "Engineer",
  stage: "applied",
  applied_at: new Date("2026-08-18T12:00:00Z"),
  last_contact_at: new Date("2026-08-18T12:00:00Z"),
  followups_sent: 0,
} as JobApplication;

/** Every `/command args` the message prints, as typed: tags stripped, entities decoded, placeholders dropped. */
function printedCommands(html: string): string[] {
  const text = html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  return [...text.matchAll(/(\/(?:draft|jobs|csv|replied|rejected))((?:\s+(?!j[0-9a-f]{7}\b)[a-z][\w-]*)?(?:\s+(?:\d+|j[0-9a-f]{7}))?)/g)].map((m) => m[0].trim());
}

/** The profile a printed command would act on, through the same resolver the Telegram handlers call. */
function resolvesTo(command: string): string {
  const [, ...args] = command.split(/\s+/);
  const picked = resolveProfileArg(args.join(" "), ["all"]);
  if (isProfileArgMiss(picked)) throw new Error(`${command} does not resolve: ${picked.unknown}`);
  return picked.profile.id;
}

describe("profileSelector", () => {
  it("is empty for the default profile, whose queue a bare command reaches", () => {
    expect(profileSelector(DEFAULT)).toBe("");
  });

  it("is a word the command parser resolves back to the same profile", () => {
    const selector = profileSelector(SECOND);
    expect(selector).not.toBe("");
    const picked = resolveProfileArg(`${selector} 3`, ["all"]);
    expect(isProfileArgMiss(picked)).toBe(false);
    if (!isProfileArgMiss(picked)) expect(picked.profile.id).toBe(SECOND.id);
  });
});

describe("the second candidate's pushed messages name her in every command", () => {
  const second = profileSelector(SECOND);
  const messages: Array<[string, string]> = [
    ["new-roles alert", formatNewRowsAlert([roleLine], null, SECOND.candidateName, { ids, selector: second })],
    ["backfill line", formatBackfillLine(4, SECOND.candidateName, second)],
    [
      "alive ping",
      afterQuietSweep(initialHeartbeat(new Date(0)), 10, null, new Date(ALIVE_PING_INTERVAL_MS + 1), null, SECOND).ping ?? "",
    ],
    ["pipeline digest", formatPipelineDigest([application], new Date("2026-08-25T12:00:00Z"), SECOND)],
    ["follow-up nudge", formatFollowupNudge(application, 1, new Date("2026-08-25T12:00:00Z"), SECOND)],
  ];

  it.each(messages)("%s prints at least one command, and each one acts on her queue", (_name, message) => {
    const commands = printedCommands(message);
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) expect(resolvesTo(command)).toBe(SECOND.id);
  });
});

describe("the default candidate's messages are unchanged: bare commands", () => {
  it("prints no selector", () => {
    const alert = formatNewRowsAlert([roleLine], null, DEFAULT.candidateName, { ids, selector: profileSelector(DEFAULT) });
    expect(alert).toContain("<code>/draft j3a9f2c1</code>");
    expect(alert).toContain("→ /jobs for the ranked list · /csv for the file · /draft &lt;n&gt; to apply");
    const digest = formatPipelineDigest([application], new Date("2026-08-25T12:00:00Z"), DEFAULT);
    expect(printedCommands(digest)).toEqual(["/replied 1", "/rejected 1"]);
  });
});
