// Hypothesis test: does importing agents/model.js break global fetch for the TTS endpoint?
const importModel = process.argv[2] === "with-model";
if (importModel) await import("../src/agents/model.js");
const body = {
  contents: [{ role: "user", parts: [{ text: "Hello there." }] }],
  generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } } },
};
const t = Date.now();
try {
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": process.env["GOOGLE_GENERATIVE_AI_API_KEY"]! },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const j = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data: string } }> } }> };
  console.log(`importModel=${importModel} HTTP ${res.status} in ${((Date.now() - t) / 1000).toFixed(1)}s b64len=${j.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data?.length}`);
} catch (e) {
  console.log(`importModel=${importModel} ERR in ${((Date.now() - t) / 1000).toFixed(1)}s: ${(e as Error).message}`);
}
