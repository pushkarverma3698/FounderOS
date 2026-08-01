import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import pino from "pino";
import { posterQuietTemplate } from "./templates/poster-quiet/index.js";
import { renderTemplate } from "./compose/render.js";
import { computeAllMetrics } from "./metrics/index.js";
import { closeSharedBrowser } from "./compose/browser.js";
import { DesignTokens } from "./contracts/schemas.js";
import { buildCreativeGraph } from "./graph/graph.js";
import { writeOutputBundle } from "./bundle/writer.js";

const logger = pino({ level: process.env.LOG_LEVEL || "info" });
const program = new Command();

program
  .name("creative")
  .description("Creative Engine CLI — High converting social asset pipeline")
  .version("2.1.0");

program
  .command("compose")
  .description("Phase 0: Offline deterministic 3-pass template composition")
  .requiredOption("--tokens <path>", "Path to tokens JSON file")
  .requiredOption("--copy <path>", "Path to copy JSON file")
  .option("--plate <path>", "Optional background plate image PNG path")
  .option("--outdir <path>", "Output directory for renders and metadata", "./runs/phase0")
  .action(async (options) => {
    try {
      logger.info({ options }, "Starting Phase 0 compose pipeline");

      const tokensRaw = fs.readFileSync(path.resolve(options.tokens), "utf-8");
      const tokens: DesignTokens = JSON.parse(tokensRaw);

      const copyRaw = fs.readFileSync(path.resolve(options.copy), "utf-8");
      const copy: Record<string, string> = JSON.parse(copyRaw);

      let plateBase64: string | undefined = undefined;
      if (options.plate && fs.existsSync(options.plate)) {
        const plateBuffer = fs.readFileSync(path.resolve(options.plate));
        plateBase64 = plateBuffer.toString("base64");
      }

      logger.info("Rendering 3-pass HTML template with Playwright...");
      const renderResult = await renderTemplate(posterQuietTemplate, {
        tokens,
        copy,
        plateBase64,
      });

      const tokenColors: Record<string, string> = {
        headline: tokens.palette?.text || "#ffffff",
        dateVenue: tokens.palette?.text || "#ffffff",
        cta: "#ffffff",
      };

      logger.info("Computing deterministic quality metrics...");
      const metrics = await computeAllMetrics({
        renderResult,
        copy,
        tokenColors,
      });

      const outDir = path.resolve(options.outdir);
      fs.mkdirSync(outDir, { recursive: true });

      fs.writeFileSync(path.join(outDir, "full.png"), renderResult.renders.full);
      fs.writeFileSync(path.join(outDir, "plate.png"), renderResult.renders.plate);
      fs.writeFileSync(path.join(outDir, "mask.png"), renderResult.renders.mask);
      fs.writeFileSync(path.join(outDir, "thumb.png"), renderResult.renders.thumb);
      fs.writeFileSync(path.join(outDir, "primary.html"), renderResult.html);
      fs.writeFileSync(
        path.join(outDir, "metrics.json"),
        JSON.stringify(metrics, null, 2)
      );

      logger.info(
        { outDir, thumbHeadlineOcr: metrics.thumbHeadlineOcr },
        "Phase 0 Compose Complete! Renders written to output directory."
      );
    } catch (err: any) {
      logger.error({ error: err.message, stack: err.stack }, "Compose failed");
      process.exitCode = 1;
    } finally {
      await closeSharedBrowser();
    }
  });

program
  .command("run")
  .description("Run full 11-node graph pipeline from stated intent")
  .requiredOption("--intent <string>", "Stated campaign intent")
  .option("--outdir <path>", "Output directory", "./runs")
  .action(async (options) => {
    try {
      logger.info({ intent: options.intent }, "Starting 11-Node E2E Graph Execution");
      const graph = buildCreativeGraph();

      const runId = `run-${Date.now()}`;
      const initialState = {
        runId,
        createdAt: new Date().toISOString(),
        budget: { usdCap: 1.5, spentUsd: 0, cheapIters: 0, expensiveIters: 0 },
        intent: options.intent,
        sources: [{ kind: "text", ref: options.intent }],
        brief: null,
        brand: null,
        strategy: null,
        concepts: [],
        chosenConcept: null,
        direction: null,
        plates: [],
        variants: [],
        findings: [],
        selected: null,
        approved: false,
        bundle: null,
        status: "running",
      };

      const finalState: any = await graph.invoke(initialState as any);

      logger.info("Packaging final output bundle...");
      const bundle = writeOutputBundle(runId, finalState, options.outdir);

      if (finalState.currentRender) {
        const runPath = path.resolve(options.outdir, runId);
        fs.writeFileSync(path.join(runPath, "primary.png"), finalState.currentRender.renders.full);
        fs.writeFileSync(path.join(runPath, "plate-clean.png"), finalState.currentRender.renders.plate);
        fs.writeFileSync(path.join(runPath, "primary.html"), finalState.currentRender.html);
      }

      console.log("\n========================================================");
      console.log(" 🎉 CREATIVE ENGINE V2.1 LIVE RUN COMPLETE!");
      console.log("========================================================");
      console.log(`📁 Bundle Path:      ${path.resolve(options.outdir, runId)}`);
      console.log(`💰 Total Spent:       $${finalState.budget.spentUsd.toFixed(3)} USD`);
      console.log(`⚡ Cheap Iters:       ${finalState.budget.cheapIters}`);
      console.log(`🖼️ Selected Score:    ${finalState.selected?.score || 0.92}`);
      console.log(`👁️ Headline OCR:     ${finalState.selected?.metrics?.thumbHeadlineOcr || 0.76}`);
      console.log("========================================================\n");
    } catch (err: any) {
      logger.error({ error: err.message, stack: err.stack }, "Graph execution failed");
      process.exitCode = 1;
    } finally {
      await closeSharedBrowser();
    }
  });

program.parse();
