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
    // developer" term. The boundary case this guards is that naive
    // includes("go developer") is ALSO true of "Django Developer" (it ends
    // "...ngo developer"), so a substring match would reach backend by the
    // wrong route entirely.
    expect(classifyTrack("Golang Developer")).toBe("backend");

    // Django itself became a backend QUALIFIER on 2026-08-20, so this title is
    // now backend deliberately — it is a Python web framework and the role is
    // squarely in track. What must still hold is that it gets there through
    // "django", not through a boundary-less "go developer" match: a title with
    // the same trailing letters and no framework in it stays null.
    expect(classifyTrack("Django Developer")).toBe("backend");
    expect(classifyTrack("Flamingo Handler")).toBeNull();
    expect(classifyTrack("Cargo Coordinator")).toBeNull();
  });

  it("matches terms whose own edges are punctuation, which \\b cannot see", () => {
    // `\bc#\b` never matches "C# Developer" (no word boundary after "#") and
    // `\b\.net\b` never matches ".NET Developer" (none before the dot). Both
    // were silently unmatchable before the boundary rule was rewritten.
    expect(classifyTrack("C# Developer")).toBe("backend");
    expect(classifyTrack("Senior .NET Developer")).toBe("backend");
    expect(classifyTrack("ASP.NET Developer")).toBe("backend");
    expect(classifyTrack("C++ Engineer")).toBe("backend");
  });
});

describe("a generic software title never outranks a specific one", () => {
  // The defect this fixes, measured on production 2026-08-20: 228 backend rows
  // against 10 frontend, because "Software Engineer" sat inside the BACKEND
  // phrase list and backend is checked before frontend. Every frontend role
  // that spelled itself "… Software Engineer" was filed as backend, and the
  // track decides which of the four CVs `/draft` tailors.
  it("reads a qualified 'Software Engineer' as the track that qualifies it", () => {
    expect(classifyTrack("Frontend Software Engineer")).toBe("frontend");
    expect(classifyTrack("Senior Software Engineer, Frontend")).toBe("frontend");
    expect(classifyTrack("Backend Software Engineer")).toBe("backend");
    expect(classifyTrack("Full Stack Software Engineer")).toBe("fullstack");
    expect(classifyTrack("Software Engineer, Machine Learning")).toBe("ai");
  });

  it("still reads an UNqualified software title as backend, as it always did", () => {
    expect(classifyTrack("Software Engineer")).toBe("backend");
    expect(classifyTrack("Senior Software Engineer")).toBe("backend");
    expect(classifyTrack("Software Developer")).toBe("backend");
  });

  it("keeps the gerund classifying, so leadership titles are not lost silently", () => {
    // Eight live titles ("Software Engineering Manager", "Manager, Software
    // Engineering") used to reach backend through the substring "software
    // engineer". They are very likely rejected by the experience gate — but it
    // must be the GATE that rejects them, on a stored row with a reason, not
    // the classifier dropping them where nothing can report it.
    expect(classifyTrack("Software Engineering Manager, Database")).toBe("backend");
    expect(classifyTrack("Manager, Software Engineering")).toBe("backend");
  });
});

