/**
 * The wire format between the bot and the agy login helper (agy-helper.ts).
 *
 * The helper runs as the `antigravity` user, the only user that can run agy, behind a unix socket that only the
 * bot's user can open. One request line (JSON + "\n") gets one response line, then the connection closes.
 * A pasted authorization code travels over this local socket and nowhere else; the token agy issues is written
 * by agy into antigravity's own home and never crosses it.
 */

import type { LoginFinished, LoginTargetStatus } from "./types.js";

export type AgyRequest =
  | { readonly op: "start" }
  | { readonly op: "finish"; readonly session: string; readonly code: string }
  | { readonly op: "dispose"; readonly session: string }
  | { readonly op: "status" }
  | { readonly op: "logout" };

export type AgyResponse =
  | { readonly ok: true; readonly op: "start"; readonly html: string; readonly session: string }
  | { readonly ok: true; readonly op: "finish" | "logout"; readonly finished: Pick<LoginFinished, "ok" | "html" | "ended"> }
  | { readonly ok: true; readonly op: "status"; readonly rows: readonly LoginTargetStatus[] }
  | { readonly ok: true; readonly op: "dispose" }
  | { readonly ok: false; readonly error: string };

/** Largest request line the helper reads: a code is at most 2048 characters. */
export const MAX_REQUEST_BYTES = 4096;

export const DEFAULT_AGY_SOCKET = "/run/agy-login.sock";

export function parseRequest(line: string): AgyRequest | undefined {
  let j: unknown;
  try {
    j = JSON.parse(line);
  } catch {
    // allow-failopen: an unparseable request line is answered with an error, never acted on.
    return undefined;
  }
  if (typeof j !== "object" || j === null) return undefined;
  const r = j as Record<string, unknown>;
  const session = typeof r["session"] === "string" && r["session"].length > 0 && r["session"].length <= 64 ? r["session"] : undefined;
  switch (r["op"]) {
    case "start":
    case "status":
    case "logout":
      return { op: r["op"] };
    case "finish":
      return session && typeof r["code"] === "string" && r["code"].length <= 2048 ? { op: "finish", session, code: r["code"] } : undefined;
    case "dispose":
      return session ? { op: "dispose", session } : undefined;
    default:
      return undefined;
  }
}
