import { JobApplicationOperator } from "../src/services/jobhunt/application-operator.js";
import { childLogger } from "../src/infra/logger.js";
import * as path from "node:path";
import * as fs from "node:fs";

const log = childLogger({ module: "scripts:dry-run-operator" });

async function main() {
  log.info("Starting Autonomous Job Application Operator (DRY RUN MODE)");
  
  const artifactDir = path.resolve(process.cwd(), ".data/operator-artifacts");
  if (!fs.existsSync(artifactDir)) {
    fs.mkdirSync(artifactDir, { recursive: true });
  }

  // Create operator in dry run mode
  const operator = new JobApplicationOperator(artifactDir, true);

  // Poll tasks (in a real scenario this would loop, for a dry-run we just process one)
  log.info("Polling application_tasks for a QUEUED or READY job...");
  await operator.runNext();
  
  log.info("Dry run complete.");
  process.exit(0);
}

main().catch((err) => {
  log.error({ err }, "Dry run failed");
  process.exit(1);
});
