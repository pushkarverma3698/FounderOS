/** scripts/import-answer-doc.ts: a dry run writes nothing; --apply saves through the answer store. Invented candidate. */
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../../..");
const FIXTURE = path.join(root, "tests/fixtures/answer-docs/messy-mira.md");

let dir: string;
let profile: string;
const exec = (...args: string[]) =>
  run("node", ["--import", "tsx/esm", "scripts/import-answer-doc.ts", "wife-nl-finance", FIXTURE, ...args], {
    cwd: root,
    env: { ...process.env, APPLY_PROFILE_PATH: path.join(dir, "apply-profile.json") },
  });

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "import-script-"));
  profile = path.join(dir, "apply-profile-wife-nl-finance.json");
  await fs.writeFile(profile, JSON.stringify({ first_name: "Old", last_name: "Name", email: "old@example.test", phone: "+31 6 0000 0000" }));
});

describe("import-answer-doc script", () => {
  it("dry run lists the writes, hides values, and leaves the profile alone", async () => {
    const before = await fs.readFile(profile, "utf8");
    const { stdout } = await exec();
    expect(stdout).toContain("Will write");
    expect(stdout).toContain("Dry run. Nothing was written.");
    expect(stdout).not.toContain("Fictionlander");
    expect(await fs.readFile(profile, "utf8")).toBe(before);
  }, 60_000);

  it("--apply saves and keeps a backup", async () => {
    const { stdout } = await exec("--apply");
    expect(stdout).toMatch(/Saved \d+ fields/);
    expect(JSON.parse(await fs.readFile(profile, "utf8"))).toMatchObject({ first_name: "Mira", last_name: "Haldane" });
    expect((await fs.readdir(path.join(dir, "answer-backups", "wife-nl-finance"))).length).toBeGreaterThan(0);
  }, 60_000);
});
