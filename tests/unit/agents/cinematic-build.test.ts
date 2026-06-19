import { describe, it, expect } from "vitest";
import {
  parseCinematicBuildRequest,
  resolveCinematicBuildParams,
  slugFromClient,
  buildCinematicPipelineDirective,
  isValidCinematicPreset,
} from "../../../src/agents/cinematic-build.js";

describe("cinematic-build", () => {
  it("parses client, preset, showcase slug, and deploy intent", () => {
    const parsed = parseCinematicBuildRequest(
      "Build a cinematic landing page for AgentOps using the neon preset. Deploy to showcase-1.",
    );
    expect(parsed.client).toBe("AgentOps");
    expect(parsed.preset).toBe("neon");
    expect(parsed.slug).toBe("showcase-1");
    expect(parsed.deploy).toBe(true);
  });

  it("slugFromClient normalizes names", () => {
    expect(slugFromClient("AgentOps")).toBe("agentops");
    expect(slugFromClient("  Langfuse Inc ")).toBe("langfuse-inc");
  });

  it("resolveCinematicBuildParams applies overrides", () => {
    const params = resolveCinematicBuildParams("build landing", {
      client: "VectorDB",
      preset: "glass",
      slug: "showcase-2",
      deploy: true,
    });
    expect(params).toEqual({
      client: "VectorDB",
      preset: "glass",
      slug: "showcase-2",
      deploy: true,
    });
  });

  it("buildCinematicPipelineDirective includes all three pipeline steps when deploy=true", () => {
    const directive = buildCinematicPipelineDirective({
      client: "AgentOps",
      preset: "neon",
      slug: "showcase-1",
      deploy: true,
    });
    expect(directive).toMatch(/apply_cinematic_preset/);
    expect(directive).toMatch(/claude_code/);
    expect(directive).toMatch(/deploy_static_site/);
    expect(directive).toContain("showcase-1");
  });

  it("validates preset names", () => {
    expect(isValidCinematicPreset("neon")).toBe(true);
    expect(isValidCinematicPreset("bogus")).toBe(false);
  });
});
