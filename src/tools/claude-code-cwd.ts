/**
 * FounderOS — Claude Code executor workspace resolution.
 * ======================================================
 * Where a Claude Code run is allowed to happen, and nothing else. Extracted from
 * claude-code.ts 2026-09-23 (LOC budget); claude-code.ts re-exports every symbol,
 * so this is a move, not an API change.
 *
 * Two guards live here and must both survive any change: the executor may never
 * run inside the FounderOS repo (it would rewrite the code of the process running
 * it), and every resolved path must stay inside ~/Projects.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { childLogger } from "../infra/logger.js";
import { isProjectPath } from "./project-workflow.js";

const log = childLogger({ module: "tool:claude-code-cwd" });

function home(): string {
  return process.env["HOME"] ?? "/Users/pushkarverma";
}

/** The bot's own repo — git/file mutations here from an agent are forbidden. */
export function founderosRepoPath(): string {
  return join(home(), "Projects/founderos");
}

/** Default isolated workspace for agent tasks. Created on demand. */
export function defaultWorkspace(): string {
  return join(home(), "Projects/agent-workspace");
}

/**
 * Validate and resolve the working directory for a Claude Code run.
 * Returns { ok: true, cwd } or { ok: false, error }.
 */
/**
 * Re-root an absolute path that names a `Projects/` segment under a home
 * directory that is not this host's.
 *
 * 2026-09-22, production: the worker passed
 * `/home/pushkar/Projects/agent-workspace`. The service runs as
 * HOME=/home/founderos and `/home/founderos/Projects/agent-workspace` exists, so
 * a valid request was refused with "Access denied … is outside ~/Projects" and
 * the founder was told the engineering capability was broken.
 *
 * The model cannot know the host's home directory, and the schema never asked it
 * to: "within ~/Projects" names a PROJECT. `/x/y/Projects/<rest>` therefore means
 * `<rest>`, resolved against the real `~/Projects`.
 *
 * Only the LAST `/Projects/` segment is used, and the result still goes through
 * the self-repo refusal and isProjectPath() below — traversal in `<rest>` cannot
 * escape, it simply fails containment as before.
 */
export function rehomeProjectsPath(abs: string, homeDir: string): string {
  const projectsRoot = join(homeDir, "Projects");
  if (abs === projectsRoot || abs.startsWith(`${projectsRoot}/`)) return abs;
  const marker = "/Projects/";
  const at = abs.lastIndexOf(marker);
  if (at < 0) return abs;
  return join(projectsRoot, abs.slice(at + marker.length));
}

export function resolveExecutorCwd(rawCwd?: string | null): { ok: true; cwd: string } | { ok: false; error: string } {
  const target = rawCwd && rawCwd.trim().length > 0
    ? (rawCwd.startsWith("/") ? rawCwd : rawCwd.startsWith("~") ? rawCwd.replace("~", home()) : join(home(), "Projects", rawCwd))
    : defaultWorkspace();
  // Re-root BEFORE the guards, so a foreign-home path is judged by the same rules
  // as a correct one — including the FounderOS self-repo refusal.
  const abs = rehomeProjectsPath(normalize(resolve(target)), home());

  const selfRepo = founderosRepoPath();
  if (abs === selfRepo || abs.startsWith(selfRepo + "/")) {
    return {
      ok: false,
      error:
        "Refused: Claude Code may not run inside the FounderOS repo — the bot must never modify its own " +
        "running code (this corrupted the live process before). FounderOS changes are made by the founder " +
        "directly. Use a different project under ~/Projects, or omit cwd for the agent workspace.",
    };
  }

  if (!isProjectPath(abs) && abs !== join(home(), "Projects")) {
    return { ok: false, error: `Access denied: cwd ${abs} is outside ~/Projects.` };
  }

  if (!existsSync(abs)) {
    mkdirSync(abs, { recursive: true });
    log.info({ cwd: abs }, "Created executor workspace directory");
  }
  return { ok: true, cwd: abs };
}
