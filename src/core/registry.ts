/**
 * FounderOS — Central System Registry
 * =====================================
 * Single source of truth for Companies, Agents, and Routing.
 *
 * Adding a new company or agent requires modifying ONLY this file.
 * No hardcoded "turicks" / "naggar" strings anywhere else in the codebase.
 */

// ── Data Models ────────────────────────────────────────────────────────────────

export type CascadeTier =
  | "ceo"
  | "deep_research"
  | "md"
  | "code"
  | "nano"
  | "local"
  | "video"
  | "critic";

export type Department = "sales" | "engineering" | "marketing" | "social" | "prospecting";

export interface TuricksProfile {
  services: string[];
  /** Primary capability areas — used in prompts and pitch materials */
  specializations: string[];
  /** One-line market positioning */
  positioning: string;
  website: string;
  pricing: string;
  target_geo: string[];
  icp: string;
  differentiator: string;
}

export interface NaggarProfile {
  type: string;
  location: string;
  produce: string[];
  base_rate: string;
  booking_platforms: string[];
  brand: string;
}

export interface CrossProfile {
  type: string;
  mission: string;
}

export type CompanyProfile = TuricksProfile | NaggarProfile | CrossProfile;

export interface Company {
  readonly name: string;
  readonly readable_name: string;
  readonly memory_collection: string;
  readonly telegram_topic_id: number;
  readonly profile: CompanyProfile;
  agents: string[]; // populated at init via backlinks
}

export interface Agent {
  readonly name: string;
  readonly company_assignment: string; // "turicks" | "naggar" | "cross"
  readonly cascade_tier: CascadeTier;
  readonly allowed_collections: string[];
  readonly allowed_tools: string[];
  /** Which department pod this agent belongs to — used by supervisor for routing. */
  readonly department?: Department;
}

// ── Company Registry ────────────────────────────────────────────────────────────

const _companies: Record<string, Company> = {
  turicks: {
    name: "turicks",
    readable_name: "Turicks (AI Agency)",
    memory_collection: "turicks_mem",
    telegram_topic_id: parseInt(process.env["TOPIC_TURICKS"] ?? "0"),
    agents: [],
    profile: {
      services: ["AI agents", "LangGraph agentic systems", "UI/UX design", "full-stack software", "business automation"],
      specializations: ["AI agents", "UI/UX design", "full-stack software", "business automation"],
      positioning: "AI-native agency that builds what other agencies only prototype",
      website: "https://turicks.com",
      pricing: "$500 starter → $5,000 retainer",
      target_geo: ["EU", "US"],
      icp: "SME founders $50K–500K ARR who need AI/automation or a design-conscious software team",
      differentiator: "AI-native agency that builds what others only prototype — 3–5 day delivery, design-conscious, working code not decks",
    } satisfies TuricksProfile,
  },

  naggar: {
    name: "naggar",
    readable_name: "Naggar Retreat (Himalayan Farm)",
    memory_collection: "naggar_mem",
    telegram_topic_id: parseInt(process.env["TOPIC_NAGGAR"] ?? "0"),
    agents: [],
    profile: {
      type: "Himalayan farm + premium homestay",
      location: "Naggar, HP | Alt: 1768m | Lat: 31.99, Lon: 77.17",
      produce: ["raspberries", "apples", "walnuts"],
      base_rate: "₹6,000/night",
      booking_platforms: ["Airbnb", "Booking.com", "Direct"],
      brand: "Ahata — farm-to-table culinary experiences",
    } satisfies NaggarProfile,
  },

  cross: {
    name: "cross",
    readable_name: "FounderOS Cross-Company",
    memory_collection: "social_mem",
    telegram_topic_id: parseInt(process.env["TOPIC_BOARDROOM"] ?? "0"),
    agents: [],
    profile: {
      type: "System orchestration and cross-domain management",
      mission: "Maintain agent health, research broad topics, optimise overall cost.",
    } satisfies CrossProfile,
  },
};

// ── Agent Registry ─────────────────────────────────────────────────────────────

const BASE_TOOLS: string[] = ["bash", "read_file", "search_web"];

