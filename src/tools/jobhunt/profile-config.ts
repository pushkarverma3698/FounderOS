/**
 * FounderOS — Job Search Profile Config
 * =====================================
 * Structured configuration for candidate profiles. Decouples hardcoded candidate
 * traits (Pushkar / Tech / NL HSM) into reusable, pluggable profiles.
 */

import { z } from "zod";

export const ProfileTrackSchema = z.object({
  id: z.string(),
  name: z.string(),
  titles: z.array(z.string()),
  classifyTerms: z.array(z.string()).default([]),
  cvPath: z.string().optional(),
});

export const CountryConfigSchema = z.object({
  code: z.string(), // ISO alpha-2 e.g. "NL", "IN", "DE"
  names: z.array(z.string()), // e.g. ["netherlands", "nederland", "holland"]
  cities: z.array(z.string()), // e.g. ["amsterdam", "rotterdam", ...]
  atsLocations: z.array(z.string()).default([]), // Location search string for ATS queries
});

export const JobSearchProfileSchema = z.object({
  id: z.string(), // e.g. "pushkar-nl-tech", "wife-nl-finance"
  tenantId: z.string().default("turicks"),
  candidateName: z.string(),
  dob: z.date(),
  portfolioUrl: z.string().optional(),
  
  // Experience & seniority
  experienceYears: z.number(),
  maxYearsDemanded: z.number(),
  maxYearsStretch: z.number(),

  /**
   * The permit bases this candidate actually holds, strongest-commitment first.
   *
   * A DECLARED FACT about a person — never inferred. There is deliberately no
   * `visaRequiresSponsor` boolean beside it: whether the IND recognised-sponsor
   * register applies is a property of the BASIS (see `gateProfile` in
   * permit-routes.ts), not of the candidate. A profile-level flag was tried and
   * removed on 2026-09-04 because nothing read it while the review that shipped
   * it claimed it gated the register lookup.
   *
   * Values must be `PermitBasis` strings; typed as `string` here only to keep
   * permit-routes.ts → profile-config.ts a one-way import. Unknown values are
   * rejected by `basesForPosting`, which falls back to the strictest gates.
   */
  permitBases: z.array(z.string()).nonempty(),

  // Salary criteria. The BINDING figures live in criteria.ts (the dated IND
  // table); these are display copies for prompt text and must match it.
  under30MonthlyEurFloor: z.number().optional(),
  over30MonthlyEurFloor: z.number().optional(),
  minInrLpaFloor: z.number().optional(),

  // Location & Countries
  targetCountries: z.array(CountryConfigSchema),
  
  // Tracks & Keywords
  tracks: z.record(z.string(), ProfileTrackSchema),
  trackPriority: z.array(z.string()),
  
  // Skills & Vocabulary
  skillsDictionaryName: z.string().default("tech"), // "tech" | "finance"
  
  // Base CV — optional: every read site (brief-cv.ts, gaps.ts, tailor-cv.ts)
  // already treats an absent value as "fall back to PERSONAL_CV_PATH/_DIR",
  // which is the correct behavior for a profile with no candidate-specific CV.
  baseCvPath: z.string().optional(),
  
  // Delivery/Reporting
  sheetId: z.string().optional(),
  telegramChatId: z.string().optional(),
});

export type JobSearchProfile = z.infer<typeof JobSearchProfileSchema>;
export type ProfileTrack = z.infer<typeof ProfileTrackSchema>;
export type CountryConfig = z.infer<typeof CountryConfigSchema>;

