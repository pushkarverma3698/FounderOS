/**
 * P1/P2 — GitHub failures must fail LOUD with the correct stage tag.
 *
 * The launch-day prod bug: github_read hit a 401 ("Bad credentials" — expired
 * token) and the failure reached the agent as a plain string, which the ReAct
 * loop swallowed/looped on → the founder got NO reply. classifyGithubError maps
 * the raw Octokit error to a structured ToolFailureStage so the gateway can
 * surface it verbatim and point at the real fix (rotate the token), per rule #22.
 */
import { describe, it, expect } from "vitest";
import { classifyGithubError } from "../../../src/agents/agent-tools/engineering.js";

describe("classifyGithubError", () => {
  it("maps 401 / bad credentials to 'auth' (the expired-token class)", () => {
    expect(classifyGithubError("Bad credentials")).toBe("auth");
    expect(classifyGithubError("HttpError: Bad credentials - https://docs.github.com")).toBe("auth");
    expect(classifyGithubError("Request failed with status code 401")).toBe("auth");
  });

  it("maps 403 / token scope / rate-limit-as-auth to 'auth'", () => {
    expect(classifyGithubError("Resource not accessible by personal access token")).toBe("auth");
    expect(classifyGithubError("403 Forbidden")).toBe("auth");
  });

  it("maps connectivity errors to 'network'", () => {
    expect(classifyGithubError("getaddrinfo ENOTFOUND api.github.com")).toBe("network");
    expect(classifyGithubError("connect ETIMEDOUT 140.82.112.3:443")).toBe("network");
  });

  it("maps everything else to 'external_api'", () => {
    expect(classifyGithubError("Not Found")).toBe("external_api");
    expect(classifyGithubError("Validation Failed")).toBe("external_api");
  });
});
