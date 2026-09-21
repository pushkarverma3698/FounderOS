import { db } from "../src/db/client.js";
import { jobApplications } from "../src/db/schema.js";
import { eq, desc, and, isNotNull } from "drizzle-orm";
import { getProfile } from "../src/tools/jobhunt/profile-config.js";

// Mock tailorCv to instantly fail so we can test the Base CV fallback

import { buildApplicationPacket } from "../src/tools/jobhunt/apply-packet.js";

async function qaDraftForProfile(profileId?: string) {
  const profile = getProfile(profileId);
  console.log(`\n=== QA Testing /draft for ${profile.candidateName} ===`);
  
  const rows = await db.select()
    .from(jobApplications)
    .where(
      and(
        profileId ? eq(jobApplications.profile_id, profileId) : undefined,
        eq(jobApplications.stage, "screened"),
        isNotNull(jobApplications.brief_rank)
      )
    )
    .orderBy(desc(jobApplications.brief_rank))
    .limit(1);

  if (!rows || rows.length === 0) {
    console.log(`No screened jobs found for ${profile.candidateName} to test.`);
    return;
  }

  const job = rows[0]!;
  if (!job) return;
  console.log(`Found job: ${job.company} - ${job.title} (ID: ${job.id})`);

  console.log("Running buildApplicationPacket...");
  const artifactDir = "./artifacts/qa-test";
  const result = await buildApplicationPacket(job, artifactDir);

  if (result.ok) {
    console.log("✅ Packet built successfully!");
    console.log(`PDF Path: ${result.packet.pdfPath}`);
    console.log(`Apply URL: ${result.packet.applyUrl}`);
    console.log(`CV Markdown Length: ${result.packet.cvMarkdown.length} chars`);
  } else {
    console.error("❌ Packet build failed!");
    console.error(`Reason: ${result.reason}`);
  }
}

async function main() {
  await qaDraftForProfile(); // Pushkar (default)
  await qaDraftForProfile("wife-nl-finance"); // Tashi
  process.exit(0);
}

main().catch(console.error);
