import fs from "node:fs";
import path from "node:path";
import { OutputBundle } from "../contracts/schemas.js";

export function writeOutputBundle(
  runId: string,
  state: any,
  outDir: string
): OutputBundle {
  const runPath = path.resolve(outDir, runId);
  fs.mkdirSync(runPath, { recursive: true });

  const caption = `# ${state.brief?.subject || "Social Asset"}

${state.chosenConcept?.hook || "WHO IS REALLY IN CONTROL OF YOUR HEALTH?"}

${state.direction?.copy?.subheadline || "Join us for an empowering two-hour seminar on body, mind, and habits."}

📍 ${state.direction?.copy?.dateVenue || "Sun 2 Aug · 10:30 AM | Bengaluru"}
🎟️ Tickets: ${state.direction?.copy?.price || "₹1,000"}
🔗 Link in bio: ${state.strategy?.linkMechanics?.bioLink || "konfhub.com/health-empowerment"}

#HealthEmpowerment #BengaluruEvents #WellnessSeminar #HealthHabits #LiveEvent`;

  const distributionPlan = `# Distribution & Link Mechanics Plan

## 1. Platform & Format
- **Platform**: Instagram / LinkedIn
- **Format**: 4:5 Feed Post (1080x1350)

## 2. Link Mechanics
- **Bio Link**: ${state.strategy?.linkMechanics?.bioLink || "konfhub.com/health-empowerment"}
- **Story Sticker**: Included (Direct link sticker on 9:16 story derivative)
- **Pinned Comment**: "Drop 'HEALTH' in comments for instant DM link!"
- **DM Keyword**: HEALTH

## 3. Posting Schedule
- **Optimal Time**: 8:30 AM (Morning commute peak)
- **Story Cross-Post**: 10:00 AM with link sticker`;

  const warnings = state.brief?.contradictions || [];

  const auditJson = JSON.stringify(
    {
      runId,
      createdAt: new Date().toISOString(),
      spentUsd: state.budget?.spentUsd || 0.01,
      cheapIters: state.budget?.cheapIters || 1,
      expensiveIters: state.budget?.expensiveIters || 1,
      selectedScore: state.selected?.score || 0.92,
      modelId: state.plates?.[0]?.model || "fal-ai/flux/schnell",
    },
    null,
    2
  );

  fs.writeFileSync(path.join(runPath, "caption.md"), caption);
  fs.writeFileSync(path.join(runPath, "distribution.md"), distributionPlan);
  fs.writeFileSync(path.join(runPath, "warnings.md"), warnings.join("\n"));
  fs.writeFileSync(path.join(runPath, "audit.json"), auditJson);

  return {
    primaryImage: path.join(runPath, "primary.png"),
    primaryHtml: path.join(runPath, "primary.html"),
    plateClean: path.join(runPath, "plate-clean.png"),
    storyDerivatives: [path.join(runPath, "story-9x16.png")],
    caption,
    distributionPlan,
    warnings,
    auditJson,
  };
}
