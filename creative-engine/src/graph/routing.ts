export function routeNextNode(state: any): "compose" | "plate_gen" | "select" {
  const findings = state.findings || [];
  const cheapIters = state.budget?.cheapIters || 0;
  const expensiveIters = state.budget?.expensiveIters || 0;

  const hasPlateBlocker = findings.some(
    (f: any) => f.knob === "plate" && f.severity === "blocker"
  );
  const hasCheapFixes = findings.some(
    (f: any) => f.knob !== "plate" && f.severity !== "minor"
  );

  if (hasPlateBlocker && expensiveIters < (process.env.MAX_EXPENSIVE_ITERS ? parseInt(process.env.MAX_EXPENSIVE_ITERS) : 1)) {
    return "plate_gen";
  }

  if (hasCheapFixes && cheapIters < (process.env.MAX_CHEAP_ITERS ? parseInt(process.env.MAX_CHEAP_ITERS) : 4)) {
    return "compose";
  }

  return "select";
}
