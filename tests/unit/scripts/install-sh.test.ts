/**
 * deploy/install.sh - the input contract, tested without root, apt, docker or a network.
 * ======================================================================================
 * `--check-env` runs only the input step and exits, so these tests exercise the part that must
 * never be wrong: the script refuses, by name, when a required value is missing, and it takes values
 * from an env file without executing them. The install itself (apt, systemd, deploy.sh) needs a
 * fresh Ubuntu box and is not run here.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const INSTALL = join(ROOT, "deploy/install.sh");

const VALID = {
  TELEGRAM_BOT_TOKEN: "dummy-bot-token",
  TELEGRAM_CHAT_ID: "12345",
  GITHUB_TOKEN: "dummy-gh-token",
  OPENROUTER_API_KEY: "dummy-model-key",
};

/** Run install.sh in an otherwise empty environment, so nothing from the developer's shell leaks in. */
function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync("bash", [INSTALL, ...args], {
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", ...env },
    encoding: "utf8",
  });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

describe("deploy/install.sh inputs", () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "install-sh-")); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("documents every input it reads in .env.example", () => {
    const script = readFileSync(INSTALL, "utf8");
    const block = /^INPUT_VARS=\(([^)]*)\)/m.exec(script);
    expect(block, "install.sh lost its INPUT_VARS list").not.toBeNull();
    const names = block![1]!.split(/\s+/).filter(Boolean);
    expect(names.length).toBeGreaterThan(8);
    const example = readFileSync(join(ROOT, ".env.example"), "utf8");
    for (const n of names) expect(example, n + " is read by install.sh but not in .env.example").toMatch(new RegExp("^#?\\s*" + n + "=", "m"));
  });

  it("refuses with exit 2 and names every missing required value", () => {
    const r = run(["--check-env"]);
    expect(r.code).toBe(2);
    for (const n of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "GITHUB_TOKEN", "one model key"]) expect(r.out).toContain(n);
  });

  it("names only what is missing", () => {
    const r = run(["--check-env"], { ...VALID, GITHUB_TOKEN: "" });
    expect(r.code).toBe(2);
    expect(r.out).toContain("GITHUB_TOKEN");
    expect(r.out).not.toContain("TELEGRAM_BOT_TOKEN");
  });

  it("accepts a complete set and picks a default model for an OpenRouter key", () => {
    const r = run(["--check-env"], VALID);
    expect(r.code).toBe(0);
    expect(r.out).toContain("openrouter:openai/gpt-4o-mini");
    expect(r.out).not.toContain("dummy-");
  });

  it("refuses an Anthropic-only key without AGENT_MODEL, and a model whose key is absent", () => {
    const { OPENROUTER_API_KEY: _drop, ...rest } = VALID;
    expect(run(["--check-env"], { ...rest, ANTHROPIC_API_KEY: "dummy" }).code).toBe(2);
    const r = run(["--check-env"], { ...VALID, AGENT_MODEL: "anthropic:some-model" });
    expect(r.code).toBe(2);
    expect(r.out).toContain("ANTHROPIC_API_KEY");
  });

  it("refuses a non-numeric chat id and a relative path", () => {
    expect(run(["--check-env"], { ...VALID, TELEGRAM_CHAT_ID: "abc" }).code).toBe(2);
    expect(run(["--check-env"], { ...VALID, FOUNDEROS_DIR: "relative/dir" }).code).toBe(2);
  });

  it("reads an env file without executing it", () => {
    const marker = join(dir, "executed");
    const file = join(dir, "install.env");
    writeFileSync(file, Object.entries({ ...VALID, GITHUB_TOKEN: `"$(touch ${marker})"` }).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
    const r = run(["--check-env", "--env-file", file]);
    expect(r.code).toBe(0);
    expect(existsSync(marker), "the env file was executed").toBe(false);
  });

  it("lets the environment win over the env file", () => {
    const file = join(dir, "partial.env");
    writeFileSync(file, "TELEGRAM_CHAT_ID=999\nGITHUB_TOKEN=x\nOPENROUTER_API_KEY=x\nTELEGRAM_BOT_TOKEN=x\n");
    expect(run(["--check-env", "--env-file", file], { TELEGRAM_CHAT_ID: "not-a-number" }).code).toBe(2);
  });
});