const _agentList: Agent[] = [
  // ── Turicks Agents ────────────────────────────────────────────────────────
  {
    name: "bidding_sniper",
    company_assignment: "turicks",
    cascade_tier: "code",
    department: "sales",
    allowed_collections: ["turicks_mem"],
    allowed_tools: [...BASE_TOOLS, "chromadb_read", "chromadb_write", "upwork_search", "upwork_submit", "pipeline_add_lead"],
  },
  {
    name: "lead_intel",
    company_assignment: "turicks",
    cascade_tier: "local",
    department: "sales",
    allowed_collections: ["turicks_mem"],
    allowed_tools: [...BASE_TOOLS, "chromadb_read", "chromadb_write", "firecrawl"],
  },
  {
    // Business Development Representative — writes outreach emails after lead_intel research
    name: "bdr",
    company_assignment: "turicks",
    cascade_tier: "md",
    department: "sales",
    allowed_collections: ["turicks_mem"],
    allowed_tools: [...BASE_TOOLS, "write_file", "chromadb_read", "chromadb_write"],
  },
  {
    name: "senior_dev",
    company_assignment: "turicks",
    cascade_tier: "code",
    department: "engineering",
    allowed_collections: ["turicks_mem"],
    allowed_tools: [...BASE_TOOLS, "write_file", "chromadb_read", "chromadb_write", "github_mcp"],
  },
  {
    name: "vibe_coder",
    company_assignment: "turicks",
    cascade_tier: "local",
    department: "engineering",
    allowed_collections: ["turicks_mem"],
    allowed_tools: [...BASE_TOOLS, "write_file", "chromadb_read", "chromadb_write", "github_mcp"],
  },
  {
    name: "qa_tester",
    company_assignment: "turicks",
    cascade_tier: "local",
    department: "engineering",
    allowed_collections: ["turicks_mem"],
    allowed_tools: [...BASE_TOOLS, "chromadb_read", "pytest"],
  },
  {
    name: "proposal_writer",
    company_assignment: "turicks",
    cascade_tier: "md",
    department: "sales",
    allowed_collections: ["turicks_mem"],
    allowed_tools: [...BASE_TOOLS, "write_file", "chromadb_read", "chromadb_write"],
  },
  {
    name: "ops_agent",
    company_assignment: "turicks",
    cascade_tier: "nano",
    allowed_collections: ["turicks_mem"],
    allowed_tools: [...BASE_TOOLS, "chromadb_read", "telegram_send"],
  },
  {
    name: "kb_agent",
    company_assignment: "turicks",
    cascade_tier: "local",
    allowed_collections: ["turicks_mem"],
    allowed_tools: ["bash", "read_file", "write_file", "chromadb_read", "chromadb_write"],
  },
  {
    name: "web_designer",
    company_assignment: "turicks",
    cascade_tier: "md",
    department: "marketing",
    allowed_collections: ["turicks_mem"],
    allowed_tools: [...BASE_TOOLS, "write_file", "chromadb_read", "chromadb_write"],
  },
  {
    name: "seo_specialist",
    company_assignment: "turicks",
    cascade_tier: "deep_research",
    department: "marketing",
    allowed_collections: ["turicks_mem"],
    allowed_tools: [...BASE_TOOLS, "chromadb_read", "chromadb_write", "firecrawl"],
  },
  {
    name: "github_agent",
    company_assignment: "turicks",
    cascade_tier: "md",
    department: "engineering",
    allowed_collections: ["turicks_mem", "social_mem"],
    allowed_tools: [
      ...BASE_TOOLS, "write_file", "chromadb_read", "chromadb_write", "telegram_send",
      "github_get_readme", "github_update_readme", "github_list_repos", "github_update_repo",
      "github_update_profile", "github_star_repo", "github_follow_user", "github_trending",
      "github_get_stats", "github_create_repo",
    ],
  },

  // ── Naggar Agents ─────────────────────────────────────────────────────────
  {
    name: "farm_weather",
    company_assignment: "naggar",
    cascade_tier: "local",
    allowed_collections: ["naggar_mem"],
    allowed_tools: [...BASE_TOOLS, "chromadb_read", "chromadb_write", "openweathermap"],
  },
  {
    name: "yield_scout",
    company_assignment: "naggar",
    cascade_tier: "local",
    allowed_collections: ["naggar_mem"],
    allowed_tools: [...BASE_TOOLS, "chromadb_read", "chromadb_write"],
  },
  {
    name: "booking_concierge",
    company_assignment: "naggar",
    cascade_tier: "nano",
    allowed_collections: ["naggar_mem"],
    allowed_tools: ["bash", "read_file", "chromadb_read", "chromadb_write", "telegram_send"],
  },
  {
    name: "vibe_designer",
    company_assignment: "naggar",
    cascade_tier: "md",
    allowed_collections: ["naggar_mem"],
    allowed_tools: [...BASE_TOOLS, "write_file", "chromadb_read", "chromadb_write"],
  },
  {
    name: "culinary_agent",
    company_assignment: "naggar",
    cascade_tier: "local",
    allowed_collections: ["naggar_mem"],
    allowed_tools: [...BASE_TOOLS, "chromadb_read", "chromadb_write"],
  },
  {
    name: "market_scout",
    company_assignment: "naggar",
    cascade_tier: "deep_research",
    allowed_collections: ["naggar_mem", "social_mem"],
    allowed_tools: [...BASE_TOOLS, "chromadb_read", "chromadb_write", "firecrawl"],
  },
  {
    name: "guest_crm",
    company_assignment: "naggar",
    cascade_tier: "local",
    allowed_collections: ["naggar_mem"],
    allowed_tools: ["bash", "read_file", "write_file", "chromadb_read", "chromadb_write"],
  },
  {
    name: "naggar_kb",
    company_assignment: "naggar",
    cascade_tier: "local",
    allowed_collections: ["naggar_mem"],
    allowed_tools: ["bash", "read_file", "write_file", "chromadb_read", "chromadb_write"],
  },
  {
    name: "video_editor",
    company_assignment: "naggar",
    cascade_tier: "video",
    allowed_collections: ["naggar_mem"],
    allowed_tools: ["bash", "read_file", "chromadb_read", "ffmpeg"],
  },

  // ── Engineer Agents (one per department — autonomous decision-makers) ─────
  {
    /**
     * Sales engineer — owns technical decisions in the sales pod.
     * Runs BEFORE bdr to plan the outreach strategy.
     * HITL gating only for external sends, not for internal decisions.
     */
    name: "sales_engineer",
    company_assignment: "turicks",
    cascade_tier: "md",
    department: "sales",
    allowed_collections: ["turicks_mem"],
    allowed_tools: [...BASE_TOOLS, "write_file", "chromadb_read", "chromadb_write", "pipeline_add_lead"],
  },
  {
    /**
     * Engineering engineer — responsible for all engineering pod decisions.
     * Plans technical approach, assigns tasks to senior_dev or vibe_coder.
     * Full responsibility for delivery quality; HITL only for external pushes.
     */
    name: "eng_engineer",
    company_assignment: "turicks",
    cascade_tier: "md",
    department: "engineering",
    allowed_collections: ["turicks_mem"],
    allowed_tools: [...BASE_TOOLS, "write_file", "chromadb_read", "chromadb_write", "github_mcp"],
  },
  {
    /**
     * Marketing engineer — owns marketing pod decisions and content strategy.
     * Decides which channels + formats to use for each campaign.
     * HITL only for external posts/publishes.
     */
    name: "mktg_engineer",
    company_assignment: "turicks",
    cascade_tier: "md",
    department: "marketing",
    allowed_collections: ["turicks_mem"],
    allowed_tools: [...BASE_TOOLS, "write_file", "chromadb_read", "chromadb_write"],
  },

  // ── Prospecting Agents (Phase 2 — ProspectingPod subgraph) ────────────────
  {
    /** Resolves raw URL/company name to canonical URL, writes lead_pipeline row */
    name: "disambiguate",
    company_assignment: "turicks",
    cascade_tier: "nano",
    department: "prospecting",
    allowed_collections: ["turicks_mem"],
    allowed_tools: [...BASE_TOOLS, "chromadb_read"],
  },
  {
    /** Researches company via Tavily + Firecrawl, caches result in Redis (TTL 7d) */
    name: "prospecting_researcher",
    company_assignment: "turicks",
    cascade_tier: "nano",
    department: "prospecting",
    allowed_collections: ["turicks_mem"],
    allowed_tools: [...BASE_TOOLS, "chromadb_read", "firecrawl"],
  },
  {
    /** Scores ICP fit 0.0–1.0, bands into md (<0.7) or ceo (>=0.7) tier */
    name: "icp_scorer",
    company_assignment: "turicks",
    cascade_tier: "md",
    department: "prospecting",
    allowed_collections: ["turicks_mem"],
    allowed_tools: [...BASE_TOOLS, "chromadb_read"],
  },

  // ── Cross-Company Agents ──────────────────────────────────────────────────
  {
    name: "social_researcher",
    company_assignment: "cross",
    cascade_tier: "deep_research",
    department: "social",
    allowed_collections: ["social_mem"],
    allowed_tools: [...BASE_TOOLS, "chromadb_read", "chromadb_write", "firecrawl"],
  },
  {
    name: "social_handler",
    company_assignment: "cross",
    cascade_tier: "md",
    department: "social",
    allowed_collections: ["social_mem"],
    allowed_tools: [...BASE_TOOLS, "write_file", "chromadb_read", "chromadb_write", "telegram_send", "linkedin_post", "linkedin_get_analytics"],
  },
  {
    name: "platform_growth",
    company_assignment: "cross",
    cascade_tier: "deep_research",
    department: "social",
    allowed_collections: ["social_mem", "turicks_mem"],
    allowed_tools: [...BASE_TOOLS, "chromadb_read", "chromadb_write", "telegram_send", "firecrawl", "linkedin_connect", "github_star_repo", "github_follow_user", "github_trending"],
  },
  {
    name: "linkedin_growth",
    company_assignment: "cross",
    cascade_tier: "md",
    department: "social",
    allowed_collections: ["social_mem"],
    // NOTE: linkedin_connect and linkedin_dm are gated by account warming logic in social pod
    // Do NOT call these tools directly — use the publisher node which enforces safety limits
    allowed_tools: [...BASE_TOOLS, "chromadb_read", "chromadb_write", "telegram_send", "linkedin_post", "linkedin_connect", "linkedin_dm", "firecrawl"],
  },
  {
    name: "cost_watchdog",
    company_assignment: "cross",
    cascade_tier: "md",
    allowed_collections: ["turicks_mem", "naggar_mem", "social_mem"],
    allowed_tools: ["bash", "read_file", "chromadb_read", "chromadb_write"],
  },
  {
    name: "team_therapist",
    company_assignment: "cross",
    cascade_tier: "md",
    allowed_collections: ["turicks_mem", "naggar_mem", "social_mem"],
    allowed_tools: ["bash", "read_file", "chromadb_read", "chromadb_write", "telegram_send"],
  },
  {
    name: "hr_agent",
    company_assignment: "cross",
    cascade_tier: "deep_research",
    allowed_collections: ["turicks_mem", "naggar_mem", "social_mem"],
    allowed_tools: [...BASE_TOOLS, "chromadb_read", "chromadb_write"],
  },
  {
    name: "revenue_scout",
    company_assignment: "cross",
    cascade_tier: "deep_research",
    allowed_collections: ["turicks_mem", "social_mem"],
    allowed_tools: [...BASE_TOOLS, "chromadb_read", "chromadb_write"],
  },
  {
    name: "outreach_agent",
    company_assignment: "cross",
    cascade_tier: "md",
    allowed_collections: ["turicks_mem", "social_mem"],
    allowed_tools: [...BASE_TOOLS, "write_file", "chromadb_read", "chromadb_write", "telegram_send", "firecrawl", "linkedin_dm", "pipeline_add_lead"],
  },
  {
    name: "pipeline_md",
    company_assignment: "cross",
    cascade_tier: "md",
    allowed_collections: ["turicks_mem", "social_mem"],
    allowed_tools: [...BASE_TOOLS, "chromadb_read", "chromadb_write", "telegram_send", "pipeline_summary"],
  },
  {
    name: "scrum_engine",
    company_assignment: "cross",
    cascade_tier: "nano",
    allowed_collections: ["turicks_mem", "naggar_mem", "social_mem"],
    allowed_tools: ["bash", "read_file", "chromadb_read", "chromadb_write", "telegram_send"],
  },
  {
    name: "scrum_pm",
    company_assignment: "cross",
    cascade_tier: "md",
    allowed_collections: ["turicks_mem", "naggar_mem", "social_mem"],
    allowed_tools: ["bash", "read_file", "chromadb_read", "chromadb_write", "telegram_send"],
  },
];

