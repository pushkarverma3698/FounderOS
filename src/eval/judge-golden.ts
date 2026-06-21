/**
 * Golden test cases for judge calibration.
 * Run via: pnpm judge:eval
 * Requires ANTHROPIC_API_KEY. Exit 0 if overall accuracy >= 80%.
 */

export type JudgeChannel = "linkedin" | "outreach" | "rag_answer";

export interface JudgeGoldenCase {
  id: string;
  channel: JudgeChannel;
  input: {
    text?: string;
    query?: string;
    chunks?: string[];
  };
  expectedVerdict: "pass" | "revise";
  note?: string;
}

export const JUDGE_GOLDEN_CASES: JudgeGoldenCase[] = [
  // ── LinkedIn PASS (5 cases) ─────────────────────────────────────────────────
  {
    id: "li-pass-01",
    channel: "linkedin",
    input: {
      text: "We shipped a new AI research pipeline at Turicks this week that cuts manual work by 40%. Sharing what we learned about multi-agent coordination for any founders building on top of LLMs.",
    },
    expectedVerdict: "pass",
    note: "Concrete metric, specific audience, founder voice",
  },
  {
    id: "li-pass-02",
    channel: "linkedin",
    input: {
      text: "Three mistakes I made building my first LangGraph agent — and how I'd approach it differently today:\n1. Skipping eval harness early on\n2. Not separating generator from critic\n3. Treating HITL as an afterthought",
    },
    expectedVerdict: "pass",
    note: "Listicle with real learnings, no hype",
  },
  {
    id: "li-pass-03",
    channel: "linkedin",
    input: {
      text: "Turicks helped Naggar Retreat increase direct bookings by 28% in Q1 by replacing manual outreach with an AI-driven guest follow-up system. Happy to share what worked if you're in hospitality.",
    },
    expectedVerdict: "pass",
    note: "Real case study with specific number and clear CTA",
  },
  {
    id: "li-pass-04",
    channel: "linkedin",
    input: {
      text: "Eval-driven AI development changed how I think about shipping. The rule: if you can't measure it, you can't improve it. We went from 79% → 90% routing accuracy in two iterations once we had a golden test set.",
    },
    expectedVerdict: "pass",
    note: "Technical credibility with specific numbers, practical insight",
  },
  {
    id: "li-pass-05",
    channel: "linkedin",
    input: {
      text: "What does 'production-grade AI' actually mean? For us it means: HITL gates on every external send, idempotency on every action, and a weekly QA audit. Happy to talk through the architecture.",
    },
    expectedVerdict: "pass",
    note: "Specific technical definition, no generic AI buzzwords",
  },

  // ── LinkedIn REVISE (5 cases) ────────────────────────────────────────────────
  {
    id: "li-revise-01",
    channel: "linkedin",
    input: {
      text: "AI is revolutionizing the way businesses operate! At Turicks we leverage cutting-edge artificial intelligence and machine learning to transform your workflows and unlock incredible value. Let's connect!",
    },
    expectedVerdict: "revise",
    note: "Generic AI buzzword soup, no substance",
  },
  {
    id: "li-revise-02",
    channel: "linkedin",
    input: {
      text: "Excited to share that Turicks is now offering AI solutions for all your business needs! We use the latest LLMs to supercharge productivity. DM me to learn more about our game-changing services.",
    },
    expectedVerdict: "revise",
    note: "Hype language, no specifics, weak CTA",
  },
  {
    id: "li-revise-03",
    channel: "linkedin",
    input: {
      text: "The future of AI is here and it's amazing! I'm so grateful to be working on such transformative technology that will change everything we know about how humans and machines work together.",
    },
    expectedVerdict: "revise",
    note: "Inspirational fluff with zero concrete content",
  },
  {
    id: "li-revise-04",
    channel: "linkedin",
    input: {
      text: "Just deployed our newest AI model! It achieves 99.9% accuracy on all tasks and can handle any business challenge you throw at it. The results are incredible — truly next-level performance.",
    },
    expectedVerdict: "revise",
    note: "Factual overreach (99.9% accuracy on all tasks)",
  },
  {
    id: "li-revise-05",
    channel: "linkedin",
    input: {
      text: "Thrilled to announce my new position! Looking forward to this exciting journey ahead and all the amazing things we'll accomplish together as a team. Big things coming — stay tuned!!",
    },
    expectedVerdict: "revise",
    note: "Zero information content, excessive exclamation marks",
  },

  // ── RAG Answer PASS (5 cases) ────────────────────────────────────────────────
  {
    id: "rag-pass-01",
    channel: "rag_answer",
    input: {
      query: "What is Turicks' ideal customer profile?",
      chunks: [
        "Turicks targets B2B SaaS founders and bootstrapped tech companies with 1-20 employees who are spending 10+ hours per week on repetitive research, outreach, or content tasks. Revenue range: $100K-$2M ARR. Technical enough to appreciate AI but lacking in-house ML expertise.",
      ],
    },
    expectedVerdict: "pass",
    note: "Directly answers ICP with specific parameters",
  },
  {
    id: "rag-pass-02",
    channel: "rag_answer",
    input: {
      query: "How does FounderOS handle HITL approval?",
      chunks: [
        "HITL (Human In The Loop) approval uses LangGraph interrupt() after writing to the hitl_approvals table. This ensures recoverability if the process crashes. The bot sends an inline keyboard approval card via Telegram. The founder taps Approve or Reject. Approved actions are executed once (idempotency guard via action_log). Rejected actions clear the thread.",
      ],
    },
    expectedVerdict: "pass",
    note: "Technical explanation directly answering the query",
  },
  {
    id: "rag-pass-03",
    channel: "rag_answer",
    input: {
      query: "What is Pushkar's professional background?",
      chunks: [
        "Pushkar Verma is an AI engineer and founder of Turicks, an AI agency. Previously worked at enterprise software companies as a backend engineer. Built FounderOS as a production multi-agent system. Based in [location]. LinkedIn: pushkarverma3698. Expertise: TypeScript, LangGraph, LLM orchestration, agent evaluation.",
      ],
    },
    expectedVerdict: "pass",
    note: "Profile information directly answering the query",
  },
  {
    id: "rag-pass-04",
    channel: "rag_answer",
    input: {
      query: "What departments does the FounderOS office have?",
      chunks: [
        "FounderOS has 7 departments: research (web search, knowledge lookup), comms (email, calendar), engineering (GitHub read/write, Claude Code executor), marketing (LinkedIn posts), sales (prospecting + outreach), personal (file/shell/browser laptop operator), and jobhunt (job search + CV + applications). Each runs as a separate ReAct agent under the supervisor.",
      ],
    },
    expectedVerdict: "pass",
    note: "Complete, specific list directly answering the query",
  },
  {
    id: "rag-pass-05",
    channel: "rag_answer",
    input: {
      query: "What is the Naggar Retreat?",
      chunks: [
        "Naggar Retreat is a boutique hospitality business — a guesthouse/retreat in Naggar, Himachal Pradesh, India. It is one of the two businesses Turicks operates AI automation for. Use case: AI-driven direct booking outreach and guest follow-up to reduce dependency on OTA platforms.",
      ],
    },
    expectedVerdict: "pass",
    note: "Business description clearly answering the query",
  },

  // ── RAG Answer REVISE (5 cases) ─────────────────────────────────────────────
  {
    id: "rag-revise-01",
    channel: "rag_answer",
    input: {
      query: "What is Turicks' pricing model?",
      chunks: [
        "Turicks was founded with a mission to help founders automate their operations. The team is passionate about AI and building impactful products.",
      ],
    },
    expectedVerdict: "revise",
    note: "Chunks are completely off-topic — answer would require fabrication",
  },
  {
    id: "rag-revise-02",
    channel: "rag_answer",
    input: {
      query: "How do I deploy FounderOS to production?",
      chunks: [
        "FounderOS is a multi-agent system built with LangGraph and TypeScript.",
      ],
    },
    expectedVerdict: "revise",
    note: "Too sparse — mentions the system but gives no deployment steps",
  },
  {
    id: "rag-revise-03",
    channel: "rag_answer",
    input: {
      query: "What is Pushkar's email address?",
      chunks: [
        "Contact information can be found on the website. Pushkar is available for consulting engagements and strategic advisory.",
      ],
    },
    expectedVerdict: "revise",
    note: "Vague — does not answer the specific query",
  },
  {
    id: "rag-revise-04",
    channel: "rag_answer",
    input: {
      query: "What were the results of the A/B test on LinkedIn outreach?",
      chunks: [
        "LinkedIn outreach is one of the channels Turicks uses for lead generation. The marketing department handles LinkedIn posts.",
      ],
    },
    expectedVerdict: "revise",
    note: "Tangentially related but does not answer the A/B test question",
  },
  {
    id: "rag-revise-05",
    channel: "rag_answer",
    input: {
      query: "What is the monthly burn rate for the Turicks agency?",
      chunks: [
        "Financial metrics vary by quarter. Business performance depends on client retention and new contract acquisition.",
      ],
    },
    expectedVerdict: "revise",
    note: "Generic non-answer to a specific financial query",
  },
];
