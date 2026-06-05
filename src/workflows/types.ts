/**
 * FounderOS — Workflow / SOP Types
 * ==================================
 * A workflow is a named, parameterized, ordered sequence of steps.
 * Each step is a natural-language task that runs through the existing office
 * (inherits routing, tools, HITL, budget, memory).
 *
 * Step outputs chain implicitly: the LangGraph checkpointer accumulates history
 * on the same thread, so step N+1 naturally sees step N's output in context.
 * No explicit "chain output" mechanism needed.
 */

export interface WorkflowStep {
  /** Short machine-readable label shown in progress messages. */
  id: string;
  /** Natural-language task template. Slots: {param_name}. */
  task: string;
  /** Optional label shown to the founder before the step runs. Defaults to id. */
  label?: string;
}

export interface WorkflowDef {
  id: string;
  name: string;
  description: string;
  /** Required slot names that must be provided via /run <id> key=value. */
  params: string[];
  steps: WorkflowStep[];
}
