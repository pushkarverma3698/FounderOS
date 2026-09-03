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

  // Visa & legal permit
  visaRequiresSponsor: z.boolean(),
  permitBases: z.array(z.string()), // e.g. ["hsm", "partner-permit", "remote-contract", "india-local"]
  
  // Salary criteria
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
  
  // Base CV
  baseCvPath: z.string(),
  
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

  visaRequiresSponsor: true,
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
  baseCvPath: "data/local_docs/cv-master.md",
};

import { WIFE_FINANCE_PROFILE } from "./profiles/wife-nl-finance.js";

/** Registry of active profiles */
const PROFILES: Record<string, JobSearchProfile> = {
  [PUSHKAR_PROFILE.id]: PUSHKAR_PROFILE,
  [WIFE_FINANCE_PROFILE.id]: WIFE_FINANCE_PROFILE,
};

export function registerProfile(profile: JobSearchProfile): void {
  PROFILES[profile.id] = profile;
}

export function getProfile(id: string = PUSHKAR_PROFILE.id): JobSearchProfile {
  const profile = PROFILES[id];
  if (!profile) {
    throw new Error(`JobSearchProfile not found for id: "${id}". Registered profiles: ${Object.keys(PROFILES).join(", ")}`);
  }
  return profile;
}

export function listProfiles(): JobSearchProfile[] {
  return Object.values(PROFILES);
}
