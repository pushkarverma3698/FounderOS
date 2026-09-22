/**
 * FounderOS — pnpm qa:app
 * ========================
 * THE LAST NODE of the dispatch loop: run the real application from a pull
 * request's checkout and look at it in a browser before anyone merges it.
 *
 * Everything before this node was already live — `/task` files the issue,
 * agent-dispatch claims it, Antigravity implements it, pr-brain re-runs the unit
 * gate and audits the diff, and a review finding is re-dispatched to the same
 * branch. What no step did was START the product. On a front-end repository that
 * meant the honest review body read "NOT VERIFIED: the page renders" and cleared
 * the PR anyway, because the protocol's rule is to hand that gap back rather than
 * pretend. This closes it.
 *
 *   pnpm qa:app --dir /opt/review/oplify-messaging-app
 *   pnpm qa:app --dir <checkout> --out .artifacts/app-qa --changed-from origin/main
 *   pnpm qa:app --dir <checkout> --repo OplifyMessage/oplify-messaging-app --vision
 *
 * ## Exit codes are THREE, not two
 *
 *   0  the app booted and nothing blocking was found
 *   1  blocking defects, or the app could not be built/started at all
 *   3  not applicable — no recipe for this repo, or the diff touches nothing it covers
 *
 * A third code exists because 0 would make "this gate did not run" look exactly
 * like "this gate found nothing", and the caller (pr-brain) has to tell those
 * apart to decide whether the review may claim browser verification. Collapsing
 * them is the did-not-run-reads-as-clean failure this repo keeps paying for.
 *
 * ## Cost
 *
 * $0 by default: booting a server and measuring a rendered DOM makes no model
 * call. `--vision` adds the paid screenshot review and is capped upstream by
 * MAX_VISION_IMAGES.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  recipeForRepo,
  recipeIsTriggered,
  recipeTargets,
  annotateExpectedExternal,
  type AppRecipe,
} from "../src/tools/browser/app-recipes.js";
import { bootApp, type BootFailure } from "../src/tools/browser/app-server.js";
import { runUiCheck } from "../src/tools/browser/ui-check.js";
import { renderEvidencePack, type VisionStage } from "../src/tools/browser/evidence-pack.js";
import { rowIsOk, type UiCheckRow } from "../src/tools/browser/ui-analyze.js";
import { closeBrowser, type ViewportName } from "../src/tools/browser/chromium.js";
import { runVision } from "./qa-ui.js";

export const EXIT_CLEAN = 0;
export const EXIT_BLOCKING = 1;
export const EXIT_NOT_APPLICABLE = 3;

const GENERATOR = "pnpm qa:app";
const REFERENCE = "docs/antigravity/APP-QA-NODE.md";

export interface AppCliArgs {
  dir: string;
  repo?: string;
  out?: string;
  port?: number;
  changedFrom?: string;
  changed: string[];
  viewports: ViewportName[];
  vision: boolean;
  skipInstall: boolean;
}

/** PURE arg parsing, exported so the CLI contract is tested without booting anything. */
export function parseAppArgs(argv: readonly string[]): AppCliArgs {
  const args: AppCliArgs = {
    dir: process.cwd(),
    changed: [],
    viewports: [],
    vision: false,
    skipInstall: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dir") args.dir = argv[++i] ?? args.dir;
    else if (arg === "--repo") args.repo = argv[++i];
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--port") args.port = Number(argv[++i]) || undefined;
    else if (arg === "--changed-from") args.changedFrom = argv[++i];
    else if (arg === "--vision") args.vision = true;
    else if (arg === "--skip-install") args.skipInstall = true;
    else if (arg === "--changed") {
      args.changed = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    } else if (arg === "--viewport") {
      const v = argv[++i];
      if (v === "desktop" || v === "mobile") args.viewports.push(v);
    }
  }

  if (args.viewports.length === 0) args.viewports = ["desktop", "mobile"];
  return args;
}

/**
 * `owner/name` from the checkout's origin remote.
 *
 * Returns null rather than throwing: a directory that is not a git repo is a
 * "no recipe" skip with a printed reason, not a crash that produces no report.
 */
export function repoSlugFromCheckout(dir: string): string | null {
  try {
    const remote = execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const match = /(?:github\.com[:/])([^/]+\/[^/.]+)/i.exec(remote);
    return match?.[1] ?? null;
  } catch {
    return null; // allow-failopen: not a git checkout — reported as a skip below.
  }
}

/** Files changed against `base`, or [] when the base is unknown (which means "run it"). */
export function changedFilesSince(dir: string, base: string): string[] {
  try {
    return execFileSync("git", ["-C", dir, "diff", "--name-only", `${base}...HEAD`], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return []; // allow-failopen: an unreadable diff must widen the gate, never narrow it.
  }
}

/** PURE. The context block every pack opens with, whatever the outcome. */
export function renderHeader(recipe: AppRecipe, origin: string | null): string {
  return [
    `## App Evidence Pack — ${recipe.label}`,
    "",
    `Repository: \`${recipe.repo}\``,
    `Started with: \`${recipe.start.join(" ")}\`${origin ? ` → ${origin}` : ""}`,
    `Pages rendered: ${recipe.routes.map((r) => `\`${r.path}\``).join(", ")}`,
    "",
    `> ⚠️ **Coverage.** ${recipe.authNote}`,
    "",
  ].join("\n");
}

/** PURE. What a run that could not start the app tells the reader. */
export function renderBootFailure(recipe: AppRecipe, failure: BootFailure): string {
  return [
    renderHeader(recipe, null),
    `❌ **FAIL — the application could not be ${failure.stage === "build" ? "built" : "started"}.**`,
    "",
    `- 🔴 **boot-${failure.stage}** — ${failure.detail}`,
    "",
    "This is a blocking finding on its own: nothing was rendered, so no page on this branch has",
    "been verified. A reviewer must not read this as an absence of visual defects.",
    "",
    "<details><summary>Command output (tail)</summary>",
    "",
    "```",
    failure.output.trim() || "(no output captured)",
    "```",
    "",
    "</details>",
    "",
    "---",
    `_Generated by \`${GENERATOR}\` — see \`${REFERENCE}\`._`,
  ].join("\n");
}

