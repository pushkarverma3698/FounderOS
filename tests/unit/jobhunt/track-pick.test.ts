import { describe, expect, it } from "vitest";
import { loadTrackCvs } from "../../../src/tools/jobhunt/track-pick.js";
import { checkPdfText } from "../../../src/tools/jobhunt/pdf-check.js";
import type { JobSearchProfile } from "../../../src/tools/jobhunt/profile-config.js";

const profile = {
  id: "other",
  tracks: { ai: { cvPath: "/cv/ai.md" }, backend: { cvPath: "/cv/backend.md" }, frontend: {} },
} as unknown as JobSearchProfile;

describe("loadTrackCvs", () => {
  it("reads only each track's own CV, skips unreadable or path-less tracks, never the shared master", () => {
    const seen: string[] = [];
    const read = (_t: string, paths: readonly string[]) => {
      seen.push(...paths);
      return paths[0] === "/cv/ai.md" ? ({ ok: true, text: "AI CV", source: "cv", path: "/cv/ai.md" } as const) : ({ ok: false, error: "missing" } as const);
    };
    expect(loadTrackCvs(profile, read as never)).toEqual([{ track: "ai", text: "AI CV" }]);
    expect(seen).toEqual(["/cv/ai.md", "/cv/backend.md"]);
  });
});

describe("checkPdfText", () => {
  const md = "# Pushkar Verma\n\n## SUMMARY\n\nx\n\n## SKILLS\n\nTypeScript";
  it("passes when name, headings and matched skills are present, ignoring case and spacing", () => {
    expect(checkPdfText("PUSHKAR   VERMA\nSummary x\nSkills\nTypeScript", md, ["TypeScript"])).toBeNull();
  });
  it("names what is missing", () => {
    expect(checkPdfText("Summary Skills TypeScript", md, ["TypeScript"])).toMatch(/name/);
    expect(checkPdfText("Pushkar Verma Skills TypeScript", md, ["TypeScript"])).toMatch(/heading "summary"/);
    expect(checkPdfText("Pushkar Verma Summary Skills", md, ["TypeScript"])).toMatch(/skill "TypeScript"/);
  });
});
