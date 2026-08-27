/**
 * FounderOS — /profile
 * ====================
 * Read and edit the answers every job application form gets filled from.
 *
 * WHY THIS IS A COMMAND AND NOT A FILE HE EDITS. It was a file he edits, and it
 * cost three weeks. `mac-client` refuses to open a browser without
 * `apply-profile.json`, that file was never copied from the example, and the
 * LaunchAgent went on announcing "4 jobs ready" in Telegram every wake while
 * every run died on line one. The founder is on his phone; the fix has to be
 * reachable from there.
 *
 * ZERO-LLM and no kernel turn. Printing a JSON file and setting one key in it
 * are plain state operations with nothing for a model to compose or approve —
 * and routing them through the planner would put a model between the founder
 * and his own contact details.
 */

import type { Context } from "grammy";
import {
  APPLY_PROFILE_PATH,
  parseApplyProfile,
  readApplyProfile,
  renderApplyProfile,
  setProfileField,
  writeApplyProfile,
} from "../tools/jobhunt/apply-profile.js";
import { childLogger } from "./../infra/logger.js";
import { safeHtml } from "./approval-card.js";

const log = childLogger({ module: "gateway:profile-commands" });

export type ProfileCommand =
  | { readonly kind: "show" }
  | { readonly kind: "set"; readonly path: string; readonly value: string }
  | { readonly kind: "usage"; readonly reason: string };

/**
 * Parse the argument of `/profile`.
 *
 * The VALUE KEEPS ITS SPACES. "Amsterdam, North Holland" and "+31 6 12 34 56 78"
 * are both ordinary answers, so only the first token is the field name and
 * everything after it is the value verbatim. Splitting on every space here would
 * silently store "+31" as a phone number.
 */
export function parseProfileCommand(raw: string): ProfileCommand {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { kind: "show" };

  const [verb, ...rest] = trimmed.split(/\s+/);
  if (verb?.toLowerCase() !== "set") {
    return { kind: "usage", reason: `I don't know "${verb}".` };
  }
  if (rest.length < 2) {
    return { kind: "usage", reason: "`set` needs a field and a value." };
  }

  const path = rest[0]!;
  // Slice off the verb and the field from the ORIGINAL string rather than
  // re-joining the split tokens: re-joining collapses runs of spaces, which
  // would quietly rewrite a value the founder typed.
  const afterVerb = trimmed.slice(trimmed.toLowerCase().indexOf("set") + 3).trimStart();
  const value = afterVerb.slice(afterVerb.indexOf(path) + path.length).trim();

  return value.length === 0
    ? { kind: "usage", reason: "`set` needs a value after the field." }
    : { kind: "set", path, value };
}

const USAGE =
  "<b>/profile</b> — show what every application form gets filled from.\n" +
  "<b>/profile set &lt;field&gt; &lt;value&gt;</b> — change one field.\n\n" +
  "Examples:\n" +
  "<code>/profile set phone +31 6 12345678</code>\n" +
  "<code>/profile set answers.years_experience 4</code>\n" +
  "<code>/profile set answers.work_authorization requires-sponsorship</code>";

/** `/profile` and `/profile set <field> <value>`. */
export async function handleProfile(ctx: Context): Promise<void> {
  const command = parseProfileCommand(ctx.match?.toString() ?? "");

  if (command.kind === "usage") {
    await ctx.reply(`${safeHtml(command.reason)}\n\n${USAGE}`, { parse_mode: "HTML" });
    return;
  }

  const current = await readApplyProfile();

  if (command.kind === "show") {
    await ctx.reply(
      current.ok
        ? renderApplyProfile(current.profile)
        : `No usable apply profile — ${safeHtml(current.reason)}.\n\n` +
            `Nothing can fill a form until this exists. Set the four an ATS always asks for:\n` +
            `<code>/profile set first_name …</code>, <code>last_name</code>, <code>email</code>, <code>phone</code>.`,
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
    );
    return;
  }

  // A `set` on an unreadable file is refused rather than treated as a fresh
  // start. Writing `{phone: …}` over a profile that failed to parse would
  // destroy nine good fields to save one, and the founder would find out when a
  // form came back empty.
  if (!current.ok) {
    await ctx.reply(
      `Can't edit — the profile is unreadable: ${safeHtml(current.reason)}.\n` +
        `Fix ${safeHtml(APPLY_PROFILE_PATH)} on the box, or send /profile to see the state.`,
      { parse_mode: "HTML" },
    );
    return;
  }

  const edited = setProfileField(current.raw, command.path, command.value);
  if (!edited.ok) {
    await ctx.reply(`Can't set <code>${safeHtml(command.path)}</code> — ${safeHtml(edited.reason)}.`, {
      parse_mode: "HTML",
    });
    return;
  }

  // RE-VALIDATED BEFORE IT IS WRITTEN. `/profile set email nonsense` must fail
  // in Telegram, where he can retype it, rather than on a form three days later.
  const revalidated = parseApplyProfile(JSON.stringify(edited.next));
  if (!revalidated.ok) {
    await ctx.reply(
      `That would break the profile — ${safeHtml(revalidated.reason)}. Nothing was changed.`,
      { parse_mode: "HTML" },
    );
    return;
  }

  try {
    await writeApplyProfile(edited.next);
  } catch (err) {
    await ctx.reply(`Couldn't save the profile: ${safeHtml((err as Error).message)}. Nothing changed.`);
    return;
  }

  log.info({ field: command.path }, "Apply profile field updated");
  await ctx.reply(
    `✅ <code>${safeHtml(command.path)}</code> is now <code>${safeHtml(command.value)}</code>.\n\n` +
      `<i>Your Mac picks this up on the next wake, or run the apply client to pull it now.</i>`,
    { parse_mode: "HTML" },
  );
}
