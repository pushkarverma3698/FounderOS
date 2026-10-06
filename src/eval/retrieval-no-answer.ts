/**
 * FounderOS — retrieval no-answer golden cases (AG-025)
 * =====================================================
 * Questions the brain holds NO document for. A correct reader abstains
 * ("No strong match") instead of presenting its nearest neighbour as an answer.
 * `pnpm eval:retrieval` should show a top cosine below BRAIN_ABSTAIN_SIMILARITY
 * (src/db/brain-hit-view.ts) for each; a case that clears it is a calibration finding,
 * not a case to delete. Subjects sit outside FounderOS, Turicks, Oplify and the job search.
 */
export interface NoAnswerCase {
  readonly id: string;
  readonly query: string;
  readonly rationale: string;
}

export const RETRIEVAL_NO_ANSWER_CASES: readonly NoAnswerCase[] = [
  { id: "no-answer-sourdough", query: "What hydration ratio did we settle on for the sourdough starter?", rationale: "Baking is not a topic anywhere in the corpus." },
  { id: "no-answer-fifa", query: "Who won the 2022 FIFA World Cup final and by what score?", rationale: "Sports trivia; the brain holds company and engineering records only." },
  { id: "no-answer-mortgage", query: "What interest rate did we lock for the Lisbon apartment mortgage?", rationale: "No property or mortgage record exists in any source." },
  { id: "no-answer-kubernetes-operator", query: "Which Kubernetes operator did we choose for the Cassandra cluster?", rationale: "FounderOS runs on one VPS with Postgres; no Kubernetes or Cassandra decision exists." },
  { id: "no-answer-venue", query: "Which venue did the team book for the annual anniversary dinner?", rationale: "No event-booking records exist." },
];
