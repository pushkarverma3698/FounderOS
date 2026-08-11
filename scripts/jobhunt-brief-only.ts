/** Rebuild today's brief from what is already screened. No fetch, no Apify spend. */
import { buildDailyBrief } from "../src/tools/jobhunt/daily-brief.js";

buildDailyBrief({})
  .then((brief) => console.log(`\n=====BRIEF=====\n${brief}`))
  .catch((err) => {
    console.error("BRIEF FAILED:", err);
    process.exit(1);
  });
