/**
 * pr_body_has_moves (deploy/lib/pr-moves.sh) must agree with parseMoves (scripts/verify-pr-scope.ts).
 *
 * The dispatcher adds `Moves: A` to an agent PR whose body has no Moves line, so the PR scope check is not red for a
 * line the agent forgot (#965, 2026-10-06). The bash check is a copy of the CI rule; if the two drift, the dispatcher
 * either leaves a PR red or stacks a second Moves line on one CI already accepts. Each body below runs through both.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { parseMoves } from "../../../scripts/verify-pr-scope.js";

const bashHasMoves = (body: string): boolean => {
  const r = spawnSync("bash", ["-c", "source deploy/lib/pr-moves.sh && pr_body_has_moves"], { input: body, encoding: "utf8" });
  if (r.status !== 0 && r.status !== 1) throw new Error(`pr_body_has_moves exited ${r.status}: ${r.stderr}`);
  return r.status === 0;
};

const BODIES = [
  "",
  "Moves: A",
  "moves:a",
  "  MOVES :  b, c",
  "Moves: crash-fix",
  "Moves: unfreeze",
  "Moves: Z",
  "Moves:",
  "## What changed\n\nx\n\nMoves: D\n",
  "<!-- Moves: A -->\nbody",
  "<!--\nMoves: A\n-->\n\nMoves: B",
  "Moves: | A",
  "Moves: none\nMoves: A",
  "the PR moves: A forward",
  "Removes: A",
];

describe("pr_body_has_moves agrees with the CI check", () => {
  it.each(BODIES)("%j", (body) => {
    expect(bashHasMoves(body)).toBe(parseMoves(body).length > 0);
  });
});
