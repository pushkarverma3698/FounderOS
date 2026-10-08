/**
 * Every commit the bot makes carries the bot's name, whichever Linux user ran git, so GitHub history shows which work
 * an agent did. deploy/lib/gh-token.sh sets it where it sets the token: gh_token_load for the daemon's own process,
 * gh_shell_prelude for the sudo'd antigravity shell.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const LIB = fileURLToPath(new URL("../../../deploy/lib/gh-token.sh", import.meta.url));
let dir: string;
let envFile: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gh-ident-"));
  envFile = join(dir, "env");
  writeFileSync(envFile, "GITHUB_TOKEN=ghp_fake\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const bash = (script: string, extra: Record<string, string> = {}) =>
  spawnSync("bash", ["-c", script], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", HOME: dir, GIT_CONFIG_GLOBAL: "/dev/null", ...extra } });

describe("bot git identity", () => {
  it("gh_token_load exports the bot as author and committer, and a commit carries it", () => {
    const r = bash(
      `source '${LIB}'; gh_token_load '${envFile}' && cd '${dir}' && git init -q && echo x >f && git add f && git commit -q -m t && git log -1 --format='%an <%ae> | %cn <%ce>'`,
    );
    expect(r.stdout.trim()).toBe("FounderOS Bot <founderos-bot@users.noreply.github.com> | FounderOS Bot <founderos-bot@users.noreply.github.com>");
  });

  it("FOS_GIT_NAME and FOS_GIT_EMAIL override it, and the sudo'd shell prelude carries the same identity", () => {
    const r = bash(
      `source '${LIB}'; gh_shell_prelude > '${dir}/pre.sh'; echo ghp_x | bash -c 'source '"'${dir}/pre.sh'"'; echo "$GIT_AUTHOR_NAME|$GIT_COMMITTER_EMAIL"'`,
      { FOS_GIT_NAME: "Acme Agent", FOS_GIT_EMAIL: "12345+acme-agent@users.noreply.github.com" },
    );
    expect(r.stdout.trim()).toBe("Acme Agent|12345+acme-agent@users.noreply.github.com");
  });
});
