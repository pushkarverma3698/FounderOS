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
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../../scripts/apply-prod-env-overrides.sh", import.meta.url));

/** Run the real renderer in a temp APP_DIR; returns the rendered .env text. */
function render(boxEnv: string, snapshot: string, extraEnv: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "prod-env-render-"));
  writeFileSync(join(dir, ".env"), boxEnv);
  // The renderer asks tailscale for the node name (APPLY_LINK_BASE_URL). A stub that reports "not running"
  // keeps these tests off the host's real tailnet, and fast on a machine that has the Tailscale CLI.
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "tailscale"), `#!/bin/sh\necho '{"BackendState":"Stopped"}'\n`);
  chmodSync(join(bin, "tailscale"), 0o755);
  execFileSync("bash", [SCRIPT], {
    env: {
      PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      APP_DIR: dir,
      PROD_DOTENV: Buffer.from(snapshot).toString("base64"),
      ...extraEnv,
    },
    stdio: "pipe",
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

  it("still pins the production model and stable fallbacks", () => {
    const rendered = render("", SNAPSHOT_BASE + "AGENT_MODEL=something-else\n");
    expect(valueOf(rendered, "AGENT_MODEL")).toBe("openrouter:google/gemini-3.8-flash");
    expect(valueOf(rendered, "AGENT_FALLBACK_MODELS")).toContain("openrouter:nvidia/nemotron-3-super-120b-a12b:free");
  });

  it("pins the measured worker and per-role pools (docs/sessions/2026-10-04-model-pools.md), replacing stale copies", () => {
    const rendered = render(
      "WORKER_AGENT_MODEL=\n",
      SNAPSHOT_BASE + "WORKER_AGENT_MODEL=\nPLANNER_FALLBACK_MODELS=stale\n",
    );
    expect(valueOf(rendered, "WORKER_AGENT_MODEL")).toBe("openrouter:inclusionai/ling-3.0-flash");
    expect(valueOf(rendered, "WORKER_FALLBACK_MODELS")).toBe(
      "openrouter:nvidia/nemotron-3-super-120b-a12b:free",
    );
    expect(valueOf(rendered, "PLANNER_FALLBACK_MODELS")).toBe(
      "openrouter:nvidia/nemotron-3-super-120b-a12b:free",
    );
    for (const k of ["WORKER_AGENT_MODEL", "WORKER_FALLBACK_MODELS", "PLANNER_FALLBACK_MODELS"]) {
      expect(countOf(rendered, k), `${k} has no stale duplicate`).toBe(1);
    }
    expect(valueOf(rendered, "AGENT_MODEL"), "planner primary").toBe("openrouter:google/gemini-3.8-flash");
  });

  it("pins the per-run budget for the heavy model, replacing stale copies", () => {
    const rendered = render("", SNAPSHOT_BASE + "RUN_BUDGET_USD=0.5\nRUN_BUDGET_TOKENS=100000\n");
    expect(valueOf(rendered, "RUN_BUDGET_USD")).toBe("1.5");
    expect(valueOf(rendered, "RUN_BUDGET_TOKENS")).toBe("400000");
    for (const k of ["RUN_BUDGET_USD", "RUN_BUDGET_TOKENS"]) {
      expect(countOf(rendered, k), `${k} has no stale duplicate`).toBe(1);
    }
  });

  it("keeps no direct Google model: the AI Studio prepay key returned 402 on 2026-10-08", () => {
    const rendered = render("", SNAPSHOT_BASE);
    for (const k of ["AGENT_MODEL", "AGENT_FALLBACK_MODELS", "JUDGE_MODEL", "WORKER_AGENT_MODEL"]) {
      expect(valueOf(rendered, k), k).not.toContain("google-genai:");
    }
  });

  it("drops the withdrawn minimax slug from the shared fallback chain", () => {
    const rendered = render("", SNAPSHOT_BASE);
    expect(valueOf(rendered, "AGENT_FALLBACK_MODELS")).not.toContain("minimax");
    expect(valueOf(rendered, "AGENT_FALLBACK_MODELS")).toContain("openrouter:nvidia/nemotron-3-super-120b-a12b:free");
  });

  it("pins the judge model, overriding any stale snapshot value", () => {
    const rendered = render("", SNAPSHOT_BASE + "JUDGE_MODEL=something-else\n");
    expect(valueOf(rendered, "JUDGE_MODEL")).toBe("openrouter:google/gemini-3.1-flash-lite");
    expect(countOf(rendered, "JUDGE_MODEL"), "no stale duplicate survives").toBe(1);
  });

  it("preserves on-box MCP_BRIDGE_ENABLED absent from PROD_DOTENV", () => {
    const rendered = render("MCP_BRIDGE_ENABLED=true\n", SNAPSHOT_BASE);
    expect(valueOf(rendered, "MCP_BRIDGE_ENABLED")).toBe("true");
  });

  it("preserves an on-box GEMINI_THINKING_LEVEL absent from PROD_DOTENV — the rollback lever survives a deploy", () => {
    // DEFAULT restores Google's dynamic thinking if LOW ever costs plan
    // quality. A lever the next deploy silently wipes back to LOW is no lever.
    const rendered = render("GEMINI_THINKING_LEVEL=DEFAULT\n", SNAPSHOT_BASE);
    expect(valueOf(rendered, "GEMINI_THINKING_LEVEL")).toBe("DEFAULT");
  });

  it("preserves the on-box Telegram group access lists — the founder's wife is answered after every deploy", () => {
    // 2026-09-29: chat and user ids stay out of the public repo and the snapshot;
    // without preservation the next deploy silently locks the family group out again.
    const rendered = render(
      "TELEGRAM_ALLOWED_CHAT_IDS=-100111\nTELEGRAM_ANSWER_ALL_CHAT_IDS=-100111,-100222\nTELEGRAM_OWNER_USER_ID=4242\n",
      SNAPSHOT_BASE,
    );
    expect(valueOf(rendered, "TELEGRAM_ALLOWED_CHAT_IDS")).toBe("-100111");
    expect(valueOf(rendered, "TELEGRAM_ANSWER_ALL_CHAT_IDS")).toBe("-100111,-100222");
    expect(valueOf(rendered, "TELEGRAM_OWNER_USER_ID")).toBe("4242");
  });

  it("preserves the on-box JOBHUNT_CHAT_ID — job messages keep going to the family jobs group after every deploy", () => {
    // 2026-10-02: a chat id stays out of the public repo and the snapshot, like the access lists above.
    // Without preservation the next deploy silently moves every job message back to the founder's private chat.
    const rendered = render("JOBHUNT_CHAT_ID=-100333\n", SNAPSHOT_BASE);
    expect(valueOf(rendered, "JOBHUNT_CHAT_ID")).toBe("-100333");
  });

  it("preserves the on-box AGENT_PIPELINE_V2 and ORACLE_ALLOWED_HOSTS — the pipeline switch survives every deploy", () => {
    // 2026-10-06: the deploy of #941 re-rendered .env and dropped both, switching the coding pipeline off
    // right after the founder turned it on. They are founder-set on the box, so they are not in the snapshot.
    const rendered = render("AGENT_PIPELINE_V2=1\nORACLE_ALLOWED_HOSTS=app.example.test\n", SNAPSHOT_BASE);
    expect(valueOf(rendered, "AGENT_PIPELINE_V2")).toBe("1");
    expect(valueOf(rendered, "ORACLE_ALLOWED_HOSTS")).toBe("app.example.test");
  });

  it("preserves the on-box AGENT_DISPATCH_BIN — a filed issue starts in seconds, not at the next cron tick", () => {
    const rendered = render("AGENT_DISPATCH_BIN=/home/founderos/bin/agent-dispatch\n", SNAPSHOT_BASE);
    expect(valueOf(rendered, "AGENT_DISPATCH_BIN")).toBe("/home/founderos/bin/agent-dispatch");
  });

  it("forwards LANGCHAIN_API_KEY from the GitHub secret and pins tracing on", () => {
    const rendered = render("", SNAPSHOT_BASE, { LANGCHAIN_API_KEY: "lsv2_pt_test_value" });
    expect(valueOf(rendered, "LANGCHAIN_API_KEY")).toBe("lsv2_pt_test_value");
    expect(valueOf(rendered, "LANGCHAIN_TRACING_V2")).toBe("true");
  });

  it("forwards OPENROUTER_API_KEY with stray invisible characters stripped (2026-10-04: a pasted U+2028 made every call 401)", () => {
    const key = "sk-or-v1-" + "ab12".repeat(16);
    const rendered = render("", SNAPSHOT_BASE, { OPENROUTER_API_KEY: `${key}\u2028 \r` });
    expect(valueOf(rendered, "OPENROUTER_API_KEY")).toBe(key);
    expect(countOf(rendered, "OPENROUTER_API_KEY")).toBe(1);
  });

  it("does not touch LangSmith vars when LANGCHAIN_API_KEY secret is absent", () => {
    const rendered = render("", SNAPSHOT_BASE);
    expect(valueOf(rendered, "LANGCHAIN_API_KEY")).toBeUndefined();
    expect(valueOf(rendered, "LANGCHAIN_TRACING_V2")).toBeUndefined();
  });
});

