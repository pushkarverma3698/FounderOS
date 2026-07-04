/**
 * 2026-07-04 finding (founder audit): generate_image's tool result only ever
 * contained { asset_id, s3_key, ... } — never a usable link. The Creative
 * Director prompt says specialists "Return the generated asset_id(s) and a
 * one-line rationale" (prompts/creative.ts), so a founder asking for an image
 * over Telegram got back a bare asset_id/JSON blob, never something they could
 * actually open. Nothing crashed, nothing errored — the feature was just
 * silently useless end-to-end despite every unit test around it being green.
 *
 * Fix: generate_image presigns a download_url itself (rule #16 — push this
 * out of the LLM's hands into deterministic code, don't rely on the model
 * remembering to call get_download_url as a second step).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

describe("generate_image — always returns a usable download_url (deterministic, not LLM-dependent)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function importWithMocks(opts: { presignOk?: boolean } = {}) {
    const presignOk = opts.presignOk ?? true;
    vi.doMock("../../../src/tools/image-gen.js", () => ({
      generateImage: vi.fn().mockResolvedValue({
        base64: "ZmFrZS1pbWFnZS1ieXRlcw==",
        mimeType: "image/png",
        model: "gemini-2.5-flash-image",
        tier: "draft",
        usd: 0.01,
      }),
      ImageGenError: class ImageGenError extends Error {},
      IMAGE_MODEL_FINAL: { id: "gemini-3-pro-image", usdPerImage: 0.134, tier: "final" },
    }));
    vi.doMock("../../../src/infra/storage/s3-client.js", () => ({
      uploadFile: vi.fn().mockResolvedValue("creative/run-1/abc_logo.png"),
      generatePresignedUrl: presignOk
        ? vi.fn().mockResolvedValue("https://s3.example.com/creative/run-1/abc_logo.png?sig=xyz")
        : vi.fn().mockRejectedValue(new Error("presign unreachable")),
      StorageError: class StorageError extends Error {},
    }));
    vi.doMock("../../../src/infra/storage/asset-repo.js", () => ({
      saveAsset: vi.fn().mockResolvedValue("asset-123"),
      getBrandAssets: vi.fn().mockResolvedValue([]),
    }));
    vi.doMock("../../../src/db/queries.js", () => ({
      logLlmCost: vi.fn().mockResolvedValue(undefined),
      getTodayCostUsd: vi.fn().mockResolvedValue(0),
    }));
    vi.doMock("../../../src/infra/daily-budget.js", () => ({
      getDailyBudgetCapUsd: vi.fn().mockReturnValue(10),
      checkDailyBudgetGate: vi.fn().mockReturnValue({ ok: true }),
    }));
    vi.doMock("../../../src/core/config.js", () => ({ TENANT: "turicks" }));
    vi.doMock("../../../src/infra/logger.js", () => ({
      childLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
    }));
    return import("../../../src/agents/agent-tools/creative.js");
  }

  it("includes a real download_url in the tool result on success", async () => {
    const { generateImageTool } = await importWithMocks();
    const raw = await generateImageTool.invoke({
      prompt: "a minimalist owl logo",
      final: null,
      intent: null,
      run_id: "run-1",
      asset_type: null,
    });
    const parsed = JSON.parse(raw as string);
    expect(parsed.download_url).toBe("https://s3.example.com/creative/run-1/abc_logo.png?sig=xyz");
    expect(parsed.asset_id).toBe("asset-123");
  });

  it("still returns the asset_id (never fails the whole call) if presigning fails", async () => {
    const { generateImageTool } = await importWithMocks({ presignOk: false });
    const raw = await generateImageTool.invoke({
      prompt: "a minimalist owl logo",
      final: null,
      intent: null,
      run_id: "run-1",
      asset_type: null,
    });
    const parsed = JSON.parse(raw as string);
    expect(parsed.asset_id).toBe("asset-123");
    expect(parsed.download_url).toBeNull();
    expect(String(parsed.note)).toMatch(/get_download_url/i);
  });
});
