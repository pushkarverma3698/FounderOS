# TypeScript Advanced Patterns — Used in FounderOS

> Study guide for the TypeScript patterns in this codebase. Each section shows the pattern, where it's used, and what problem it solves.

---

## 1. `satisfies` Operator

**What it is:** Validates that a value matches a type without widening the type to that type.

**Used in:** `src/core/registry.ts` — company profile objects

```typescript
// Without satisfies — profile is typed as TuricksProfile (widened)
const profile: TuricksProfile = { services: [...], website: "..." };
// profile.services is string[] — loses the literal array type

// With satisfies — profile keeps its narrow literal type but IS validated
const profile = {
  services: ["LangGraph agentic systems", "Next.js"],
  website: "https://turicks.com",
  pricing: "$500 starter → $5,000 retainer",
  target_geo: ["EU", "US"],
  icp: "SME founders...",
  differentiator: "3–5 day delivery...",
} satisfies TuricksProfile;
// profile.services is ["LangGraph agentic systems", "Next.js"] — literal type preserved
// AND TypeScript errors if any required field is missing
```

**Interview answer:** "`satisfies` is like type annotation but without the type widening. You get validation at the definition site without losing the narrow inferred type."

---

## 2. Discriminated Union Types

**What it is:** A union of types where each variant has a unique discriminant field, enabling exhaustive pattern matching.

**Used in:** `CritiqueRecord`, `HITLRecord` status fields

```typescript
// The discriminant is the literal type on "result"
type CritiqueResult =
  | { result: "APPROVED"; notes: string }
  | { result: "NEEDS_REVISION"; notes: string; rule_violations: string[] };

// TypeScript narrows correctly in switch
function handleCritique(critique: CritiqueResult) {
  switch (critique.result) {
    case "APPROVED":
      // TypeScript knows: no rule_violations here
      break;
    case "NEEDS_REVISION":
      // TypeScript knows: rule_violations is string[] here
      console.log(critique.rule_violations); // ✅ no type error
      break;
    default:
      // Exhaustiveness check — TypeScript errors if a new case is added and not handled
      const _exhaustive: never = critique;
  }
}
```

**Interview answer:** "Discriminated unions + `never` for exhaustiveness checking. If I add a new `result` value, TypeScript forces me to handle it in every switch statement."

---

## 3. Template Literal Types

**What it is:** String literal types composed from other types.

**Used in:** Thread ID validation, action key typing

```typescript
// Build a union of all valid action keys at the type level
type Department = "sales" | "engineering" | "marketing";
type ActionKey = `${Department}_task` | `${Department}_approve`;
// ActionKey = "sales_task" | "sales_approve" | "engineering_task" | ...

// Thread ID structure enforcement
type TenantId = "turicks" | "naggar";
type ThreadId = `${TenantId}:${string}:${string}`;

function isValidThread(id: string): id is ThreadId {
  return /^(turicks|naggar):/.test(id);
}
```

---

## 4. Mapped Types

**What it is:** Types that transform the keys/values of another type.

**Used in:** Building the CASCADE record type with `Record<CascadeTier, CascadeEntry[]>`

```typescript
type CascadeTier = "ceo" | "deep_research" | "md" | "code" | "nano" | "local" | "video";

// Record<K, V> is a built-in mapped type
// Equivalent to: { [K in CascadeTier]: CascadeEntry[] }
const CASCADE: Record<CascadeTier, CascadeEntry[]> = {
  ceo: [...],
  deep_research: [...],
  // TypeScript errors if any key is missing
};
```

**Custom mapped type (making all fields required):**
```typescript
// Make all fields of a type non-nullable
type Required<T> = {
  [K in keyof T]-?: NonNullable<T[K]>;
};
```

---

## 5. Generic Constraints

**What it is:** Type parameters constrained to have specific properties.

**Used in:** `criticNode<S>` in `src/agents/critic.ts`

```typescript
// S must have these three fields — works for any pod state
export function afterCriticEdge<S extends {
  critiques: CritiqueRecord[];
  revision_count: number;
  max_revisions: number;
}>(state: S): "generator" | "hitl" {
  const latest = state.critiques.at(-1);
  if (!latest || latest.result === "APPROVED") return "hitl";
  if (state.revision_count >= state.max_revisions) return "hitl";
  return "generator";
}

// Works with SalesState AND EngineeringState — they both satisfy the constraint
afterCriticEdge(salesState);      // ✅
afterCriticEdge(engineeringState); // ✅
afterCriticEdge({ foo: "bar" });   // ❌ TypeScript error — missing critiques field
```

---

## 6. `infer` Keyword

