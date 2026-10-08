import { describe, expect, it } from "vitest";
import { gwsEnv } from "../../../src/infra/gws-runner.js";

describe("gwsEnv — which credentials the gws CLI actually reads", () => {
  it("points gws 0.22 at the account's own credentials file (it ignores GWS_CONFIG_HOME)", () => {
    const env = gwsEnv({ HOME: "/h" }, "/h/.founderos/accounts/personal/gws", () => true);
    expect(env["GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE"]).toBe("/h/.founderos/accounts/personal/gws/credentials.json");
  });

  it("falls back to the host's default login when the account has no credentials file yet", () => {
    const env = gwsEnv({ HOME: "/h" }, "/h/.founderos/accounts/personal/gws", () => false);
    expect(env["GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE"]).toBeUndefined();
  });

  it("does not let an inherited credentials path leak one account's login into another's call", () => {
    const base = { GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE: "/other/credentials.json" };
    expect(gwsEnv(base, "/d", () => false)["GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE"]).toBeUndefined();
  });

  it("leaves the environment alone when no profile dir is given", () => {
    const base = { A: "1" };
    expect(gwsEnv(base, undefined, () => true)).toEqual(base);
  });

  /**
   * Regression for 2026-10-08 prod: `/login google add work` saved pushkar@oplify.in, but the bot replied
   * "signed in as pushkarai3698@gmail.com". gws caches access tokens in its config dir, not per credentials
   * file, so with every account on the one global dir, whichever token was cached first answered for all.
   */
  it("gives each signed-in account its own gws config dir, so token caches are not shared", () => {
    const env = gwsEnv({ HOME: "/h" }, "/h/.founderos/accounts/work/gws", () => true);
    expect(env["GOOGLE_WORKSPACE_CLI_CONFIG_DIR"]).toBe("/h/.founderos/accounts/work/gws");
  });

  it("drops an inherited config dir for an account with no file, so it cannot read another account's cache", () => {
    const base = { GOOGLE_WORKSPACE_CLI_CONFIG_DIR: "/h/.founderos/accounts/work/gws" };
    expect(gwsEnv(base, "/d", () => false)["GOOGLE_WORKSPACE_CLI_CONFIG_DIR"]).toBeUndefined();
  });
});
