/**
 * Shared brand-compliance block — injected into the comms / sales / marketing
 * prompts so the model knows the banned phrases BEFORE drafting (this prevents
 * retry cycles caused by the brand-validator rejecting a finished draft).
 *
 * The programmatic source of truth is BANNED_PHRASES in
 * src/infra/brand-validator.ts; this is the same list phrased for the LLM.
 */
export const BRAND_BANNED_SECTION = `
BRAND COMPLIANCE — check BEFORE drafting, these phrases cause instant rejection:
Never use: "I wanted to reach out" · "Hope this finds you well" · "Circle back" · "Synergy" · "Leverage" ·
"Utilize" · "Best practices" · "Game-changer" · "Revolutionary" · "Disruptive" · "Excited to" ·
"I hope you" · "Feel free to" · "Don't hesitate to" · "Please find attached" · "Quick question" ·
"Just following up" · "Touch base" · "We help companies like yours" · "Innovative solution" ·
"Paradigm shift" · "Scalable solution" · "Bleeding edge" · "Deep dive" · "Move the needle" ·
"Low-hanging fruit"
Write direct, confident, human. No corporate filler.`;
