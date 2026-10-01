/**
 * Tashi's classifier terms that came from MEASUREMENT, per track.
 * ================================================================
 * 2026-09-28: every NL-marked board in the registry (1,166) was polled with the
 * production adapters and her own filters were run over the 39,287 postings.
 * 21 Dutch roles survived a 30-day window. Among the postings dropped as
 * `off_track` at Dutch or unknown locations, hand-reading the finance-shaped
 * titles left 29 that fit a 2.4-year FP&A / KYC / audit candidate — BDO and
 * Deloitte junior tax and audit roles, ING financial-crime compliance, an
 * Assistant Controller, a Rabobank Finance Specialist. The phrases below are
 * what those titles needed; tests/unit/jobhunt/tashi-track-recall.test.ts pins
 * each one to its real title.
 *
 * WHOLE PHRASES ONLY, and that is measured too: bare "controller" matched a
 * chip-design role, bare "tax" matched software sales ("Account Manager Tax &
 * Trade"), "compliance specialist" matched export control, bare "assurance"
 * matched quality assurance — all in the same sweep, all pinned as negatives.
 *
 * English only. ~3/4 of Dutch finance postings are written in Dutch, and the
 * Language gate reads a stated requirement, not the language a posting is
 * written in — Dutch titles wait on how well she reads Dutch.
 *
 * PRECISION, 2026-09-29 (S6). The same audit listed four titles that passed her
 * filters and should not, and re-polling the corpus that day found their
 * neighbours. Two bare words were doing the damage, and both are now QUALIFIED
 * rather than dropped, because each still has real finance uses:
 *
 *   · bare "auditor" matched a medical-device notified body ("Medical Devices
 *     Auditor - High Risk Software"), a social-compliance certifier, an ISO 27001
 *     auditor and a shift-floor quality auditor. What she wants is "internal
 *     auditor" (already here), "external auditor", "IT auditor" (5 live titles:
 *     Axon, Groupon, IMC, PwC), "junior auditor" and "financial auditor".
 *   · bare "due diligence" matched a construction survey ("Technical Due Diligence
 *     Consultant - Bouwkundig Adviseur") and a data-centre manager. What she wants
 *     is "financial due diligence", "customer/client/enhanced due diligence" (the
 *     KYC side) and "due diligence analyst" (a `titles` phrase in wife-nl-finance.ts).
 *
 * "junior auditor", "financial auditor", "client due diligence" and "enhanced due
 * diligence" have NO live example in the 2026-09-29 corpus: they are the canonical
 * entry-level shapes, kept so that dropping the bare word costs no recall on the roles
 * an MSc in auditing is for, and the recall test says so next to each.
 *
 * REJECT LIST. A title can carry one of her phrases and still not be hers. The
 * profile's `rejectTitleTerms` beats every term (tracks.ts), whole-word:
 *
 *   · working-student and internship titles. "Financial Controller - Working
 *     Student" and Deloitte's "Stage IT Audit & Assurance" classify on the finance
 *     phrase alone. The Experience gate (seniority.ts) already REJECTS them on the
 *     record; this drops them one stage earlier, counted as off-track, before they
 *     cost a body fetch. Whole-word "stage" is an internship in all 179 live titles
 *     that carry it. The known cost: a hyphenated "early-stage" would read as one too.
 *   · a Portuguese title that matched only the "(FP&A)" acronym, from a Brazilian
 *     employer with no location. One language, as measured: add another the day one
 *     leaks, not before.
 *
 * Kept apart from wife-nl-finance.ts for the 400-line budget; merged into each
 * track's `classifyTerms` there.
 */

export const TASHI_MEASURED_TERMS = {
  fpa: [
    "assistant controller", "junior controller", "regio controller", "regional controller",
    "group controller", "plant controller", "project controller", "commercial controller",
    "finance controller", "financial control", "financial planning", "finance specialist",
    "finance officer", "finance strategy", "strategic finance", "consultant finance",
    "finance & data analyst", "finance data analyst",
  ],
  "finance-ops": [
    "accounts payable", "accounts receivable", "finance administrator", "tax specialist",
    "tax consultant", "consultant tax", "analyst tax", "tax associate", "tax filing",
    "indirect tax", "direct tax", "transfer pricing",
    "financial due diligence", "client due diligence", "enhanced due diligence",
  ],
  "compliance-kyc": ["compliance officer", "financial crime", "transaction monitoring", "fraud analyst"],
  auditor: [
    "internal audit", "it audit", "audit & assurance", "audit and assurance", "audit trainee",
    "trainee audit", "assurance associate", "risk analyst", "analyst risk", "risk specialist",
    "risk officer", "it auditor", "junior auditor", "financial auditor",
  ],
  accountant: ["accounting analyst", "accounting officer"],
} as const satisfies Record<string, readonly string[]>;

/** See the header: whole-word phrases that make a title none of her tracks. */
export const TASHI_REJECT_TITLE_TERMS = [
  // A student job is not her level (English, Dutch, and the compound forms Dutch employers write).
  "working student", "werkstudent",
  "stage", "stagiair", "stagiaire", "meeloopstage", "meewerkstage", "afstudeerstage",
  // Portuguese, from the one title measured. Whole words that no English or Dutch finance title contains.
  "coordenador", "planejamento", "financeiro", "financeira", "análise",
] as const satisfies readonly string[];
