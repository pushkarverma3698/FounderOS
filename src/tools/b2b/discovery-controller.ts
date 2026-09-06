// src/tools/b2b/discovery-controller.ts
import { db } from "../../db/client";
import { recruiterLeads } from "./schema";
import { generateDorks } from "./dork-generator";
import { serperSearch } from "./serper-client";
import { scoreCandidate, type ExtractedCandidate } from "./rule-extractor";
import { extractAmbiguousBatch, type AmbiguousItem } from "./llm-batch-extractor";

const ACCEPT_THRESHOLD = 0.85;
const AMBIGUOUS_FLOOR = 0.5;
const BATCH_SIZE = 15;

interface PendingAmbiguous extends AmbiguousItem {
  cleanCompanyName: string;
}

// Runs the deterministic cascade for one company: try each dork in order,
// stop the moment a candidate clears ACCEPT_THRESHOLD. If nothing clears it,
// the best candidate (if any) gets queued for the LLM batch step instead of
// triggering an LLM call right here — batching happens at the caller level.
async function resolveCompany(
  cleanCompanyName: string,
  ambiguousOut: PendingAmbiguous[]
): Promise<ExtractedCandidate | null> {
  const dorks = generateDorks(cleanCompanyName);
  const seenByUrl = new Map<string, ExtractedCandidate>();

  for (const dork of dorks) {
    const response = await serperSearch(dork);
    const organic = response.organic ?? [];
    if (organic.length === 0) continue; // this dork was empty — the next, looser template takes over

    for (const result of organic) {
      const candidate = scoreCandidate(result, cleanCompanyName);
      if (!candidate) continue;

      const existing = seenByUrl.get(candidate.linkedinUrl);
      if (existing) {
        // The same person surfaced via a second, independent dork — that
        // agreement is itself evidence (this is the "+0.1 if multiple
        // results agree" signal from the original brainstorm).
        existing.confidence = Math.min(existing.confidence + 0.1, 1.0);
        existing.evidence.push("confirmed by a second, independent search query");
      } else {
        seenByUrl.set(candidate.linkedinUrl, candidate);
      }

      if (seenByUrl.get(candidate.linkedinUrl)!.confidence >= ACCEPT_THRESHOLD) {
        return seenByUrl.get(candidate.linkedinUrl)!; // early stop — no further dorks, no LLM
      }
    }
  }

  const best = [...seenByUrl.values()].sort((a, b) => b.confidence - a.confidence)[0];
  if (best && best.confidence >= AMBIGUOUS_FLOOR) {
    ambiguousOut.push({
      index: ambiguousOut.length, // placeholder — reset per actual LLM batch, see below
      cleanCompanyName,
      title: best.title ?? "",
      link: best.linkedinUrl,
      snippet: best.evidence.join("; "),
    });
  }

  return null; // below AMBIGUOUS_FLOOR entirely — genuinely nothing findable this way
}

export async function runDiscoveryBatch(companies: string[]) {
  const ambiguous: PendingAmbiguous[] = [];
  const accepted: { company: string; candidate: ExtractedCandidate }[] = [];

  for (const company of companies) {
    const candidate = await resolveCompany(company, ambiguous);
    if (candidate) accepted.push({ company, candidate });
  }

  // Resolve the leftover ambiguous slice in batches of BATCH_SIZE — this is
  // the only place an LLM gets called, and only for the fraction the rule-
  // based pass genuinely couldn't resolve.
  console.log(`\nFound ${ambiguous.length} ambiguous items to evaluate.`);
  console.log(`Raw candidates:`, ambiguous);

  for (let i = 0; i < ambiguous.length; i += BATCH_SIZE) {
    const batch = ambiguous.slice(i, i + BATCH_SIZE).map((item, idx) => ({ ...item, index: idx }));
    const results = await extractAmbiguousBatch(batch);

    for (const result of results) {
      if (!result.name) continue; // the LLM also couldn't confirm a real person — drop it
      const original = batch[result.index];
      accepted.push({
        company: original.cleanCompanyName,
        candidate: {
          name: result.name,
          title: result.title || null,
          linkedinUrl: original.link,
          confidence: result.confidence,
          method: "llm-batch",
          evidence: result.evidence,
        },
      });
    }
  }

  for (const { company, candidate } of accepted) {
    try {
      await db
        .insert(recruiterLeads)
        .values({
          companyName: company,
          personName: candidate.name,
          title: candidate.title,
          linkedinUrl: candidate.linkedinUrl,
          confidenceScore: candidate.confidence,
          method: candidate.method,
          state: "ACCEPTED",
          evidence: candidate.evidence,
        })
        .onConflictDoNothing();
    } catch (e) {
      console.warn(`DB insert failed for ${company}, ignoring.`);
    }
  }

  return accepted;
}
