import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { getModel } from "../agents/model.js";
import { jsonrepair } from "jsonrepair";
import { logger } from "../infra/logger.js";

const log = logger.child({ module: "semantic-router" });

export type Intent = "engineering" | "jobhunt" | "comms" | "general";

export interface SemanticRoute {
  intent: Intent;
  repo_hint?: string;
}

const ROUTER_PROMPT = `You are a high-speed intent classifier for a Telegram AI assistant.
Your ONLY job is to classify the user's raw message into one of four categories, and extract a repository name if applicable.

Known repositories:
- "pushkarverma3698/FounderOS": FounderOS agent system, telegram gateway, jobs pipeline, CV tools.
- "OplifyMessage/oplify-messaging-app": Oplify messaging app, frontend, React Native, mobile, web app, UI.
- "OplifyMessage/oplify-messaging-api": Oplify messaging backend, Node.js API, Prisma, Redis, BullMQ, sockets.

Categories:
- "engineering": The user wants to write code, fix a bug, review a PR, deploy, or create a GitHub issue. Includes anything dispatched to Antigravity.
- "jobhunt": The user wants to review a candidate, parse a CV, look at jobs, or do recruiting tasks.
- "comms": The user wants to send an email, schedule a meeting, or post on LinkedIn/Twitter.
- "general": Anything else (questions, greetings, context queries).

OUTPUT FORMAT:
Respond with ONLY a raw JSON object, no markdown blocks, no explanation.

{
  "intent": "engineering",
  "repo_hint": "OplifyMessage/oplify-messaging-app" // Must be one of the known repository names if mentioned, else "pushkarverma3698/FounderOS"
}`;

export async function classifyIntent(text: string): Promise<SemanticRoute> {
  try {
    const model = getModel();
    const response = await model.invoke([
      new SystemMessage(ROUTER_PROMPT),
      new HumanMessage(text)
    ]);
    
    const content = typeof response.content === "string" ? response.content : JSON.stringify(response.content);
    const cleaned = content.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    
    let parsed: any;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      parsed = JSON.parse(jsonrepair(cleaned));
    }

    if (["engineering", "jobhunt", "comms", "general"].includes(parsed.intent)) {
      log.info({ intent: parsed.intent, repo: parsed.repo_hint }, "Semantic route decided");
      return {
        intent: parsed.intent as Intent,
        repo_hint: parsed.repo_hint
      };
    }
  } catch (err) {
    log.warn({ err: String(err) }, "Semantic routing failed, falling back to general");
  }
  
  return { intent: "general" };
}
