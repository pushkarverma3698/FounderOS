/**
 * Every worker tool's parameters must be a schema Gemini accepts.
 *
 * 2026-09-29: `antigravity_task_status` declared `issue: z.number().int().positive()`.
 * Zod emits `exclusiveMinimum`, @langchain/google-genai passes it through, and
 * Gemini answers 400 "Unknown name exclusiveMinimum" for the WHOLE request — so
 * every engineering turn failed in prod while all unit tests were green (the
 * scripted models never see a schema). This test runs each tool through the same
 * conversion google-genai uses (toJsonSchema, then strip additionalProperties /
 * $schema / strict) and rejects any keyword outside Gemini's `Schema` object.
 */
import { describe, expect, it } from "vitest";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import {
  ADMIN_SUBAGENT_TOOLS,
  DEPARTMENT_TOOLS,
  ENGINEERING_SUBAGENT_TOOLS,
  MARKETING_SUBAGENT_TOOLS,
} from "../../../src/agents/capabilities.js";

// Fields of Gemini's function-declaration `Schema` (generativelanguage v1beta).
const GEMINI_SCHEMA_KEYS = new Set([
  "type", "format", "title", "description", "nullable", "enum", "default", "example",
  "properties", "required", "propertyOrdering", "minProperties", "maxProperties",
  "items", "minItems", "maxItems", "minLength", "maxLength", "pattern",
  "minimum", "maximum", "anyOf",
  // Zod's .optional() emits {"not":{}}. Gemini accepts it: every optional tool arg
  // in prod sends it, and the 2026-09-29 400 named exclusiveMinimum at any_of[0][1]
  // without complaining about the "not" at any_of[0][0] before it.
  "not",
]);

// What google-genai strips before sending (removeAdditionalProperties).
const STRIPPED = new Set(["additionalProperties", "$schema", "strict"]);

function unsupportedKeys(node: unknown, path: string, out: string[]): void {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (STRIPPED.has(key)) continue;
    if (!GEMINI_SCHEMA_KEYS.has(key)) out.push(`${path}.${key}`);
    if (key === "properties" && value && typeof value === "object") {
      for (const [prop, child] of Object.entries(value as Record<string, unknown>)) {
        unsupportedKeys(child, `${path}.properties.${prop}`, out);
      }
    } else if (key === "items" || key === "not") {
      unsupportedKeys(value, `${path}.${key}`, out);
    } else if (key === "anyOf" && Array.isArray(value)) {
      value.forEach((child, i) => unsupportedKeys(child, `${path}.anyOf[${i}]`, out));
    }
  }
}

const allTools = [
  ...Object.values(DEPARTMENT_TOOLS),
  ...Object.values(ENGINEERING_SUBAGENT_TOOLS),
  ...Object.values(MARKETING_SUBAGENT_TOOLS),
  ...Object.values(ADMIN_SUBAGENT_TOOLS),
].flat();
const byName = new Map(allTools.map((t) => [t.name, t]));

describe("worker tool schemas are Gemini-compatible", () => {
  it("covers the tools the workers bind", () => {
    expect(byName.size).toBeGreaterThan(40);
    expect(byName.has("antigravity_task_status")).toBe(true);
  });

  it.each([...byName.keys()])("%s uses only Gemini Schema keywords", (name) => {
    const schema = (byName.get(name) as { schema?: unknown }).schema;
    const json = toJsonSchema(schema as Parameters<typeof toJsonSchema>[0]);
    const bad: string[] = [];
    unsupportedKeys(json, name, bad);
    expect(bad).toEqual([]);
  });
});
