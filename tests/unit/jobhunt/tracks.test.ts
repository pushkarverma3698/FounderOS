/**
 * Unit tests — tracks.ts: the paid search vocabulary vs the free classifier
 * vocabulary (`TRACK_TITLES` vs `TRACK_CLASSIFY_TERMS`).
 *
 * The two lists have opposite economics. `TRACK_TITLES` feeds a metered feed
 * capped at `MIN_ATS_LIMIT` (10) postings per query — widening it dilutes,
 * it does not expand. `TRACK_CLASSIFY_TERMS` only labels a posting already
 * fetched — it is free, so it should be wide. These tests hold both properties:
 * the paid list must not move, and the classifier must now catch titles it
 * previously missed.
 */

import { describe, it, expect } from "vitest";
import {
  TRACK_PRIORITY,
  TRACK_TITLES,
  classifyTrack,
  titlesForTracks,
} from "../../../src/tools/jobhunt/tracks.js";

describe("titlesForTracks stays byte-identical — proof this change is $0", () => {
  it("returns the exact same paid phrases as before this change", () => {
    // Pinned verbatim from TRACK_TITLES so a change to the paid vocabulary
    // (accidental or not) fails this test rather than silently costing money.
    expect(titlesForTracks(TRACK_PRIORITY)).toEqual([
      "AI Engineer:*",
      "AI Developer:*",
      "Machine Learning Engineer:*",
      "LLM Engineer:*",
      "MLOps Engineer:*",
      "GenAI:*",
      "Full Stack:*",
      "Full-Stack:*",
      "Fullstack:*",
      "Founding Engineer:*",
      "Product Engineer:*",
      "Backend Engineer:*",
      "Back End Engineer:*",
      "Backend Developer:*",
      "Software Engineer:*",
      "Software Developer:*",
      "Platform Engineer:*",
      "Data Engineer:*",
      "Node.js Developer:*",
      "Frontend Engineer:*",
      "Front End Engineer:*",
      "Frontend Developer:*",
      "Front End Developer:*",
      "Front-End Developer:*",
      "React Developer:*",
      "React Engineer:*",
      "UI Engineer:*",
    ]);
  });

  it("keeps every track's paid phrase list untouched", () => {
    expect(TRACK_TITLES.ai).toEqual([
      "AI Engineer:*",
      "AI Developer:*",
      "Machine Learning Engineer:*",
      "LLM Engineer:*",
      "MLOps Engineer:*",
      "GenAI:*",
    ]);
    expect(TRACK_TITLES.fullstack).toEqual([
      "Full Stack:*",
      "Full-Stack:*",
      "Fullstack:*",
      "Founding Engineer:*",
      "Product Engineer:*",
    ]);
    expect(TRACK_TITLES.backend).toEqual([
      "Backend Engineer:*",
      "Back End Engineer:*",
      "Backend Developer:*",
      "Software Engineer:*",
      "Software Developer:*",
      "Platform Engineer:*",
      "Data Engineer:*",
      "Node.js Developer:*",
    ]);
    expect(TRACK_TITLES.frontend).toEqual([
      "Frontend Engineer:*",
      "Front End Engineer:*",
      "Frontend Developer:*",
      "Front End Developer:*",
      "Front-End Developer:*",
      "React Developer:*",
      "React Engineer:*",
      "UI Engineer:*",
    ]);
  });
});

