import { ChatVertexAI } from "@langchain/google-vertexai";
import { HumanMessage } from "@langchain/core/messages";

// Tests exactly what src/agents/model.ts buildModel() constructs for the
// google-vertexai: provider — same authOptions/location shape, so a pass here
// is real evidence the prod credential wiring works (rule #24), not a guess.
async function main() {
  const credsPath = process.env["GOOGLE_APPLICATION_CREDENTIALS"] ?? "";
  const project = process.env["GOOGLE_CLOUD_PROJECT"] ?? "";
  const location = process.env["GOOGLE_CLOUD_LOCATION"]?.trim() || "us-central1";
  console.log("GOOGLE_APPLICATION_CREDENTIALS:", credsPath || "(unset)");
  console.log("GOOGLE_CLOUD_PROJECT:", project || "(unset)");
  console.log("GOOGLE_CLOUD_LOCATION:", location);
  if (!credsPath || !project) {
    console.log("VERTEX_FAIL missing GOOGLE_APPLICATION_CREDENTIALS and/or GOOGLE_CLOUD_PROJECT — not attempting a call.");
    process.exit(1);
  }

  const m = new ChatVertexAI({
    model: "gemini-2.5-flash",
    temperature: 0,
    maxRetries: 2,
    authOptions: { keyFilename: credsPath, projectId: project },
    location,
  });
  const t0 = Date.now();
  try {
    const r = await m.invoke([new HumanMessage("Say 4")]);
    console.log("VERTEX_OK", Date.now() - t0, "ms", typeof r.content === "string" ? r.content : "");
  } catch (e: any) {
    console.log(
      "VERTEX_FAIL",
      Date.now() - t0,
      "ms",
      "status=",
      e?.status ?? e?.response?.status,
      "msg=",
      (e?.message ?? "").slice(0, 300),
    );
    process.exitCode = 1;
  }
}
main().then(() => process.exit(process.exitCode ?? 0));
