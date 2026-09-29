/**
 * The in-memory GoalRepo used by every unit test must meet the same contract as the Postgres one
 * (tests/integration/goals-postgres.test.ts runs this exact contract against real Postgres). If the
 * fake drifts from the real behaviour, a green unit test would be a lie; this is where it shows.
 */

import { randomUUID } from "node:crypto";
import { defineGoalRepoContract } from "../../helpers/goal-repo-contract.js";
import { InMemoryGoalRepo } from "../../helpers/fake-goal-repo.js";

defineGoalRepoContract("in-memory fake", async () => ({
  repo: new InMemoryGoalRepo(),
  tenant: `t-${randomUUID()}`,
}));
