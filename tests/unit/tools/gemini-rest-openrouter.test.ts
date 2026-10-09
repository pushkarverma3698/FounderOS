/** Live QA 2026-10-09: voice and photos died on the depleted Google key (402). Media calls now go through OpenRouter. */
import { describe, expect, it, vi, afterEach } from "vitest";
import { geminiGenerate, openRouterModel, toOpenRouterContent } from "../../../src/tools/gemini-rest.js";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env["OPENROUTER_API_KEY"];
});

describe("OpenRouter media routing", () => {
  it("maps model ids and parts", () => {
    expect(openRouterModel("gemini-flash-latest")).toBe("google/gemini-2.5-flash");
    expect(openRouterModel("openai/gpt-4o")).toBe("openai/gpt-4o");
    expect(toOpenRouterContent([{ text: "hi" }, { inlineData: { mimeType: "audio/wav", data: "AAA" } }, { inlineData: { mimeType: "image/png", data: "BBB" } }])).toEqual([
      { type: "text", text: "hi" },
      { type: "input_audio", input_audio: { data: "AAA", format: "wav" } },
      { type: "image_url", image_url: { url: "data:image/png;base64,BBB" } },
    ]);
  });

  it("sends audio to OpenRouter, not Google, when the key is set", async () => {
    process.env["OPENROUTER_API_KEY"] = "k";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: " hello " } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await geminiGenerate({ model: "gemini-flash-latest", parts: [{ inlineData: { mimeType: "audio/wav", data: "AAA" } }] });
    expect(res.text).toBe("hello");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toContain("openrouter.ai");
    expect(JSON.parse(init.body).model).toBe("google/gemini-2.5-flash");
  });
});
