/**
 * Video Factory — brand registry tests ($0, no network, no models).
 * The checked-in brand files are part of the contract: every registered brand
 * must validate, so a broken client profile fails CI before it fails a client.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listBrands, loadBrand, brandsDir, BrandProfileSchema } from "../../../src/tools/video-brand.js";

describe("brand registry (checked-in brands)", () => {
  it("registers the-health-place and turicks", () => {
    const slugs = listBrands();
    expect(slugs).toContain("the-health-place");
    expect(slugs).toContain("turicks");
  });

  it("every registered brand validates against the schema", () => {
    for (const slug of listBrands()) {
      const res = loadBrand(slug);
      expect(res.success, `brand ${slug}: ${res.success ? "" : res.error}`).toBe(true);
    }
  });

  it("the-health-place carries the unconfirmed-name flag (client sign-off pending)", () => {
    const res = loadBrand("the-health-place");
    if (!res.success) throw new Error(res.error);
    expect(res.brand.canonical_name_confirmed).toBe(false);
    expect(res.brand.pillars).toHaveLength(8);
  });
});

describe("brand registry (typed failures)", () => {
  it("unknown slug → typed error naming registered brands", () => {
    const res = loadBrand("no-such-client");
    expect(res.success).toBe(false);
    if (res.success) return;
    expect(res.error).toContain("no-such-client");
    expect(res.error).toContain("the-health-place");
  });

  it("invalid JSON → typed parse error, never a guess", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-brands-"));
    mkdirSync(join(dir, "broken"));
    writeFileSync(join(dir, "broken", "brand.json"), "{not json");
    const res = loadBrand("broken", dir);
    expect(res.success).toBe(false);
    if (res.success) return;
    expect(res.error).toContain("not valid JSON");
  });

  it("schema violation → error names the failing field", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-brands-"));
    mkdirSync(join(dir, "badpalette"));
    const valid = loadBrand("the-health-place");
    if (!valid.success) throw new Error(valid.error);
    const bad = { ...valid.brand, slug: "badpalette", palette: { ...valid.brand.palette, accent: "gold" } };
    writeFileSync(join(dir, "badpalette", "brand.json"), JSON.stringify(bad));
    const res = loadBrand("badpalette", dir);
    expect(res.success).toBe(false);
    if (res.success) return;
    expect(res.error).toContain("palette.accent");
  });

  it("slug/directory mismatch is rejected", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-brands-"));
    mkdirSync(join(dir, "dir-a"));
    const valid = loadBrand("turicks");
    if (!valid.success) throw new Error(valid.error);
    writeFileSync(join(dir, "dir-a", "brand.json"), JSON.stringify(valid.brand));
    const res = loadBrand("dir-a", dir);
    expect(res.success).toBe(false);
    if (res.success) return;
    expect(res.error).toContain("does not match directory");
  });

  it("missing registry dir → empty list, no crash", () => {
    expect(listBrands("/nonexistent/path")).toEqual([]);
  });

  it("VIDEO_BRANDS_DIR env overrides the default dir", () => {
    const prev = process.env["VIDEO_BRANDS_DIR"];
    process.env["VIDEO_BRANDS_DIR"] = "/tmp/custom-brands";
    try {
      expect(brandsDir()).toBe("/tmp/custom-brands");
    } finally {
      if (prev === undefined) delete process.env["VIDEO_BRANDS_DIR"];
      else process.env["VIDEO_BRANDS_DIR"] = prev;
    }
  });

  it("schema rejects an empty audiences list", () => {
    const valid = loadBrand("turicks");
    if (!valid.success) throw new Error(valid.error);
    const parsed = BrandProfileSchema.safeParse({ ...valid.brand, audiences: [] });
    expect(parsed.success).toBe(false);
  });
});