// Build the lookup maps
const _agents: Record<string, Agent> = Object.fromEntries(
  _agentList.map((a) => [a.name, a]),
);

// Populate backlinks: Agent → Company.agents
for (const agent of _agentList) {
  const company = _companies[agent.company_assignment];
  if (company) {
    company.agents.push(agent.name);
  }
}

// ── Accessor Functions ─────────────────────────────────────────────────────────

/** Get a company by its identifier (e.g. "turicks"). */
export function getCompany(name: string): Company | undefined {
  return _companies[name];
}

/** All operating companies, excluding the virtual "cross" tenant. */
export function getAllCompanies(): Company[] {
  return Object.values(_companies).filter((c) => c.name !== "cross");
}

/** Get an agent by its identifier (e.g. "lead_intel"). */
export function getAgent(name: string): Agent | undefined {
  return _agents[name];
}

/** All registered agents. */
export function getAllAgents(): Agent[] {
  return _agentList;
}

/** All agents belonging to a specific company. */
export function getAgentsForCompany(companyName: string): Agent[] {
  const company = getCompany(companyName);
  if (!company) return [];
  return company.agents.flatMap((name) => {
    const a = getAgent(name);
    return a ? [a] : [];
  });
}

/**
 * Resolve which Telegram topic an agent's output should route to.
 * Cross-company social agents go to the Think Tank topic.
 */
export function getAgentTopicId(agentName: string): number {
  const agent = getAgent(agentName);
  if (!agent) return parseInt(process.env["TOPIC_BOARDROOM"] ?? "0");

  if (agent.company_assignment === "cross" && agentName.includes("social")) {
    return parseInt(process.env["TOPIC_THINK_TANK"] ?? "0");
  }

  return _companies[agent.company_assignment]?.telegram_topic_id
    ?? parseInt(process.env["TOPIC_BOARDROOM"] ?? "0");
}
