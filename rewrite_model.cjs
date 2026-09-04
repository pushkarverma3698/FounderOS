const fs = require('fs');
let content = fs.readFileSync('src/agents/model.ts', 'utf8');

// Update imports
content = content.replace(
  'import { ChatGoogleGenerativeAI } from "@langchain/google-genai";',
  'import { ChatVertexAI } from "@langchain/google-vertexai";'
);

// Update ModelProvider
content = content.replace(
  'export type ModelProvider = "google-genai" | "openai" | "anthropic" | "openrouter";',
  'export type ModelProvider = "google-vertexai" | "google-genai" | "openai" | "anthropic" | "openrouter";'
);

// Update inferLegacyProvider
content = content.replace(
  'if (lower.includes("gemini")) return "google-genai";',
  'if (lower.includes("gemini")) return "google-vertexai";'
);

// Update parsed.provider includes
content = content.replace(
  'if (!["google-genai", "openai", "anthropic", "openrouter"].includes(provider)) {',
  'if (!["google-vertexai", "google-genai", "openai", "anthropic", "openrouter"].includes(provider)) {'
);

// Update error message
content = content.replace(
  'Use google-genai:, openai:, anthropic:, or openrouter:.',
  'Use google-vertexai:, openai:, anthropic:, or openrouter:. (google-genai is supported as an alias for google-vertexai)'
);

// Update buildModel provider check
const oldBuildGoogle = `
  if (parsed.provider === "google-genai") {
    if (!process.env["GOOGLE_GENERATIVE_AI_API_KEY"]) {
      if (optional) return null;
      throw new Error("GOOGLE_GENERATIVE_AI_API_KEY is required for google-genai: models.");
    }
    return new ChatGoogleGenerativeAI({
      model: parsed.model,
      temperature,
      maxRetries: 2,
      apiKey: process.env["GOOGLE_GENERATIVE_AI_API_KEY"],
    });
  }
`;

const newBuildGoogle = `
  if (parsed.provider === "google-vertexai" || parsed.provider === "google-genai") {
    // Vertex AI uses Application Default Credentials. 
    // It will automatically pick up GOOGLE_APPLICATION_CREDENTIALS or run on GCP infrastructure without keys.
    return new ChatVertexAI({
      model: parsed.model,
      temperature,
      maxRetries: 2,
    });
  }
`;

content = content.replace(oldBuildGoogle.trim(), newBuildGoogle.trim());

fs.writeFileSync('src/agents/model.ts', content);
console.log('model.ts rewritten');
