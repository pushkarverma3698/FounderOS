/**
 * FounderOS — Cognee Entity-Graph Memory Drizzle Schema
 * ====================================================
 * Stores entity nodes and subject-predicate-object triples for graph-RAG reasoning.
 */

import { pgTable, text, timestamp, uuid, real, index } from "drizzle-orm/pg-core";

export const knowledgeEntities = pgTable(
  "knowledge_entities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull().unique(),
    entityType: text("entity_type").notNull().default("concept"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_knowledge_entities_name").on(table.name),
  ],
);

export const knowledgeTriples = pgTable(
  "knowledge_triples",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    subjectId: uuid("subject_id").references(() => knowledgeEntities.id, { onDelete: "cascade" }).notNull(),
    predicate: text("predicate").notNull(),
    objectId: uuid("object_id").references(() => knowledgeEntities.id, { onDelete: "cascade" }).notNull(),
    confidence: real("confidence").default(1.0).notNull(),
    source: text("source"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_triples_subject").on(table.subjectId),
    index("idx_triples_object").on(table.objectId),
  ],
);