describe("apply-prod-env-overrides.sh — apply link defaults (APPLY_LINK_BASE_URL / APPLY_LINK_SECRET)", () => {
  const HOST = "turicks-dots.taile5afc3.ts.net";
  const STATUS_OK = { BackendState: "Running", Self: { DNSName: `${HOST}.`, CapMap: { funnel: null, https: null } } };

  /** Runs the real renderer with a stub `tailscale` first on PATH; returns the .env and everything the run printed. */
  function renderWithTailscale(boxEnv: string, snapshot: string, status: unknown = STATUS_OK) {
    const dir = mkdtempSync(join(tmpdir(), "prod-env-apply-link-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "tailscale"), `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(status)}\nJSON\n`);
    chmodSync(join(bin, "tailscale"), 0o755);
    const app = join(dir, "app");
    mkdirSync(app);
    writeFileSync(join(app, ".env"), boxEnv);
    const r = spawnSync("bash", [SCRIPT], {
      env: {
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
        APP_DIR: app,
        PROD_DOTENV: Buffer.from(snapshot).toString("base64"),
      },
      encoding: "utf8",
    });
    return { code: r.status, printed: `${r.stdout}\n${r.stderr}`, env: readFileSync(join(app, ".env"), "utf8") };
  }

  it("adds the public base URL from the tailscale DNS name (trailing dot stripped) and a 64-hex secret, once each", () => {
    const { code, env } = renderWithTailscale("", SNAPSHOT_BASE);
    expect(code).toBe(0);
    expect(valueOf(env, "APPLY_LINK_BASE_URL")).toBe(`https://${HOST}`);
    expect(valueOf(env, "APPLY_LINK_SECRET")).toMatch(/^[0-9a-f]{64}$/);
    expect(countOf(env, "APPLY_LINK_BASE_URL")).toBe(1);
    expect(countOf(env, "APPLY_LINK_SECRET")).toBe(1);
  });

  it("never prints the secret: not to stdout, not to stderr", () => {
    const { env, printed } = renderWithTailscale("", SNAPSHOT_BASE);
    const secret = valueOf(env, "APPLY_LINK_SECRET") ?? "";
    expect(secret).toHaveLength(64);
    expect(printed).not.toContain(secret);
    expect(printed).toContain("APPLY_LINK_SECRET generated");
  });

  it("keeps the on-box values across a PROD_DOTENV render that lacks them, and a second render keeps the same secret", () => {
    const first = renderWithTailscale("", SNAPSHOT_BASE).env;
    const secret = valueOf(first, "APPLY_LINK_SECRET");
    // The next deploy renders a snapshot that never carries the keys; the box values must survive it.
    const second = renderWithTailscale(first, SNAPSHOT_BASE, { BackendState: "Stopped" }).env;
    expect(valueOf(second, "APPLY_LINK_SECRET")).toBe(secret);
    expect(valueOf(second, "APPLY_LINK_BASE_URL")).toBe(`https://${HOST}`);
    expect(countOf(second, "APPLY_LINK_SECRET")).toBe(1);
    expect(countOf(second, "APPLY_LINK_BASE_URL")).toBe(1);
  });

  it("never overwrites values that are already set", () => {
    const { env } = renderWithTailscale(
      "APPLY_LINK_BASE_URL=https://custom.example\nAPPLY_LINK_SECRET=founder-chosen-value\n",
      SNAPSHOT_BASE,
    );
    expect(valueOf(env, "APPLY_LINK_BASE_URL")).toBe("https://custom.example");
    expect(valueOf(env, "APPLY_LINK_SECRET")).toBe("founder-chosen-value");
  });

  it("a snapshot value wins over generation, and a present-but-EMPTY one counts as missing", () => {
    const set = renderWithTailscale("", SNAPSHOT_BASE + "APPLY_LINK_SECRET=from-snapshot\n").env;
    expect(valueOf(set, "APPLY_LINK_SECRET")).toBe("from-snapshot");
    const empty = renderWithTailscale("", SNAPSHOT_BASE + "APPLY_LINK_SECRET=\nAPPLY_LINK_BASE_URL=\n").env;
    expect(valueOf(empty, "APPLY_LINK_SECRET")).toMatch(/^[0-9a-f]{64}$/);
    expect(valueOf(empty, "APPLY_LINK_BASE_URL")).toBe(`https://${HOST}`);
    expect(countOf(empty, "APPLY_LINK_SECRET"), "no stale empty duplicate").toBe(1);
    expect(countOf(empty, "APPLY_LINK_BASE_URL"), "no stale empty duplicate").toBe(1);
  });

  it("when tailscale cannot name the node: the render still succeeds, the URL stays unset, the secret is still created, and it says why", () => {
    const { code, env, printed } = renderWithTailscale("", SNAPSHOT_BASE, { BackendState: "Stopped" });
    expect(code).toBe(0);
    expect(valueOf(env, "APPLY_LINK_BASE_URL")).toBeUndefined();
    expect(valueOf(env, "APPLY_LINK_SECRET")).toMatch(/^[0-9a-f]{64}$/);
    expect(printed).toContain("APPLY_LINK_BASE_URL not set");
    expect(valueOf(env, "DATABASE_URL"), "the rest of the render is intact").toBe("postgres://snapshot/db");
  });
});
