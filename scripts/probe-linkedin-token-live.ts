#!/usr/bin/env node
/** Live LinkedIn token probe — validates OAuth token against API (read-only, no post). */
import { getLinkedInAccessToken, getLinkedInAuthorUrn } from "../src/infra/providers/linkedin-direct.js";

async function main(): Promise<void> {
  const token = getLinkedInAccessToken();
  const urn = getLinkedInAuthorUrn();
  if (!token || !urn) {
    console.error("❌ LINKEDIN_ACCESS_TOKEN or LINKEDIN_AUTHOR_URN not set");
    process.exit(1);
  }

  const res = await fetch("https://api.linkedin.com/v2/userinfo", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    console.error(`❌ LinkedIn token invalid (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
    process.exit(1);
  }

  const info = (await res.json()) as { sub?: string; name?: string };
  console.log(`✅ LinkedIn token valid — author=${urn} user=${info.name ?? info.sub ?? "ok"}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("LinkedIn live probe fatal:", err);
  process.exit(1);
});
