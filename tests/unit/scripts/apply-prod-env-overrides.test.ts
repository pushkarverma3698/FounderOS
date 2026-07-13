/**
 * Renderer preservation contract — scripts/apply-prod-env-overrides.sh.
 * =======================================================================
 * 2026-07-12 incident: the post-#325 deploy re-rendered .env from a stale
 * PROD_DOTENV and WIPED on-box-provisioned keys (APIFY_TOKEN, STORAGE_BUCKET,
 * AWS_* — S3 went LIVE→MISSING between the 00:23 and 00:30 boots) because they
 * were not in PRESERVE_IF_MISSING. Separately, a present-but-EMPTY key in the
 * snapshot (GWS_BIN=) overrode a working box value and crashed every gws probe
 * with execFile(""). Both behaviors are pinned here by running the real script.
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../../scripts/apply-prod-env-overrides.sh", import.meta.url));

/** Run the real renderer in a temp APP_DIR; returns the rendered .env text. */
function render(boxEnv: string, snapshot: string, extraEnv: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "prod-env-render-"));
  writeFileSync(join(dir, ".env"), boxEnv);
  execFileSync("bash", [SCRIPT], {
    env: {
      PATH: process.env["PATH"] ?? "",
      APP_DIR: dir,
      PROD_DOTENV: Buffer.from(snapshot).toString("base64"),
      ...extraEnv,
    },
  });
  return readFileSync(join(dir, ".env"), "utf8");
}

/** Value the runtime would see — node --env-file gives the LAST occurrence. */
const valueOf = (env: string, key: string): string | undefined =>
  env
    .split("\n")
    .filter((l) => l.startsWith(`${key}=`))
    .at(-1)
    ?.slice(key.length + 1);

const countOf = (env: string, key: string): number =>
  env.split("\n").filter((l) => l.startsWith(`${key}=`)).length;

const SNAPSHOT_BASE = "DATABASE_URL=postgres://snapshot/db\n";

describe("apply-prod-env-overrides.sh — on-box provisioning survives a render", () => {
  it("preserves on-box APIFY_TOKEN and SCRAPE_BACKEND absent from PROD_DOTENV", () => {
    const rendered = render(
      "APIFY_TOKEN=apify_box_value\nSCRAPE_BACKEND=apify\n",
      SNAPSHOT_BASE,
    );
    expect(valueOf(rendered, "APIFY_TOKEN")).toBe("apify_box_value");
    expect(valueOf(rendered, "SCRAPE_BACKEND")).toBe("apify");
  });

  it("preserves on-box S3 delivery keys (STORAGE_BUCKET/AWS_*) absent from PROD_DOTENV", () => {
    const rendered = render(
      [
        "STORAGE_BUCKET=founder-os-creative-agent-workspace",
        "AWS_ACCESS_KEY_ID=AKIABOX",
        "AWS_SECRET_ACCESS_KEY=box-secret",
        "STORAGE_ENDPOINT_URL=https://s3.example",
        "",
      ].join("\n"),
      SNAPSHOT_BASE,
    );
    expect(valueOf(rendered, "STORAGE_BUCKET")).toBe("founder-os-creative-agent-workspace");
    expect(valueOf(rendered, "AWS_ACCESS_KEY_ID")).toBe("AKIABOX");
    expect(valueOf(rendered, "AWS_SECRET_ACCESS_KEY")).toBe("box-secret");
    expect(valueOf(rendered, "STORAGE_ENDPOINT_URL")).toBe("https://s3.example");
  });

  it("treats a present-but-EMPTY snapshot key as missing (GWS_BIN= must not clobber the box)", () => {
    const rendered = render(
      "GWS_BIN=/home/founderos/.local/bin/gws\n",
      SNAPSHOT_BASE + "GWS_BIN=\n",
    );
    expect(valueOf(rendered, "GWS_BIN")).toBe("/home/founderos/.local/bin/gws");
    expect(countOf(rendered, "GWS_BIN"), "no stale empty duplicate survives").toBe(1);
  });

  it("keeps preserving the on-box TELEGRAM_TESTER_SESSION over the snapshot copy", () => {
    const rendered = render(
      "TELEGRAM_TESTER_SESSION=box-session\n",
      SNAPSHOT_BASE + "TELEGRAM_TESTER_SESSION=stale-session\n",
    );
    expect(valueOf(rendered, "TELEGRAM_TESTER_SESSION")).toBe("box-session");
  });

  it("still pins the production model and free fallbacks", () => {
    const rendered = render("", SNAPSHOT_BASE + "AGENT_MODEL=something-else\n");
    expect(valueOf(rendered, "AGENT_MODEL")).toBe("google-genai:gemini-flash-latest");
    expect(valueOf(rendered, "AGENT_FALLBACK_MODELS")).toContain(":free");
  });

  it("preserves on-box MCP_BRIDGE_ENABLED absent from PROD_DOTENV", () => {
    const rendered = render("MCP_BRIDGE_ENABLED=true\n", SNAPSHOT_BASE);
    expect(valueOf(rendered, "MCP_BRIDGE_ENABLED")).toBe("true");
  });

  it("forwards LANGCHAIN_API_KEY from the GitHub secret and pins tracing on", () => {
    const rendered = render("", SNAPSHOT_BASE, { LANGCHAIN_API_KEY: "lsv2_pt_test_value" });
    expect(valueOf(rendered, "LANGCHAIN_API_KEY")).toBe("lsv2_pt_test_value");
    expect(valueOf(rendered, "LANGCHAIN_TRACING_V2")).toBe("true");
  });

  it("does not touch LangSmith vars when LANGCHAIN_API_KEY secret is absent", () => {
    const rendered = render("", SNAPSHOT_BASE);
    expect(valueOf(rendered, "LANGCHAIN_API_KEY")).toBeUndefined();
    expect(valueOf(rendered, "LANGCHAIN_TRACING_V2")).toBeUndefined();
  });
});
