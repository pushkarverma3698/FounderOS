#!/usr/bin/env node
/**
 * LinkedIn OAuth helper — captures access_token + author URN in one command.
 *
 * Usage:
 *   node --import tsx/esm scripts/linkedin-oauth.ts
 *
 * What it does:
 *   1. Starts a local HTTP server on port 3000 to catch the OAuth callback
 *   2. Prints the LinkedIn auth URL — open it in your browser
 *   3. Sign in with your LinkedIn account (personal OR turicks)
 *   4. Captures the code, exchanges for token, resolves author URN
 *   5. Prints the env vars to paste into .env
 *
 * Requirements:
 *   LINKEDIN_CLIENT_ID  — from LinkedIn Developer Portal → Your App → Auth
 *   LINKEDIN_CLIENT_SECRET  — same place
 *
 *   node --env-file=.env --import tsx/esm scripts/linkedin-oauth.ts
 */

import http from "http";
import { exec } from "child_process";
import { URL } from "url";

const CLIENT_ID = process.env["LINKEDIN_CLIENT_ID"];
const CLIENT_SECRET = process.env["LINKEDIN_CLIENT_SECRET"];
const PORT = 3000;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPES = ["openid", "profile", "email", "w_member_social"].join("%20");
const STATE = `founderos-${Date.now()}`;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    "\n❌ Missing env vars.\n\nRun with:\n" +
      "  LINKEDIN_CLIENT_ID=<id> LINKEDIN_CLIENT_SECRET=<secret> \\\n" +
      "    node --import tsx/esm scripts/linkedin-oauth.ts\n\n" +
      "Get these from: https://www.linkedin.com/developers/apps\n" +
      "  → Your App → Auth tab → Client ID + Client Secret\n"
  );
  process.exit(1);
}

const authUrl =
  `https://www.linkedin.com/oauth/v2/authorization` +
  `?response_type=code` +
  `&client_id=${CLIENT_ID}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&scope=${SCOPES}` +
  `&state=${STATE}`;

console.log("\n🔗 LinkedIn OAuth\n");
console.log(
  "Sign in with the account you want to authorise (personal profile OR turicks).\n"
);
console.log("Opening browser...\n");
console.log(`If it doesn't open, paste this URL manually:\n${authUrl}\n`);

// Try to open browser (macOS)
exec(`open "${authUrl}"`);

const server = http.createServer(async (req, res) => {
  if (!req.url?.startsWith("/callback")) {
    res.end("waiting...");
    return;
  }

  const params = new URL(req.url, `http://localhost:${PORT}`).searchParams;
  const code = params.get("code");
  const returnedState = params.get("state");
  const error = params.get("error");

  if (error) {
    res.end(`<h2>Error: ${error}</h2>`);
    console.error(`\n❌ OAuth error: ${error} — ${params.get("error_description")}`);
    server.close();
    return;
  }

  if (!code || returnedState !== STATE) {
    res.end("<h2>Invalid callback — state mismatch</h2>");
    console.error("\n❌ State mismatch. Possible CSRF. Try again.");
    server.close();
    return;
  }

  // Exchange code for token
  const tokenRes = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID!,
      client_secret: CLIENT_SECRET!,
    }).toString(),
  });

  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    res.end(`<h2>Token exchange failed</h2><pre>${body}</pre>`);
    console.error(`\n❌ Token exchange failed: ${tokenRes.status}\n${body}`);
    server.close();
    return;
  }

  const tokenData = (await tokenRes.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  const accessToken = tokenData.access_token;

  if (!accessToken) {
    res.end("<h2>No access_token in response</h2>");
    console.error("\n❌ No access_token returned");
    server.close();
    return;
  }

  // Resolve URN
  const urnRes = await fetch("https://api.linkedin.com/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  let authorUrn = "";
  if (urnRes.ok) {
    const info = (await urnRes.json()) as {
      sub?: string;
      name?: string;
      email?: string;
    };
    const sub = info.sub ?? "";
    authorUrn = sub.startsWith("urn:li:person:") ? sub : `urn:li:person:${sub}`;
    console.log(`\n✅ Authenticated as: ${info.name ?? "unknown"} (${info.email ?? ""})`);
  }

  const expiresIn = tokenData.expires_in ?? 5184000;
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString().split("T")[0];

  console.log(`\n=== Paste into .env (expires ~${expiresAt}) ===\n`);
  console.log(`LINKEDIN_ACCESS_TOKEN=${accessToken}`);
  if (authorUrn) console.log(`LINKEDIN_AUTHOR_URN=${authorUrn}`);
  console.log(`\n--- OR for personal account ---\n`);
  console.log(`LINKEDIN_ACCESS_TOKEN_PERSONAL=${accessToken}`);
  if (authorUrn) console.log(`LINKEDIN_AUTHOR_URN_PERSONAL=${authorUrn}`);
  console.log("\n===================\n");
  console.log(
    "Now run:\n  ./scripts/setup-prod-linkedin-secrets.sh\nto push these to GitHub Actions secrets.\n"
  );

  res.end(
    `<h2>✅ Done! Token captured.</h2>` +
      `<p>Author URN: <code>${authorUrn}</code></p>` +
      `<p>Token expires: ${expiresAt}</p>` +
      `<p>Close this tab and check your terminal.</p>`
  );

  server.close();
});

server.listen(PORT, () => {
  console.log(`Waiting for LinkedIn callback on http://localhost:${PORT}/callback ...`);
});