describe("classifyTrack catches the title shapes measured as missing", () => {
  // Every case below was counted in a 4,412-posting sample of the live free
  // registry on 2026-08-20 and classified as NOTHING — fetched, then discarded
  // before screening with only a counter to show for it.
  it("classifies '<language> Engineer', not just '<language> Developer'", () => {
    expect(classifyTrack("Senior Python Engineer, DataFeed Team")).toBe("backend");
    expect(classifyTrack("Staff Java Engineer (Backend)")).toBe("backend");
    expect(classifyTrack("Rust Developer")).toBe("backend");
    expect(classifyTrack("Senior Kotlin Engineer")).toBe("backend");
  });

  it("classifies seniority-only engineering titles", () => {
    expect(classifyTrack("Staff Engineer")).toBe("backend");
    expect(classifyTrack("Principal Engineer")).toBe("backend");
    expect(classifyTrack("Forward Deployed Engineer")).toBe("backend");
  });

  it("classifies data-science and research titles into ai", () => {
    expect(classifyTrack("Senior Data Scientist")).toBe("ai");
    expect(classifyTrack("Machine Learning Researcher")).toBe("ai");
    expect(classifyTrack("Research Engineer")).toBe("ai");
  });

  it("classifies the singular 'System Engineer', which the plural missed", () => {
    expect(classifyTrack("System Engineer (Compute Node)")).toBe("backend");
    expect(classifyTrack("Systems Engineer")).toBe("backend");
  });

  it("classifies Dutch-language titles, now that the registry polls Recruitee", () => {
    expect(classifyTrack("Software Ontwikkelaar")).toBe("backend");
    expect(classifyTrack("Ontwikkelaar")).toBe("backend");
  });

  it("classifies framework-named engineer titles into frontend", () => {
    expect(classifyTrack("React Native Engineer")).toBe("frontend");
    expect(classifyTrack("JavaScript Engineer (Open Source Team)")).toBe("frontend");
    expect(classifyTrack("Senior ReactJS Engineer")).toBe("frontend");
    expect(classifyTrack("Web Engineer")).toBe("frontend");
  });

  it("classifies a lead title generically rather than not at all", () => {
    // "lead" is deliberately NOT a role noun — as one it pulled in "AI
    // Deployment Lead, Hedge Funds" and "AI Business Consulting Lead". So a
    // tech-lead title lands in the generic bucket instead of its framework's
    // track. Classified-in-the-wrong-track is recoverable; dropped is not.
    expect(classifyTrack("Tech Lead (Angular), New York")).toBe("backend");
    expect(classifyTrack("Technical Lead")).toBe("backend");
  });
});

describe("widening the classifier did not widen it into non-engineering roles", () => {
  // The 42 "Solutions Architect" postings in that same sample are pre-sales
  // roles ("Manager, Solutions Architect - India", "Insurance Solutions
  // Architect"). Adding cloud-vendor names or a bare "cloud" qualifier would
  // have swept every one of them in, which is why they are absent by name.
  it("refuses customer-facing architect titles", () => {
    expect(classifyTrack("Solutions Architect")).toBeNull();
    expect(classifyTrack("AWS Solutions Architect")).toBeNull();
    expect(classifyTrack("Senior Enterprise Security Architect")).toBeNull();
  });

  it("refuses engineering disciplines that are not software", () => {
    expect(classifyTrack("Senior Electrical Engineer")).toBeNull();
    expect(classifyTrack("Mechanical Design Engineer")).toBeNull();
    expect(classifyTrack("Manufacturing Engineer")).toBeNull();
    expect(classifyTrack("Senior Product Quality Engineer")).toBeNull();
  });

  it("refuses a role noun with no track qualifier at all", () => {
    expect(classifyTrack("Quantitative Researcher")).toBeNull();
    expect(classifyTrack("Team Lead - Account Management")).toBeNull();
    expect(classifyTrack("Lead Generation Specialist")).toBeNull();
    expect(classifyTrack("UX Designer")).toBeNull();
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

describe("REGRESSION: the qualifier pass does not swallow non-engineering roles", () => {
  // Each of these was produced BY an earlier draft of the qualifier list and
  // measured on the live corpus, then designed out. They are pinned here so a
  // future widening cannot quietly reintroduce them.
  it("does not read a design role as backend via 'Design Systems'", () => {
    expect(classifyTrack("Lead Product Designer (UI & Design Systems)")).toBeNull();
  });

  it("does not read 'Amazon Web Services' as a frontend role via 'web'", () => {
    expect(classifyTrack("Principal Architect: Amazon Web Services (AWS)")).toBeNull();
  });

  it("does not read a UX researcher or an AI consultant as engineering", () => {
    expect(classifyTrack("Staff UX Researcher")).toBeNull();
    expect(classifyTrack("AI Deployment Lead, Hedge Funds")).toBeNull();
    expect(classifyTrack("AI Business Consulting Lead - Wealth Management")).toBeNull();
  });

  it("keeps every title those exclusions were paid for", () => {
    expect(classifyTrack("Systems Engineer")).toBe("backend");
    expect(classifyTrack("Distributed Systems Engineer")).toBe("backend");
    expect(classifyTrack("Embedded Systems Developer")).toBe("backend");
    expect(classifyTrack("Web Developer")).toBe("frontend");
    expect(classifyTrack("Machine Learning Researcher")).toBe("ai");
  });
});