/** Built-in profile for Pushkar Verma (Tech / NL + IN) */
export const PUSHKAR_PROFILE: JobSearchProfile = {
  id: "pushkar-nl-tech",
  tenantId: "turicks",
  candidateName: "Pushkar Verma",
  dob: new Date("1998-06-03T00:00:00Z"),
  portfolioUrl: "https://github.com/pushkarverma3698/FounderOS",
  
  experienceYears: 3.5,
  maxYearsDemanded: 4,
  maxYearsStretch: 6,

  permitBases: ["hsm", "partner-permit", "remote-contract", "india-local"],

  under30MonthlyEurFloor: 4357,
  over30MonthlyEurFloor: 5942,
  minInrLpaFloor: 15,

  targetCountries: [
    {
      code: "NL",
      names: ["netherlands", "the netherlands", "nederland", "holland"],
      cities: [
        "amsterdam", "rotterdam", "utrecht", "eindhoven", "den haag", "the hague",
        "groningen", "tilburg", "almere", "breda", "nijmegen", "haarlem", "arnhem",
        "amersfoort", "delft", "leiden", "zwolle", "maastricht", "hilversum", "schiphol",
        "hoofddorp", "amstelveen", "diemen", "zaandam", "purmerend", "hoorn", "alkmaar",
        "lelystad", "apeldoorn", "deventer", "enschede", "hengelo", "zutphen", "doetinchem",
        "harderwijk", "leeuwarden", "drachten", "sneek", "heerenveen", "assen", "emmen",
        "meppel", "hoogeveen", "zoetermeer", "rijswijk", "delfgauw", "wassenaar", "katwijk",
        "noordwijk", "dordrecht", "gouda", "schiedam", "vlaardingen", "barendrecht",
        "gorinchem", "nieuwegein", "houten", "woerden", "veenendaal", "wageningen",
        "zeist", "soest", "den bosch", "'s-hertogenbosch", "hertogenbosch", "helmond",
        "veldhoven", "oosterhout", "roosendaal", "bergen op zoom", "venlo", "roermond",
        "sittard", "heerlen", "waalwijk", "tiel", "noord-brabant", "north brabant",
        "gelderland", "overijssel", "friesland", "drenthe", "flevoland",
      ],
      atsLocations: ["Netherlands"],
    },
    {
      code: "IN",
      names: ["india", "bharat"],
      cities: [
        "bengaluru", "bangalore", "hyderabad", "pune", "mumbai", "chennai", "new delhi",
        "delhi", "noida", "gurgaon", "gurugram", "kolkata", "ahmedabad", "jaipur", "indore",
        "chandigarh", "kochi", "coimbatore", "thiruvananthapuram", "bhubaneswar", "lucknow",
        "varanasi", "bareilly", "mysore", "mysuru", "nashik", "tirupati", "vadodara", "surat",
        "nagpur", "visakhapatnam", "vizag", "trivandrum", "mohali", "bhopal", "rajkot",
        "faridabad", "ghaziabad", "thane", "navi mumbai", "whitefield", "hinjewadi",
        "madurai", "tiruchirappalli", "guwahati", "patna", "kanpur", "dehradun", "udaipur",
        "vijayawada", "raipur", "ludhiana", "amritsar", "agra", "meerut", "gandhinagar",
        "hubli", "warangal", "vellore", "jodhpur", "maharashtra", "karnataka", "tamil nadu",
        "telangana", "uttar pradesh", "gujarat", "haryana", "west bengal", "kerala",
        "rajasthan", "andhra pradesh", "madhya pradesh", "odisha", "delhi ncr",
      ],
      atsLocations: ["India"],
    },
  ],

  tracks: {
    ai: {
      id: "ai",
      name: "AI Engineer",
      titles: ["AI Engineer:*", "AI Developer:*", "Machine Learning Engineer:*", "LLM Engineer:*", "MLOps Engineer:*", "GenAI:*"],
      classifyTerms: ["ai engineer", "ml engineer", "machine learning engineer", "llm engineer", "genai", "prompt engineer", "ai developer"],
    },
    fullstack: {
      id: "fullstack",
      name: "Full Stack Engineer",
      titles: ["Full Stack:*", "Full-Stack:*", "Fullstack:*", "Founding Engineer:*", "Product Engineer:*"],
      classifyTerms: ["full stack", "fullstack", "full-stack", "founding engineer", "product engineer"],
    },
    backend: {
      id: "backend",
      name: "Backend Engineer",
      titles: ["Backend Engineer:*", "Back End Engineer:*", "Backend Developer:*", "Software Engineer:*", "Software Developer:*", "Platform Engineer:*", "Data Engineer:*", "Node.js Developer:*"],
      classifyTerms: ["backend engineer", "backend developer", "platform engineer", "data engineer", "node.js developer"],
    },
    frontend: {
      id: "frontend",
      name: "Frontend Engineer",
      titles: ["Frontend Engineer:*", "Front End Engineer:*", "Frontend Developer:*", "Front End Developer:*", "Front-End Developer:*", "React Developer:*", "React Engineer:*", "UI Engineer:*"],
      classifyTerms: ["frontend engineer", "frontend developer", "react developer", "react engineer", "ui engineer"],
    },
  },

  trackPriority: ["ai", "fullstack", "backend", "frontend"],
  skillsDictionaryName: "tech",
};

import { WIFE_FINANCE_PROFILE } from "./profiles/wife-nl-finance.js";

/**
 * The profile every unqualified call resolves to.
 *
 * Named rather than implicit on purpose. Callers that mean "Pushkar" now say so,
 * and a caller that forgot to pass a profile is indistinguishable from one that
 * meant the default — which is exactly how the first pass at this shipped seven
 * DB helpers whose "default" was *no filter at all*, spanning every profile.
 */
export const DEFAULT_PROFILE_ID = "pushkar-nl-tech";

/** Registry of active profiles. */
const PROFILES: Record<string, JobSearchProfile> = {};

/**
 * Validate and register a profile.
 *
 * Parsed against the schema rather than merely typed by it. A `JobSearchProfile`
 * annotation is erased at runtime, so before this the Zod schema described the
 * shape without ever checking it — a profile with an empty `permitBases` or a
 * `trackPriority` naming a track it does not define would have been caught only
 * by whatever crashed first, screening runs later.
 */
export function registerProfile(profile: JobSearchProfile): JobSearchProfile {
  const parsed = JobSearchProfileSchema.parse(profile);
  for (const trackId of parsed.trackPriority) {
    if (!parsed.tracks[trackId]) {
      throw new Error(
        `Profile "${parsed.id}" lists "${trackId}" in trackPriority but defines no such track. ` +
          `A brief built from it would read a CV for a track that does not exist and score every row 0.`,
      );
    }
  }
  PROFILES[parsed.id] = parsed;
  return parsed;
}

registerProfile(PUSHKAR_PROFILE);
registerProfile(WIFE_FINANCE_PROFILE);

export function getProfile(id: string = DEFAULT_PROFILE_ID): JobSearchProfile {
  const profile = PROFILES[id];
  if (!profile) {
    throw new Error(
      `JobSearchProfile not found for id: "${id}". Registered profiles: ${Object.keys(PROFILES).join(", ")}`,
    );
  }
  return profile;
}

/**
 * Every registered profile.
 *
 * This is what the sweeps iterate. A profile that is registered but never swept
 * produces nothing, which is indistinguishable from an empty market — so adding
 * a profile here is what puts it into production, and there is no second switch.
 */
export function listProfiles(): JobSearchProfile[] {
  return Object.values(PROFILES);
}
