/**
 * Telegram Mini App sign-in: verify initData, map the Telegram user to a job profile
 * ===================================================================================
 * The answer page runs inside Telegram, which hands the page `Telegram.WebApp.initData`: the
 * launch parameters signed by the bot that opened the page (core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app):
 *
 *   secret = HMAC_SHA256(key = "WebAppData", msg = BOT_TOKEN)
 *   hash   = hex HMAC_SHA256(key = secret, msg = data_check_string)
 *
 * where the data check string is every field except `hash` as `key=value`, sorted by key, joined
 * with a newline. A valid hash proves Telegram issued the payload to that user; it does not prove
 * the user may touch this application, so the caller also compares the mapped profile with the
 * snapshot's. The user to profile map is the one the jobs bot already uses (JOBHUNT_SENDER_PROFILES),
 * so there is one place that says who is who, and an entry there always wins. One fallback: the
 * founder's private chat id (TELEGRAM_CHAT_ID, a positive integer, equal to his user id) maps to the
 * default profile, so sign-in works where the map is not set. Any other user is rejected, not defaulted.
 *
 * Pure: no I/O, the clock and the environment are arguments.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { resolveJobsBotToken } from "../infra/jobs-bot-token.js";
import { getProfile, resolveProfileToken } from "../tools/jobhunt/profile-config.js";
import { parseSenderProfiles } from "./jobhunt-sender-profile.js";

/** initData older than this is refused: a copied payload stops working within the hour. */
export const INIT_DATA_MAX_AGE_SEC = 60 * 60;
/** A payload from the future by more than this is a clock problem or a forgery. */
const CLOCK_SKEW_SEC = 60;

export type InitDataResult =
  | { readonly ok: true; readonly userId: number; readonly authDate: number }
  | { readonly ok: false; readonly reason: "malformed" | "bad-hash" | "stale" };

export type MiniAppAuth =
  | { readonly ok: true; readonly userId: number; readonly profileId: string }
  | { readonly ok: false; readonly reason: "malformed" | "bad-hash" | "stale" | "no-bot-token" | "unknown-user" };

const HEX_64 = /^[0-9a-f]{64}$/;

function userIdOf(rawUser: string | null): number | null {
  if (!rawUser) return null;
  try {
    const id = (JSON.parse(rawUser) as { id?: unknown }).id;
    return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch {
    // allow-failopen: unparseable user JSON is reported as malformed, which refuses the request.
    return null;
  }
}

/** Checks the signature, the age and the user field. Constant-time compare of the hash. */
export function verifyInitData(initData: string, botToken: string, nowMs: number): InitDataResult {
  if (!initData || initData.length > 8192) return { ok: false, reason: "malformed" };
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash || !HEX_64.test(hash)) return { ok: false, reason: "malformed" };
  params.delete("hash");
  const check = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const want = createHmac("sha256", secret).update(check).digest();
  if (!timingSafeEqual(want, Buffer.from(hash, "hex"))) return { ok: false, reason: "bad-hash" };

  const authDate = Number(params.get("auth_date"));
  const nowSec = Math.floor(nowMs / 1000);
  if (!Number.isSafeInteger(authDate) || authDate <= 0) return { ok: false, reason: "malformed" };
  if (nowSec - authDate > INIT_DATA_MAX_AGE_SEC || authDate - nowSec > CLOCK_SKEW_SEC) return { ok: false, reason: "stale" };
  const userId = userIdOf(params.get("user"));
  if (userId === null) return { ok: false, reason: "malformed" };
  return { ok: true, userId, authDate };
}

/** The founder's private chat id is his Telegram user id: a plain positive integer, never a group (negative) id. */
function isFounder(userId: number, chatId: string | undefined): boolean {
  return chatId !== undefined && /^[1-9]\d*$/.test(chatId) && Number(chatId) === userId;
}

type Env = Readonly<Record<string, string | undefined>>;

/** The profile this Telegram user edits and applies for: the sender map first, then the founder's private chat id. Null for anyone else. */
export function profileForUser(userId: number, env: Env): string | null {
  const profileToken = parseSenderProfiles(env["JOBHUNT_SENDER_PROFILES"]).get(userId);
  if (!profileToken && isFounder(userId, env["TELEGRAM_CHAT_ID"])) return getProfile().id;
  return profileToken ? resolveProfileToken(profileToken) : null;
}

/** The jobs bot's token (the bot that sent the card, so the one that signs initData) and the user to profile map, from `env`. */
export function authenticateMiniApp(header: string | undefined, env: Env, nowMs: number): MiniAppAuth {
  let token: string;
  try {
    token = resolveJobsBotToken(env).token;
  } catch {
    // allow-failopen: no bot token means nobody can be authenticated; the request is refused.
    return { ok: false, reason: "no-bot-token" };
  }
  const verified = verifyInitData(header ?? "", token, nowMs);
  if (!verified.ok) return verified;
  const profileId = profileForUser(verified.userId, env);
  if (!profileId) return { ok: false, reason: "unknown-user" };
  return { ok: true, userId: verified.userId, profileId };
}