describe("classifyTrack recognises free-only title shapes", () => {
  it("classifies the standard India SDE title, which contains no existing phrase", () => {
    // Does NOT contain the substring "software engineer" — "development" sits
    // between the two halves — so the existing "Software Engineer:*" phrase
    // never matched it.
    expect(classifyTrack("Software Development Engineer II")).toBe("backend");
    expect(classifyTrack("SDE")).toBe("backend");
  });

  it("classifies DevOps and SRE titles into backend", () => {
    expect(classifyTrack("DevOps Engineer")).toBe("backend");
    expect(classifyTrack("Senior DevOps")).toBe("backend");
    expect(classifyTrack("Site Reliability Engineer")).toBe("backend");
    expect(classifyTrack("SRE II")).toBe("backend");
  });

  it("classifies cloud, infrastructure and systems titles into backend", () => {
    expect(classifyTrack("Cloud Engineer")).toBe("backend");
    expect(classifyTrack("Infrastructure Engineer")).toBe("backend");
    expect(classifyTrack("Systems Engineer")).toBe("backend");
  });

  it("classifies language-named developer titles into backend", () => {
    expect(classifyTrack("Python Developer")).toBe("backend");
    expect(classifyTrack("Java Developer")).toBe("backend");
    expect(classifyTrack("Golang Developer")).toBe("backend");
    expect(classifyTrack("Go Developer")).toBe("backend");
    expect(classifyTrack("Node Developer")).toBe("backend");
    expect(classifyTrack("API Engineer")).toBe("backend");
  });

  it("classifies web/JS-stack developer titles into frontend", () => {
    expect(classifyTrack("Web Developer")).toBe("frontend");
    expect(classifyTrack("JavaScript Developer")).toBe("frontend");
    expect(classifyTrack("TypeScript Developer")).toBe("frontend");
    expect(classifyTrack("Angular Developer")).toBe("frontend");
    expect(classifyTrack("Vue Developer")).toBe("frontend");
    expect(classifyTrack("UI Developer")).toBe("frontend");
  });

  it("classifies MERN and full stack developer titles into fullstack", () => {
    expect(classifyTrack("Full Stack Developer")).toBe("fullstack");
    expect(classifyTrack("MERN Developer")).toBe("fullstack");
    expect(classifyTrack("MERN Stack Developer")).toBe("fullstack");
  });

  it("classifies ML/AI-adjacent titles into ai", () => {
    expect(classifyTrack("ML Engineer")).toBe("ai");
    expect(classifyTrack("NLP Engineer")).toBe("ai");
    expect(classifyTrack("Computer Vision Engineer")).toBe("ai");
    expect(classifyTrack("Deep Learning Engineer")).toBe("ai");
    expect(classifyTrack("AI/ML Engineer")).toBe("ai");
  });
});

describe("classifyTrack matches recognition terms as whole words only", () => {
  it("does not match an acronym embedded inside an unrelated word", () => {
    // "misdeeds".includes("sde") is true and "misreads".includes("sre") is
    // true — exactly the false positive naive substring matching would cause.
    // Neither title is an engineering role.
    expect(classifyTrack("Warehouse Misdeeds Coordinator")).toBeNull();
    expect(classifyTrack("Misreads Quality Analyst")).toBeNull();
  });

  it("does not match a short developer term embedded inside a longer word", () => {
    // "Golang Developer" matches its own explicit term, not the shorter "go
    // developer" term. "Django Developer" is the false-positive case: naive
    // includes("go developer") is true (Django ends "...ngo developer"), but
    // there is no word boundary between "n" and "go", so it must stay null —
    // there is no "django developer" recognition term.
    expect(classifyTrack("Golang Developer")).toBe("backend");
    expect(classifyTrack("Django Developer")).toBeNull();
  });
});

describe("priority ties still resolve as documented", () => {
  it("keeps 'Full Stack Software Engineer' in fullstack, not backend", () => {
    expect(classifyTrack("Full Stack Software Engineer")).toBe("fullstack");
  });

  it("keeps 'Full Stack Python Developer' in fullstack, not backend", () => {
    // fullstack is checked before backend in TRACK_PRIORITY, and "full stack"
    // already matches via the existing paid phrase before the new "python
    // developer" backend term is ever reached.
    expect(classifyTrack("Full Stack Python Developer")).toBe("fullstack");
  });

  it("still resolves AI over backend in a multi-track title", () => {
    expect(classifyTrack("Backend Engineer / AI Engineer")).toBe("ai");
  });
});

describe("existing classifications are unchanged", () => {
  it("classifies titles that matched before this change exactly as before", () => {
    expect(classifyTrack("AI Engineer")).toBe("ai");
    expect(classifyTrack("Senior Machine Learning Engineer, Platform")).toBe("ai");
    expect(classifyTrack("Backend Engineer (Go)")).toBe("backend");
    expect(classifyTrack("Frontend Engineer — React")).toBe("frontend");
    expect(classifyTrack("Senior Backend Engineer")).toBe("backend");
    expect(classifyTrack("React Developer")).toBe("frontend");
    expect(classifyTrack("Founding Engineer")).toBe("fullstack");
    expect(classifyTrack("Product Engineer")).toBe("fullstack");
    expect(classifyTrack("bAcKeNd EnGiNeEr")).toBe("backend");
  });

  it("still returns null for a genuinely unrelated title", () => {
    expect(classifyTrack("Warehouse Operative")).toBeNull();
    expect(classifyTrack("Product Marketing Manager")).toBeNull();
    expect(classifyTrack("")).toBeNull();
  });
});
