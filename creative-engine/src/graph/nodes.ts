import { posterQuietTemplate } from "../templates/poster-quiet/index.js";
import { renderTemplate } from "../compose/render.js";
import { computeAllMetrics } from "../metrics/index.js";
import { generatePlate, computeBusynessMap } from "../plate/comfy.ts";
import { compilePlatePrompt } from "../direction/promptCompiler.js";
import { evaluateAnchoredDesign } from "../critics/design.js";
import { calculateVariantScore, selectBestVariant } from "../score/select.ts";
import { Variant, Finding } from "../contracts/schemas.js";

// Node 1: intake
export async function intakeNode(state: any) {
  const brief = {
    subject: "Health Empowerment Seminar",
    assetJob: "Drive registrations for live health seminar in Bengaluru",
    audience: { who: "Health conscious individuals and professionals in Bengaluru" },
    facts: [
      { key: "date", value: "Sun 2 Aug · 10:30 AM", provenance: "user", verified: true },
      { key: "venue", value: "Crescent Workspace, Bengaluru", provenance: "user", verified: true },
      { key: "price", value: "₹1,000", provenance: "user", verified: true },
      { key: "url", value: "konfhub.com/health-empowerment", provenance: "user", verified: true },
    ],
    existingHooks: [{ text: "WHO IS REALLY IN CONTROL OF YOUR HEALTH?", source: "brief", strength: 0.9 }],
    contradictions: [],
    channel: { platform: "instagram", format: "post", aspect: "4:5" },
  };
  return { brief };
}

// Node 2: brand_resolve
export async function brandResolveNode(state: any) {
  const brand = {
    palette: { bg: "#0d130e", text: "#ffffff", muted: "#a0aab0", accent: "#ff5c47" },
    antiPatterns: ["no neon", "no plastic CGI skin"],
  };
  return { brand };
}

// Node 3: strategy
export async function strategyNode(state: any) {
  const strategy = {
    primaryAction: "Register on KonfHub",
    frictionPath: ["Click bio link", "Select seat"],
    linkMechanics: { bioLink: "konfhub.com/health-empowerment", storySticker: true, pinnedComment: true, dmKeyword: "HEALTH", onCanvasUrl: "konfhub.com/health-empowerment" },
    urgencyBasis: "real",
    urgencySourceFact: "Sun 2 Aug",
    mustAppearOnCanvas: ["Sun 2 Aug", "₹1,000"],
    timeHorizonHours: 48,
  };
  return { strategy };
}

// Node 4: ideate
export async function ideateNode(state: any) {
  const concepts = [
    {
      id: "concept-1",
      register: "confrontational",
      hook: "WHO IS REALLY IN CONTROL OF YOUR HEALTH?",
      visualThesis: "Abstract organic hands resting peacefully, thoughtful health empowerment theme",
      whyItConverts: "Direct question hook triggers immediate cognitive stop",
      templateHint: "poster-quiet",
    },
  ];
  return { concepts, chosenConcept: concepts[0] };
}

// Node 5: art_direct
export async function artDirectNode(state: any) {
  const chosen = state.chosenConcept;
  const direction = {
    templateId: "poster-quiet",
    tokens: {
      palette: state.brand?.palette || { bg: "#0d130e", text: "#ffffff", accent: "#ff5c47" },
      type: {
        display: { family: "system-ui, sans-serif", weight: 800, tracking: -0.028 },
        utility: { family: "monospace", weight: 400, tracking: 0 },
        scale: [16, 20, 24, 32, 48, 72],
      },
      accent: "#ff5c47",
    },
    copy: {
      kicker: "THE HEALTH PLACE — SEMINAR",
      headline: chosen?.hook || "WHO IS REALLY IN CONTROL OF YOUR HEALTH?",
      subheadline: "Two hours on your body, your mind, and the habits quietly deciding both.",
      dateVenue: "Sun 2 Aug · 10:30 AM",
      price: "₹1,000",
      cta: "REGISTER NOW",
      url: "konfhub.com/health-empowerment",
    },
    platePrompt: "",
    plateNegatives: [],
    reserved: [
      { region: "top", extent: 0.45, reason: "Headline" },
      { region: "bottom", extent: 0.35, reason: "Detail rail" },
    ],
  };

  const compiled = compilePlatePrompt(direction as any, state.brand, chosen?.visualThesis);
  direction.platePrompt = compiled.prompt;
  direction.plateNegatives = compiled.negatives;

  return { direction };
}

// Node 6: plate_gen
export async function plateGenNode(state: any) {
  const plate = await generatePlate({
    prompt: state.direction.platePrompt,
    negatives: state.direction.plateNegatives,
  });

  const spentUsd = (state.budget?.spentUsd || 0) + 0.01;
  const expensiveIters = (state.budget?.expensiveIters || 0) + 1;

  return {
    plates: [...(state.plates || []), plate],
    budget: { ...state.budget, spentUsd, expensiveIters },
  };
}

// Node 7: plate_qa
export async function plateQaNode(state: any) {
  const latestPlate = state.plates[state.plates.length - 1];
  return { latestPlatePassed: latestPlate?.qa?.passed };
}

// Node 8: compose
export async function composeNode(state: any) {
  const renderResult = await renderTemplate(posterQuietTemplate, {
    tokens: state.direction.tokens,
    copy: state.direction.copy,
  });

  const metrics = await computeAllMetrics({
    renderResult,
    brief: state.brief,
    copy: state.direction.copy,
    tokenColors: {
      headline: state.direction.tokens.palette.text,
      dateVenue: state.direction.tokens.palette.text,
      cta: "#ffffff",
    },
  });

  const cheapIters = (state.budget?.cheapIters || 0) + 1;

  return {
    currentRender: renderResult,
    currentMetrics: metrics,
    budget: { ...state.budget, cheapIters },
  };
}

// Node 9: critique
export async function critiqueNode(state: any) {
  const currentRender = state.currentRender;
  const metrics = state.currentMetrics;

  const mockVariant: Variant = {
    id: `var-${Date.now()}`,
    plateId: state.plates[state.plates.length - 1]?.id || "plate-0",
    direction: state.direction,
    renders: {
      full: "full.png",
      plate: "plate.png",
      mask: "mask.png",
      thumb: "thumb.png",
    },
    metrics,
    criticScores: { conversion: 0.9, hierarchy: 0.85, brand: 0.95, craft: 0.9 },
    eligible: !metrics.unverifiedFactOnCanvas && metrics.thumbHeadlineOcr >= 0.70,
    score: 0,
    iteration: state.budget.cheapIters,
  };

  const criticRes = evaluateAnchoredDesign(mockVariant, state.strategy, state.brand);
  mockVariant.score = calculateVariantScore(mockVariant, criticRes.scores);

  return {
    variants: [mockVariant],
    findings: criticRes.findings,
  };
}

// Node 10: select
export async function selectNode(state: any) {
  const selected = selectBestVariant(state.variants);
  return { selected };
}

// Node 11: package
export async function packageNode(state: any) {
  return {
    status: "done",
    approved: true,
  };
}
