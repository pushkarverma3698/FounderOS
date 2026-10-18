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
  applyProfilePathFor,
  readApplyProfile,
  renderApplyProfile,
  setProfileField,
} from "../tools/jobhunt/apply-profile.js";
import {
  buildDefaultDossierMarkdown,
  candidateDossierPathFor,
  readCandidateDossier,
  recordLearnedAnswer,
  writeCandidateDossier,
} from "../tools/jobhunt/candidate-dossier.js";
import { setProfilePath } from "../tools/jobhunt/answer-store.js";
import { childLogger } from "./../infra/logger.js";
import { safeHtml } from "./safe-html.js";
import { isProfileArgMiss, profileMissMessage, resolveProfileArg } from "./jobhunt-profile-arg.js";

const log = childLogger({ module: "gateway:profile-commands" });

export type ProfileCommand =
  | { readonly kind: "show" }
  | { readonly kind: "doc" }
  | { readonly kind: "remember"; readonly question: string; readonly answer: string }
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
  const lowerVerb = verb?.toLowerCase();
  if (lowerVerb === "doc" || lowerVerb === "dossier") {
    return { kind: "doc" };
  }
  if (lowerVerb === "remember" || lowerVerb === "qa") {
    const afterVerb = trimmed.slice(trimmed.toLowerCase().indexOf(lowerVerb) + lowerVerb.length).trim();
    const eqIdx = afterVerb.indexOf("=");
    if (eqIdx <= 0) {
      return { kind: "usage", reason: "`remember` needs `question = answer`." };
    }
    const question = afterVerb.slice(0, eqIdx).trim();
    const answer = afterVerb.slice(eqIdx + 1).trim();
    return question.length > 0 && answer.length > 0
      ? { kind: "remember", question, answer }
      : { kind: "usage", reason: "`remember` needs both a question and an answer separated by `=`." };
  }
  if (lowerVerb !== "set") {
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
  "<b>/profile doc</b> — inspect or initialize the candidate's Reference Dossier &amp; learned Q&amp;A bank.\n" +
  "<b>/profile remember &lt;question&gt; = &lt;answer&gt;</b> — teach a form answer once.\n" +
  "<b>/profile set &lt;field&gt; &lt;value&gt;</b> — change one field.\n\n" +
  "With a second candidate registered, name whose: <code>/profile tashi doc</code>, " +
  "<code>/profile tashi remember Notice period = Immediate</code>.\n\n" +
  "Examples:\n" +
  "<code>/profile set phone +31 6 12345678</code>\n" +
  "<code>/profile remember Expected salary = 65000 EUR</code>\n" +
  "<code>/profile set answers.work_authorization requires-sponsorship</code>";

/** `/profile`, `/profile doc`, `/profile remember Q = A`, `/profile set <field> <value>`. */
export async function handleProfile(ctx: Context): Promise<void> {
  const arg = resolveProfileArg(ctx.match?.toString() ?? "", ["set", "doc", "dossier", "remember", "qa"]);
  if (isProfileArgMiss(arg)) {
    await ctx.reply(safeHtml(profileMissMessage(arg)));
    return;
  }

  const path = applyProfilePathFor(arg.profile.id);
  const who = arg.explicit ? `${arg.profile.candidateName}'s ` : "";
  const command = parseProfileCommand(arg.rest);

  if (command.kind === "usage") {
    await ctx.reply(`${safeHtml(command.reason)}\n\n${USAGE}`, { parse_mode: "HTML" });
    return;
  }

  const current = await readApplyProfile(path);

  if (command.kind === "doc") {
    const docPath = candidateDossierPathFor(arg.profile.id);
    let dossier = await readCandidateDossier(arg.profile.id);
    if (!dossier && current.ok) {
      const seed = buildDefaultDossierMarkdown(current.profile);
      await writeCandidateDossier(arg.profile.id, seed).catch(
        // allow-failopen: read-only preview still works if disk is read-only in tests.
        () => undefined,
      );
      dossier = await readCandidateDossier(arg.profile.id);
    }
    const bank = {
      ...(dossier?.qaPairs ?? {}),
      ...(current.ok ? (current.profile.question_bank ?? {}) : {}),
    };
    const qaEntries = Object.entries(bank);
    const qaPreview =
      qaEntries.length > 0
        ? qaEntries
            .slice(0, 10)
            .map(([k, v]) => `• <code>${safeHtml(k)}</code> → ${safeHtml(String(v))}`)
            .join("\n")
        : "<i>None recorded yet — answers you give during /apply are saved here automatically.</i>";
    await ctx.reply(
      `📄 <b>${safeHtml(arg.profile.candidateName)} — Reference Dossier</b>\n` +
        `File: <code>${safeHtml(docPath)}</code>\n` +
        `Structured facts: <b>${Object.keys(dossier?.facts ?? {}).length}</b> · Learned Q&amp;A: <b>${qaEntries.length}</b>\n\n` +
        `<b>Learned Q&amp;A Bank</b>\n${qaPreview}\n\n` +
        `<i>Add more anytime with:</i> <code>/profile ${arg.explicit ? "tashi " : ""}remember Question = Answer</code>`,
      { parse_mode: "HTML" },
    );
    return;
  }

  if (command.kind === "remember") {
    await recordLearnedAnswer(arg.profile.id, command.question, command.answer);
    log.info({ profileId: arg.profile.id, question: command.question }, "Recorded learned Q&A via /profile remember");
    await ctx.reply(
      `💾 Saved to ${safeHtml(arg.profile.candidateName)}'s dossier &amp; question bank:\n` +
        `<b>${safeHtml(command.question)}</b> → <code>${safeHtml(command.answer)}</code>`,
      { parse_mode: "HTML" },
    );
    return;
  }

  if (command.kind === "show") {
    await ctx.reply(
      current.ok
        ? renderApplyProfile(current.profile)
        : `No usable ${who}apply profile — ${safeHtml(current.reason)}.\n\n` +
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
      `Can't edit — the ${who}profile is unreadable: ${safeHtml(current.reason)}.\n` +
        `Fix ${safeHtml(path)} on the box, or send /profile to see the state.`,
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
  // Saved through the answer store: validated, backed up, written atomically with the dossier Core Facts
  // in step (a profile-only edit of salary or notice period changed nothing a form would read).
  // `/profile set email nonsense` must fail here, where he can retype it, rather than on a form three days later.
  let saved: Awaited<ReturnType<typeof setProfilePath>>;
  try {
    saved = await setProfilePath(arg.profile.id, command.path, command.value);
  } catch (err) {
    await ctx.reply(`Couldn't save the profile: ${safeHtml((err as Error).message)}. Nothing changed.`);
    return;
  }
  if (!saved.ok) {
    await ctx.reply(`That would break the profile — ${safeHtml(saved.reason)}. Nothing was changed.`, { parse_mode: "HTML" });
    return;
  }

  log.info({ profileId: arg.profile.id, field: command.path }, "Apply profile field updated");
  await ctx.reply(
    `✅ ${who}<code>${safeHtml(command.path)}</code> is now <code>${safeHtml(command.value)}</code>.\n\n` +
      `<i>${who ? "Their" : "Your"} Mac picks this up on the next wake, or run the apply client to pull it now.</i>`,
    { parse_mode: "HTML" },
  );
}
