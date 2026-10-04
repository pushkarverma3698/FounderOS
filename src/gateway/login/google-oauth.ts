/**
 * Google OAuth for a headless host: the "installed app" flow with PKCE, finished by pasting the
 * URL the browser lands on. The founder opens the link on his phone, approves, and the browser
 * lands on http://localhost/?code=… (a dead page); he pastes that URL into Telegram. No domain,
 * no HTTPS server, no port forward. Pure functions plus one injected fetch.
 */

import { createHash, randomBytes } from "node:crypto";

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar",
  "openid",
  "email",
] as const;

export interface OAuthClient {
  readonly client_id: string;
  readonly client_secret: string;
  readonly auth_uri: string;
  readonly token_uri: string;
  readonly redirect_uri: string;
}

/** Reads the `installed` block of a Google client_secret.json. Throws a plain message, never the file. */
export function parseClientSecret(json: string): OAuthClient {
  const parsed = JSON.parse(json) as { installed?: Record<string, unknown> };
  const c = parsed.installed;
  const str = (k: string): string => (typeof c?.[k] === "string" ? (c[k] as string) : "");
  const redirect = Array.isArray(c?.["redirect_uris"]) ? String((c["redirect_uris"] as unknown[])[0] ?? "") : "";
  if (!str("client_id") || !str("client_secret") || !redirect) {
    throw new Error("client_secret.json is not a Desktop-app OAuth client (needs an `installed` block)");
  }
  return {
    client_id: str("client_id"),
    client_secret: str("client_secret"),
    auth_uri: str("auth_uri") || "https://accounts.google.com/o/oauth2/auth",
    token_uri: str("token_uri") || "https://oauth2.googleapis.com/token",
    redirect_uri: redirect,
  };
}

export interface AuthAttempt {
  readonly url: string;
  readonly state: string;
  readonly verifier: string;
}

export function buildAuthAttempt(client: OAuthClient, loginHint?: string, rand: (n: number) => Buffer = randomBytes): AuthAttempt {
  const verifier = rand(32).toString("base64url");
  const state = rand(16).toString("base64url");
  const q = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: client.redirect_uri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent", // without it Google omits the refresh token on a repeat grant
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  if (loginHint) q.set("login_hint", loginHint);
  return { url: `${client.auth_uri}?${q.toString()}`, state, verifier };
}

export type ParsedPaste = { ok: true; code: string } | { ok: false; reason: string };

/** Accepts the whole redirect URL (preferred: its state is checked) or the bare code. */
export function parsePaste(pasted: string, expectedState: string): ParsedPaste {
  const text = pasted.trim();
  if (/^https?:\/\//i.test(text)) {
    let u: URL;
    try {
      u = new URL(text);
    } catch {
      return { ok: false, reason: "That is not a complete URL. Copy the whole address from the browser bar." };
    }
    const error = u.searchParams.get("error");
    if (error) return { ok: false, reason: `Google refused the sign-in (${error}). Run /login again.` };
    if (u.searchParams.get("state") !== expectedState) {
      return { ok: false, reason: "That URL belongs to a different login attempt. Use the link from the latest /login message." };
    }
    const code = u.searchParams.get("code");
    return code ? { ok: true, code } : { ok: false, reason: "The URL has no code in it. Copy the address after approving." };
  }
  return /^[\w\-./]{10,}$/.test(text) ? { ok: true, code: text } : { ok: false, reason: "Paste the full URL the browser ended on (starts with http://localhost)." };
}

export interface TokenGrant {
  readonly refresh_token: string;
}

export async function exchangeCode(
  client: OAuthClient,
  code: string,
  verifier: string,
  doFetch: typeof fetch = fetch,
): Promise<{ ok: true; grant: TokenGrant } | { ok: false; reason: string }> {
  const res = await doFetch(client.token_uri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.client_id,
      client_secret: client.client_secret,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: client.redirect_uri,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  // allow-failopen: a non-JSON reply is handled right below as a failed exchange with the HTTP status.
  const body = (await res.json().catch(() => ({}))) as { refresh_token?: string; error?: string; error_description?: string };
  if (!res.ok || !body.refresh_token) {
    const why = body.error === "invalid_grant" ? "the code was already used or expired (codes last a few minutes)" : (body.error ?? `HTTP ${res.status}`);
    return { ok: false, reason: body.refresh_token === undefined && res.ok ? "Google returned no refresh token. Run /login again." : `Google rejected the code: ${why}. Run /login again for a fresh link.` };
  }
  return { ok: true, grant: { refresh_token: body.refresh_token } };
}

/** The authorized_user file gws reads via GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE. */
export function credentialsFileBody(client: OAuthClient, grant: TokenGrant): string {
  return JSON.stringify({ type: "authorized_user", client_id: client.client_id, client_secret: client.client_secret, refresh_token: grant.refresh_token });
}
