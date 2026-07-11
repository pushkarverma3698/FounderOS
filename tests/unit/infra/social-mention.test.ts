/**
 * Unit tests for the pure LinkedIn mention / little-text builder.
 */

import { describe, it, expect } from "vitest";
import {
  buildCommentary,
  escapeLittleText,
  isOrganizationUrn,
  type MentionTarget,
} from "../../../src/infra/social-mention.js";

const TURICKS: MentionTarget = { urn: "urn:li:organization:2414183", name: "Turicks" };

describe("isOrganizationUrn", () => {
  it("accepts a well-formed organization URN", () => {
    expect(isOrganizationUrn("urn:li:organization:2414183")).toBe(true);
  });
  it("rejects person URNs and garbage", () => {
    expect(isOrganizationUrn("urn:li:person:ABC")).toBe(false);
    expect(isOrganizationUrn("2414183")).toBe(false);
    expect(isOrganizationUrn("")).toBe(false);
  });
});

describe("escapeLittleText", () => {
  it("escapes structural annotation characters", () => {
    expect(escapeLittleText("a (b) [c] @d #e")).toBe("a \\(b\\) \\[c\\] \\@d \\#e");
  });
  it("escapes backslash first so it never double-processes", () => {
    // A literal backslash becomes \\, and is not re-escaped by later passes.
    expect(escapeLittleText("x\\y")).toBe("x\\\\y");
  });
  it("leaves plain text untouched", () => {
    expect(escapeLittleText("hello world 123")).toBe("hello world 123");
  });
});

describe("buildCommentary", () => {
  it("returns text unchanged when there is no mention (preserves plain-post behavior)", () => {
    const text = "Shipped v3 (finally)! @here #buildinpublic";
    expect(buildCommentary(text)).toBe(text);
  });

  it("appends the org annotation on its own line and escapes the body", () => {
    const out = buildCommentary("Big news (today)!", TURICKS);
    expect(out).toBe("Big news \\(today\\)!\n\n@[Turicks](urn:li:organization:2414183)");
  });

  it("uses the exact page name so LinkedIn can resolve the link", () => {
    const out = buildCommentary("hi", { urn: "urn:li:organization:99", name: "Acme AI" });
    expect(out).toContain("@[Acme AI](urn:li:organization:99)");
  });

  it("yields only the annotation when the body is empty", () => {
    expect(buildCommentary("", TURICKS)).toBe("@[Turicks](urn:li:organization:2414183)");
  });
});
