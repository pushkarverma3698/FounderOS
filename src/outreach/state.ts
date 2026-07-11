/**
 * LangGraph Annotation for the outreach reflection subgraph.
 */

import { Annotation, messagesStateReducer } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";
import type { LeadContext } from "./contracts.js";

export const OutreachReflectionGraphState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  lead_context: Annotation<LeadContext>(),
  current_draft: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => "",
  }),
  validation_errors: Annotation<string[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  retry_count: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
  status: Annotation<"running" | "queued" | "failed">({
    reducer: (_prev, next) => next,
    default: () => "running" as const,
  }),
  queue_id: Annotation<string | undefined>({
    reducer: (_prev, next) => next,
    default: () => undefined,
  }),
  failure_reason: Annotation<string | undefined>({
    reducer: (_prev, next) => next,
    default: () => undefined,
  }),
});

export type OutreachGraphState = typeof OutreachReflectionGraphState.State;