**What it is:** Extract a type from within another type in a conditional type.

**Used in:** Utility types for LangGraph state inference

```typescript
// Extract the state type from an Annotation.Root()
type InferState<T> = T extends { State: infer S } ? S : never;

// LangGraph Annotation.Root() exposes a .State property
type SalesStateType = InferState<typeof SalesState>;
// Equivalent to: typeof SalesState.State

// More practical example — extract the return type of async function
type Awaited<T> = T extends Promise<infer U> ? U : T;
type NodeReturn = Awaited<ReturnType<typeof bdrNode>>;
```

---

## 7. Const Assertions

**What it is:** `as const` makes TypeScript infer the narrowest possible literal type.

**Used in:** `CIRCUIT_BREAKER_OPTIONS`, `RATE_LIMITER_OPTIONS` in `config.ts`

```typescript
// Without as const — options is { timeout: number; resetTimeout: number; ... }
const options = { timeout: 30_000, resetTimeout: 300_000 };

// With as const — options is { readonly timeout: 30000; readonly resetTimeout: 300000 }
export const CIRCUIT_BREAKER_OPTIONS = {
  timeout: 30_000,
  errorThresholdPercentage: 50,
  resetTimeout: 300_000,
  volumeThreshold: 3,
} as const;

// The readonly fields can't be accidentally modified
CIRCUIT_BREAKER_OPTIONS.timeout = 5000; // ❌ TypeScript error
```

---

## 8. Module Augmentation (brief)

**What it is:** Adding fields to types from external libraries.

**Would be used for:** Adding custom fields to grammy's `Context` type for FounderOS

```typescript
// In src/gateway/telegram.ts
declare module "grammy" {
  interface Context {
    founderosTenantId: string;
    founderosTraceId: string;
  }
}

// Now bot.use() handlers get these fields on ctx
bot.use((ctx, next) => {
  ctx.founderosTenantId = "turicks";
  ctx.founderosTraceId = crypto.randomUUID();
  return next();
});
```

---

## 9. `NodeNext` Module Resolution — The `.js` Extension Rule

This trips up every TypeScript developer. In `"moduleResolution": "NodeNext"`:

```typescript
// ❌ Fails at runtime: cannot find module './state' 
import { SalesState } from "./state";

// ✅ Required: .js extension even for .ts source files
import { SalesState } from "./state.js";
```

**Why:** When you write `.js`, TypeScript knows to look for the `.ts` file during compilation, and Node.js finds the compiled `.js` file at runtime. It seems backwards but it's the ESM spec.

**Process env access also has a rule:**
```typescript
// ❌ Dot notation — TypeScript strict mode may complain about undefined
process.env.ANTHROPIC_API_KEY

// ✅ Bracket notation — explicit; clearer intent for dynamic env access
process.env["ANTHROPIC_API_KEY"]
```

---

## 10. Zod for Runtime Type Safety

**What it is:** Runtime validation library that also infers TypeScript types.

**Used in:** `src/core/config.ts` — env var validation

```typescript
import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  BUDGET_DAILY_USD: z.coerce.number().positive().default(5.0),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

// Type is inferred automatically — no manual interface needed
type Env = z.infer<typeof envSchema>;

const env = envSchema.parse(process.env);
// If DATABASE_URL is missing or not a URL → throws ZodError with clear message
// env.BUDGET_DAILY_USD is typed as number (not string) because of z.coerce.number()
```

**Interview answer:** "Zod gives you validation and TypeScript types from a single source. `z.infer<typeof schema>` extracts the TypeScript type — no duplication, no drift between the validator and the type."

---

## TypeScript Config Notes (tsconfig.json)

Key settings used in FounderOS:

```json
{
  "compilerOptions": {
    "strict": true,              // All strict checks on
    "module": "NodeNext",        // ESM with .js extensions required
    "moduleResolution": "NodeNext",
    "target": "ES2022",          // Supports top-level await, crypto.randomUUID()
    "noUncheckedIndexedAccess": true,  // array[i] returns T | undefined, not T
    "exactOptionalPropertyTypes": true // { foo?: string } ≠ { foo: string | undefined }
  }
}
```

**`noUncheckedIndexedAccess`** — This is why you see `.at(-1)` and optional chaining in the codebase:
```typescript
// Without noUncheckedIndexedAccess
const last = state.critiques[state.critiques.length - 1]; // typed as CritiqueRecord

// With noUncheckedIndexedAccess  
const last = state.critiques[state.critiques.length - 1]; // typed as CritiqueRecord | undefined
const latest = state.critiques.at(-1); // CritiqueRecord | undefined — more idiomatic
```
