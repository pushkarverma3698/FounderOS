// src/tools/b2b/schema.ts
import { pgTable, uuid, varchar, real, jsonb, timestamp } from "drizzle-orm/pg-core";

export const recruiterLeads = pgTable("recruiter_leads", {
  id: uuid("id").defaultRandom().primaryKey(),

  companyName: varchar("company_name", { length: 255 }).notNull(),

  personName: varchar("person_name", { length: 255 }).notNull(),
  title: varchar("title", { length: 255 }),
  linkedinUrl: varchar("linkedin_url", { length: 255 }).notNull(),

  confidenceScore: real("confidence_score").notNull(), // 0.0 - 1.0

  method: varchar("method", { length: 50 }).notNull(),
  // 'url-slug' | 'title-parse' | 'llm-batch'

  state: varchar("state", { length: 50 }).notNull(),
  // 'ACCEPTED' — that's the only state that gets a row now. AMBIGUOUS/EMPTY
  // candidates either get resolved by the LLM batch step or dropped; there's
  // no CAPTCHA/BLOCKED state anymore because nothing in this pipeline tries
  // to push through a block.

  evidence: jsonb("evidence").notNull(), // string[] — why this record was accepted

  createdAt: timestamp("created_at").defaultNow().notNull(),
  lastVerifiedAt: timestamp("last_verified_at").defaultNow().notNull(),
  // Re-check leads older than ~90 days before you actually send outreach —
  // a well-formed record from a stale Google cache can still be wrong about
  // whether this person still works there.
});

// Query-level cache: once you've spent a credit on a dork, never spend it again.
export const serperQueryCache = pgTable("serper_query_cache", {
  id: uuid("id").defaultRandom().primaryKey(),
  query: varchar("query", { length: 500 }).notNull().unique(),
  rawResponse: jsonb("raw_response").notNull(),
  fetchedAt: timestamp("fetched_at").defaultNow().notNull(),
});
