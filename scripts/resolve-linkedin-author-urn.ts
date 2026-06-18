#!/usr/bin/env node
/**
 * Resolve LinkedIn member URN from an OAuth access token (read-only).
 * Usage: node --import tsx/esm scripts/resolve-linkedin-author-urn.ts [token]
 */
const token = process.argv[2] ?? process.env["LINKEDIN_ACCESS_TOKEN"];
if (!token) {
  console.error("Usage: resolve-linkedin-author-urn.ts <access_token>");
  process.exit(1);
}

async function main(): Promise<void> {
  // OpenID userinfo (Share on LinkedIn products)
  const res = await fetch("https://api.linkedin.com/v2/userinfo", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    // Legacy /v2/me fallback
    const legacy = await fetch("https://api.linkedin.com/v2/me", {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Restli-Protocol-Version": "2.0.0",
      },
    });
    if (!legacy.ok) {
      console.error(`LinkedIn API ${res.status}: ${await res.text()}`);
      process.exit(1);
    }
    const body = (await legacy.json()) as { id?: string };
    if (!body.id) {
      console.error("No id in /v2/me response");
      process.exit(1);
    }
    console.log(`urn:li:person:${body.id}`);
    return;
  }
  const info = (await res.json()) as { sub?: string };
  if (!info.sub) {
    console.error("No sub in userinfo response");
    process.exit(1);
  }
  // sub is often the person id; normalize to urn:li:person:
  const sub = info.sub;
  if (sub.startsWith("urn:li:person:")) {
    console.log(sub);
  } else {
    console.log(`urn:li:person:${sub}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
