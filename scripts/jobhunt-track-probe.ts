/**
 * ONE live actor run per track, single pool, to answer one question:
 * is the frontend/backend drought a property of the market or of the request?
 * Costs three actor runs. Not part of any automated path.
 */
import { fetchAtsPostings, POOL_QUERIES } from "../src/tools/jobhunt/ats-source.js";
import { TRACK_TITLES, TRACK_PRIORITY } from "../src/tools/jobhunt/tracks.js";
import { isEarlyCareerTitle } from "../src/tools/jobhunt/seniority.js";

for (const track of TRACK_PRIORITY) {
  const r = await fetchAtsPostings({
    ...POOL_QUERIES["netherlands"], titles: TRACK_TITLES[track], timeRange: "7d", limit: 10,
  });
  if (!r.ok) { console.log(`${track.toUpperCase()}: FETCH FAILED — ${r.error}`); continue; }
  const kept = r.postings.filter((p) => !isEarlyCareerTitle(p.title));
  console.log(`\n${track.toUpperCase()} — ${r.postings.length} returned, ${kept.length} after seniority filter`);
  for (const p of kept.slice(0, 6)) console.log(`   · ${p.company} — ${p.title}`);
}
