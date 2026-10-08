/**
 * .env.example must name every environment variable that src/ and deploy/ read.
 * ==============================================================================
 * A friend self-hosting FounderOS (docs/SELF-HOST.md) has one document to learn what the process
 * reads: .env.example. A variable that code reads and the file does not list is invisible to them,
 * and shows up as a feature that silently does nothing.
 *
 * What counts as "read":
 *   src/     process.env.NAME, process.env["NAME"], intEnv("NAME"), boolEnv("NAME"), a key of the
 *            Zod envSchema in src/core/config.ts, and const X_ENV = "NAME" / X_FLAG = "NAME" names.
 *   deploy/  ${NAME} or $NAME in a shell script that no script under deploy/ assigns (so shell
 *            locals are not mistaken for configuration), every ${NAME:-default}, and every key a
 *            script greps out of the rendered .env.
 *
 * "Listed" means a line `NAME=` or `# NAME=` in .env.example. Runtime-only variables that the
 * operating system, the shell, systemd or the test runner provide are the allowlist below; nothing
 * else belongs in it.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const RUNTIME_ONLY = new Set([
  "HOME", "PATH", "PWD", "TMPDIR", "RANDOM", "BASH_SOURCE", "BASH_REMATCH", "VITEST",
  "LISTEN_FDS", "LISTEN_PID", // systemd socket activation (deploy/systemd/*.socket)
]);

function walk(dir: string, keep: (file: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules") continue;
    if (statSync(p).isDirectory()) out.push(...walk(p, keep));
    else if (keep(p)) out.push(p);
  }
  return out;
}

const NAME = "[A-Z][A-Z0-9_]*";
const re = (body: string, flags = "g") => new RegExp(body.split("@N").join(NAME), flags);

type Reads = Map<string, string>;

/** Every variable name src/ reads, with the first file that reads it. */
export function envNamesReadBySrc(): Reads {
  const found: Reads = new Map();
  const note = (name: string, file: string) => { if (!found.has(name)) found.set(name, relative(ROOT, file)); };
  for (const file of walk(join(ROOT, "src"), (f) => f.endsWith(".ts"))) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(re("process\\.env\\.(@N)\\b"))) note(m[1]!, file);
    for (const m of text.matchAll(re("process\\.env\\[\\s*[\"'](@N)[\"']\\s*\\]"))) note(m[1]!, file);
    for (const m of text.matchAll(re("\\b(?:intEnv|boolEnv)\\(\\s*[\"'](@N)[\"']"))) note(m[1]!, file);
    for (const m of text.matchAll(re("\\bconst @N_(?:ENV|FLAG|ENV_VAR)\\s*=\\s*[\"'](@N)[\"']"))) note(m[1]!, file);
  }
  const config = join(ROOT, "src/core/config.ts");
  for (const m of readFileSync(config, "utf8").matchAll(re("^ {2}(@N): z\\.", "gm"))) note(m[1]!, config);
  return found;
}

/** Every variable name the deploy/ shell scripts read from their environment. */
export function envNamesReadByDeploy(): Reads {
  const files = walk(join(ROOT, "deploy"), (f) => {
    const head = readFileSync(f, "utf8").slice(0, 80);
    return f.endsWith(".sh") || head.startsWith("#!/usr/bin/env bash") || head.startsWith("#!/bin/bash");
  });
  const assigned = new Set<string>();
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    // NAME=value anywhere (line start, after ; && || or another assignment), unless the value is the
    // variable's own env default: X="${X:-3}" reads the environment, it does not define a local.
    for (const m of text.matchAll(re("(?<![\\w$.-])(@N)=(?=([^\\n]{0,80}))"))) {
      if (!m[2]!.replace(/^["']/, "").startsWith("${" + m[1]!)) assigned.add(m[1]!);
    }
    for (const m of text.matchAll(re("\\b(?:local|for|read(?: -\\w+)*) (@N)\\b"))) assigned.add(m[1]!);
  }
  const reads: Reads = new Map();
  const note = (name: string, file: string) => { if (!reads.has(name)) reads.set(name, relative(ROOT, file)); };
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(re("\\$\\{?(@N)\\b"))) if (!assigned.has(m[1]!)) note(m[1]!, file);
    for (const m of text.matchAll(re("grep -[a-zA-Z]+ ['\"]\\^(@N)="))) note(m[1]!, file);
  }
  return reads;
}

/** Names in .env.example, set or commented out. */
export function namesListedInEnvExample(): Set<string> {
  const listed = new Set<string>();
  for (const m of readFileSync(join(ROOT, ".env.example"), "utf8").matchAll(re("^#?\\s*(@N)=", "gm"))) listed.add(m[1]!);
  return listed;
}

describe(".env.example completeness", () => {
  const listed = namesListedInEnvExample();

  it("lists every variable src/ reads", () => {
    const missing = [...envNamesReadBySrc()].filter(([n]) => !listed.has(n) && !RUNTIME_ONLY.has(n));
    expect(missing.map(([n, f]) => n + "  (read in " + f + ")"), "add each to .env.example with a one-line comment").toEqual([]);
  });

  it("lists every variable deploy/ scripts read", () => {
    const missing = [...envNamesReadByDeploy()].filter(([n]) => !listed.has(n) && !RUNTIME_ONLY.has(n));
    expect(missing.map(([n, f]) => n + "  (read in " + f + ")"), "add each to .env.example with a one-line comment").toEqual([]);
  });

  it("does not list a runtime-only variable as configuration", () => {
    for (const name of RUNTIME_ONLY) expect(listed.has(name), name + " is runtime-only; remove it from .env.example").toBe(false);
  });

  it("holds no real-looking secret", () => {
    const text = readFileSync(join(ROOT, ".env.example"), "utf8");
    expect(text).not.toMatch(/\bsk-[A-Za-z0-9_-]{20,}/);
    expect(text).not.toMatch(/\bgh[pousr]_[A-Za-z0-9]{30,}/);
    expect(text).not.toMatch(/\bAIza[0-9A-Za-z_-]{30,}/);
    expect(text).not.toMatch(/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/);
  });
});
