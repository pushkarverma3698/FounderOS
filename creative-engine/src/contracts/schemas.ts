import { z } from "zod";

// ---------- Inputs ----------
export const Source = z.object({
  kind: z.enum(['url', 'screenshot', 'text', 'file']),
  ref: z.string(),
  fetchedAt: z.string().optional(),
  extractedText: z.string().optional(),
});
export type Source = z.infer<typeof Source>;

export const Fact = z.object({
  key: z.string(),
  value: z.string(),
  provenance: z.string(),
  verified: z.boolean(),
});
export type Fact = z.infer<typeof Fact>;

export const CreativeBrief = z.object({
  subject: z.string(),
  assetJob: z.string(),
  audience: z.object({ who: z.string(), geo: z.string().optional() }),
  facts: z.array(Fact),
  deadline: z.object({ at: z.string(), kind: z.enum(['event', 'sales_close']) }).optional(),
  existingHooks: z.array(z.object({ text: z.string(), source: z.string(), strength: z.number() })),
  contradictions: z.array(z.string()),
  channel: z.object({ platform: z.string(), format: z.string(), aspect: z.string() }),
});
export type CreativeBrief = z.infer<typeof CreativeBrief>;

// ---------- Strategy ----------
export const ConversionSpec = z.object({
  primaryAction: z.string(),
  frictionPath: z.array(z.string()),
  linkMechanics: z.object({
    bioLink: z.string().nullable(),
    storySticker: z.boolean(),
    pinnedComment: z.boolean(),
    dmKeyword: z.string().nullable(),
    onCanvasUrl: z.string().nullable(),
  }),
  urgencyBasis: z.enum(['real', 'none']),
  urgencySourceFact: z.string().nullable(),
  mustAppearOnCanvas: z.array(z.string()),
  timeHorizonHours: z.number(),
});
export type ConversionSpec = z.infer<typeof ConversionSpec>;

// ---------- Creative ----------
export const Concept = z.object({
  id: z.string(),
  register: z.enum(['confrontational', 'structural', 'deadline', 'object', 'human', 'contrarian']),
  hook: z.string(),
  visualThesis: z.string(),
  whyItConverts: z.string(),
  templateHint: z.string(),
});
export type Concept = z.infer<typeof Concept>;

export const DesignTokens = z.object({
  palette: z.record(z.string()),
  type: z.object({
    display: z.object({ family: z.string(), weight: z.number(), tracking: z.number() }),
    utility: z.object({ family: z.string(), weight: z.number(), tracking: z.number() }),
    scale: z.array(z.number()),
  }),
  accent: z.string(),
});
export type DesignTokens = z.infer<typeof DesignTokens>;

export const ArtDirection = z.object({
  templateId: z.string(),
  tokens: DesignTokens,
  copy: z.record(z.string()),
  platePrompt: z.string(),
  plateNegatives: z.array(z.string()),
  reserved: z.array(z.object({
    region: z.enum(['top', 'bottom', 'left', 'right', 'center']),
    extent: z.number(),
    reason: z.string(),
  })),
});
export type ArtDirection = z.infer<typeof ArtDirection>;

export const Plate = z.object({
  id: z.string(),
  path: z.string(),
  model: z.string(),
  promptHash: z.string(),
  seed: z.string().nullable(),
  qa: z.object({
    passed: z.boolean(),
    busynessMap: z.array(z.array(z.number())),
    reservedScore: z.number(),
    focalCentroid: z.tuple([z.number(), z.number()]),
    strayTextDetected: z.boolean(),
    reasons: z.array(z.string()),
  }),
  sampledPalette: z.record(z.string()),
});
export type Plate = z.infer<typeof Plate>;

export const Metrics = z.object({
  thumbHeadlineOcr: z.number(),
  contrastPerSlot: z.record(z.number()),
  requiredFactsPresent: z.boolean(),
  unverifiedFactOnCanvas: z.boolean(),
  safeAreaBreach: z.boolean(),
  strayTextInPlate: z.boolean(),
  textCoverage: z.number(),
  reservedCleanliness: z.number(),
  focalOcclusion: z.number(),
  hierarchyRatio: z.number(),
});
export type Metrics = z.infer<typeof Metrics>;

export const Variant = z.object({
  id: z.string(),
  plateId: z.string(),
  direction: ArtDirection,
  renders: z.object({ full: z.string(), plate: z.string(), mask: z.string(), thumb: z.string() }),
  metrics: Metrics,
  criticScores: z.object({
    conversion: z.number(), hierarchy: z.number(), brand: z.number(), craft: z.number(),
  }),
  eligible: z.boolean(),
  score: z.number(),
  iteration: z.number(),
});
export type Variant = z.infer<typeof Variant>;

export const Finding = z.object({
  severity: z.enum(['blocker', 'major', 'minor']),
  dimension: z.enum(['legibility', 'hierarchy', 'conversion', 'brand', 'craft', 'plate']),
  observation: z.string(),
  knob: z.enum(['tokens', 'copy', 'layout', 'plate']),
  suggestedChange: z.string(),
});
export type Finding = z.infer<typeof Finding>;

// ---------- Output Bundle ----------
export const OutputBundle = z.object({
  primaryImage: z.string(),
  primaryHtml: z.string(),
  plateClean: z.string(),
  storyDerivatives: z.array(z.string()),
  caption: z.string(),
  distributionPlan: z.string(),
  warnings: z.array(z.string()),
  auditJson: z.string(),
});
export type OutputBundle = z.infer<typeof OutputBundle>;

// ---------- Run State ----------
// Note: BrandKit is imported/resolved from FounderOS or standalone schema, treating as any/unknown here or string for now if not strictly defined in spec.
// Since it's nullable in spec, we will use a generic record.
export const BrandKit = z.record(z.any());
export type BrandKit = z.infer<typeof BrandKit>;

export const CreativeState = z.object({
  runId: z.string(),
  createdAt: z.string(),
  budget: z.object({
    usdCap: z.number(), spentUsd: z.number(),
    cheapIters: z.number(), expensiveIters: z.number(),
  }),
  intent: z.string(),
  sources: z.array(Source),
  brief: CreativeBrief.nullable(),
  brand: BrandKit.nullable(),
  strategy: ConversionSpec.nullable(),
  concepts: z.array(Concept),
  chosenConcept: Concept.nullable(),
  direction: ArtDirection.nullable(),
  plates: z.array(Plate),
  variants: z.array(Variant),
  findings: z.array(Finding),
  selected: Variant.nullable(),
  approved: z.boolean(),
  bundle: OutputBundle.nullable(),
  status: z.enum(['running', 'awaiting_hitl', 'done', 'failed', 'budget_capped']),
});
export type CreativeState = z.infer<typeof CreativeState>;
