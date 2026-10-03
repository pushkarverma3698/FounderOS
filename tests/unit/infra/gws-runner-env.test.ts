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
});
