import { Annotation } from "@langchain/langgraph";

export const CreativeStateAnnotation = Annotation.Root({
  runId: Annotation<string>(),
  createdAt: Annotation<string>(),
  budget: Annotation<{
    usdCap: number;
    spentUsd: number;
    cheapIters: number;
    expensiveIters: number;
  }>(),
  intent: Annotation<string>(),
  sources: Annotation<any[]>(),
  brief: Annotation<any>(),
  brand: Annotation<any>(),
  strategy: Annotation<any>(),
  concepts: Annotation<any[]>(),
  chosenConcept: Annotation<any>(),
  direction: Annotation<any>(),
  plates: Annotation<any[]>(),
  currentRender: Annotation<any>(),
  currentMetrics: Annotation<any>(),
  variants: Annotation<any[]>({
    value: (x, y) => (x || []).concat(y || []),
    default: () => [],
  }),
  findings: Annotation<any[]>(),
  selected: Annotation<any>(),
  approved: Annotation<boolean>(),
  bundle: Annotation<any>(),
  status: Annotation<"running" | "awaiting_hitl" | "done" | "failed" | "budget_capped">(),
});
