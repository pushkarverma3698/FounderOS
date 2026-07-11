/**
 * LangGraph node factories: generator, validator, reflector, executor.
 */

import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { OutreachGraphState } from "./state.js";
import {
  formatLeadContextBlock,
  formatReflectorUserPrompt,
  GENERATOR_SYSTEM_PROMPT,
  REFLECTOR_SYSTEM_PROMPT,
} from "./prompts.js";
import { validateConnectionDraft } from "./validator.js";
import type { InMemoryDailyLimitTracker } from "./validator.js";
import type { OutreachQueue } from "./queue.js";
import { terminalFailureReason } from "./routing.js";

export interface OutreachNodeDeps {
  generatorModel: BaseChatModel;
  reflectorModel: BaseChatModel;
  dailyLimits: InMemoryDailyLimitTracker;
  queue: OutreachQueue;
  accountId: string;
}

function stripDraft(raw: string): string {
  return raw.replace(/^["'`]+|["'`]+$/g, "").trim();
}

export function makeGeneratorNode(deps: OutreachNodeDeps) {
  return async (state: OutreachGraphState): Promise<Partial<OutreachGraphState>> => {
    const user = new HumanMessage(
      `Write a connection note for:\n\n${formatLeadContextBlock(state.lead_context)}`,
    );
    const response = await deps.generatorModel.invoke([
      new SystemMessage(GENERATOR_SYSTEM_PROMPT),
      user,
    ]);
    const draft = stripDraft(typeof response.content === "string" ? response.content : String(response.content));
    return {
      current_draft: draft,
      messages: [user, new AIMessage(draft)],
      validation_errors: [],
    };
  };
}

export function makeValidatorNode(deps: OutreachNodeDeps) {
  return (state: OutreachGraphState): Partial<OutreachGraphState> => {
    const result = validateConnectionDraft({
      draft: state.current_draft,
      lead_context: state.lead_context,
      account_id: deps.accountId,
      checkDailyLimit: (id) => deps.dailyLimits.check(id),
    });
    return { validation_errors: result.errors };
  };
}

export function makeReflectorNode(deps: OutreachNodeDeps) {
  return async (state: OutreachGraphState): Promise<Partial<OutreachGraphState>> => {
    const user = new HumanMessage(
      formatReflectorUserPrompt(state.current_draft, state.validation_errors),
    );
    const response = await deps.reflectorModel.invoke([
      new SystemMessage(REFLECTOR_SYSTEM_PROMPT),
      user,
    ]);
    const draft = stripDraft(typeof response.content === "string" ? response.content : String(response.content));
    return {
      current_draft: draft,
      retry_count: state.retry_count + 1,
      validation_errors: [],
      messages: [user, new AIMessage(draft)],
    };
  };
}

export function makeExecutorNode(deps: OutreachNodeDeps) {
  return (state: OutreachGraphState): Partial<OutreachGraphState> => {
    const entry = deps.queue.enqueue({
      profile_id: state.lead_context.profile_id,
      message: state.current_draft,
      account_id: deps.accountId,
    });
    deps.dailyLimits.recordSend(deps.accountId);
    return {
      status: "queued",
      queue_id: entry.queue_id,
      validation_errors: [],
    };
  };
}

/** Terminal node when retry cap exceeded — surfaces typed failure for the caller. */
export function makeFailNode() {
  return (state: OutreachGraphState): Partial<OutreachGraphState> => ({
    status: "failed",
    failure_reason: terminalFailureReason(state),
  });
}