/** PURE. What a run that was never applicable tells the reader. */
export function renderSkipped(repo: string, reason: string): string {
  return [
    "## App Evidence Pack — SKIPPED",
    "",
    `Repository: \`${repo}\``,
    "",
    `- ⏭️ **SKIPPED** — ${reason}`,
    "- ⚠️ No page on this branch was rendered. This is **not** a clean visual result; it is the",
    "  absence of one.",
    "",
    "---",
    `_Generated by \`${GENERATOR}\` — see \`${REFERENCE}\`._`,
  ].join("\n");
}

function writeOut(out: string | undefined, markdown: string, json: string): void {
  if (!out) return;
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "report.md"), markdown);
  writeFileSync(join(out, "report.json"), json);
  console.log(`\n📦 Evidence pack written to ${out}/report.md`);
}

function finish(out: string | undefined, markdown: string, json: string, code: number): never {
  writeOut(out, markdown, json);
  console.log("\n" + markdown);
  process.exit(code);
}

async function main(): Promise<void> {
  const args = parseAppArgs(process.argv.slice(2));
  const slug = args.repo ?? repoSlugFromCheckout(args.dir);

  if (!slug) {
    finish(
      args.out,
      renderSkipped(args.dir, `\`${args.dir}\` has no readable GitHub origin remote, so no recipe could be chosen.`),
      JSON.stringify({ ran: false, reason: "no-origin-remote" }, null, 2),
      EXIT_NOT_APPLICABLE,
    );
  }

  const recipe = recipeForRepo(slug);
  if (!recipe) {
    finish(
      args.out,
      renderSkipped(
        slug,
        "no app recipe exists for this repository. Add one to `src/tools/browser/app-recipes.ts` " +
          "(install, build, start, port, public routes) and this gate covers it from the next run on.",
      ),
      JSON.stringify({ ran: false, reason: "no-recipe", repo: slug }, null, 2),
      EXIT_NOT_APPLICABLE,
    );
  }

  const changed = args.changedFrom ? changedFilesSince(args.dir, args.changedFrom) : args.changed;
  if (!recipeIsTriggered(recipe, changed)) {
    finish(
      args.out,
      renderSkipped(
        slug,
        `none of the ${changed.length} changed file(s) sit under ${recipe.triggerPaths.join(", ")}, ` +
          "so booting the app would measure code this pull request did not touch.",
      ),
      JSON.stringify({ ran: false, reason: "not-triggered", repo: slug, changed }, null, 2),
      EXIT_NOT_APPLICABLE,
    );
  }

  console.log(`🚀 qa:app — booting ${recipe.label} from ${args.dir}`);
  const boot = await bootApp(recipe, args.dir, {
    ...(args.port ? { port: args.port } : {}),
    skipInstall: args.skipInstall,
  });

  if (!boot.ok) {
    finish(
      args.out,
      renderBootFailure(recipe, boot),
      JSON.stringify({ ran: true, pass: false, boot_failure: boot }, null, 2),
      EXIT_BLOCKING,
    );
  }

  console.log(`✅ serving at ${boot.origin} — rendering ${recipe.routes.length} page(s)`);
  const screenshotDir = args.out ? join(args.out, "screenshots") : undefined;

  let rows: UiCheckRow[];
  try {
    const raw = await runUiCheck({
      targets: recipeTargets(recipe, boot.origin),
      viewports: args.viewports,
      ...(screenshotDir ? { screenshotDir } : {}),
    });
    // The dependencies this gate deliberately did not provide must not be counted
    // as defects in the pull request. Re-labelled, never dropped — and `ok` is
    // recomputed from the re-labelled list so the verdict agrees with the rows a
    // human reads underneath it.
    rows = raw.map((row) => {
      const defects = annotateExpectedExternal(row.defects, recipe.expectedExternal);
      return { ...row, defects, ok: rowIsOk(defects) };
    });
  } finally {
    await boot.stop();
  }

  let stage: VisionStage = { ran: false, skippedReason: "--vision was not requested" };
  if (args.vision) {
    const shots = rows
      .filter((r) => r.screenshotPath)
      .map((r) => ({ target: r.target, viewport: r.viewport, path: r.screenshotPath as string }));
    stage = await runVision(shots);
  }

  const pack = renderEvidencePack(rows, stage, { generator: GENERATOR, reference: REFERENCE });
  await closeBrowser();

  finish(
    args.out,
    `${renderHeader(recipe, boot.origin)}\n${pack.markdown}`,
    pack.json,
    pack.pass ? EXIT_CLEAN : EXIT_BLOCKING,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch(async (err) => {
    console.error("❌ qa:app failed to run:", err);
    await closeBrowser();
    process.exit(EXIT_BLOCKING);
  });
}
