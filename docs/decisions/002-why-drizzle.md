# ADR-002: Why drizzle-orm Instead of Prisma

**Date:** 2025-05  
**Status:** Accepted  
**Context:** FounderOS needs a TypeScript ORM for PostgreSQL — schema definition, migrations, and type-safe query building.

---

## The Problem

We need an ORM that:
1. Provides full TypeScript type safety without a separate codegen step
2. Handles migrations cleanly in a Docker/CI environment
3. Doesn't hide SQL — our queries need to be readable and debuggable
4. Works well alongside LangGraph's `PostgresSaver` (which manages its own tables)
5. Is explainable in a job interview ("why drizzle over Prisma?" is a common question)

---

## Options Considered

### Option A: Prisma
The most popular Node.js ORM. Schema defined in `.prisma` files, generates a type-safe client.

**Pros:** Huge ecosystem, great docs, excellent DX for CRUD.  
**Cons:**
- **Code generation step** — schema changes require running `prisma generate` before TypeScript can compile. In CI and Docker builds, this adds a step that can silently break.
- **Prisma Schema Language** — a separate DSL that isn't TypeScript. Another thing to learn and keep in sync.
- **Migration complexity** — `prisma migrate dev` vs `prisma migrate deploy` has footguns in production (interactive vs non-interactive modes). Had to special-case this in the old Python codebase.
- **Heavy runtime** — Prisma Client JS is a significant bundle. For a Node.js server this is less critical, but it adds coldstart overhead.
- **SQL is hidden** — Complex queries require raw `$queryRaw` which loses type safety. Drizzle's SQL-like API keeps everything typed.

### Option B: drizzle-orm + drizzle-kit
TypeScript-first ORM where the schema IS your TypeScript type definitions.

**Pros:**
- **Schema = TypeScript** — define tables in `.ts` files, types are derived automatically from the schema definition. No codegen step.
- **SQL-like API** — `.select().from().where()` is transparent; you know exactly what SQL is generated.
- **`drizzle-kit generate`** — generates SQL migration files from schema diffs. These are committed to `git`, reviewed in PRs, and applied idempotently with `drizzle-kit migrate`.
- **Lightweight** — no query engine, just SQL building. Plays nicely alongside LangGraph's own `pg` connection.
- **Easier to explain** — "it's thin wrapper over SQL that gives you TypeScript types" is a clear value proposition.

**Cons:**
- Smaller ecosystem than Prisma. Less StackOverflow coverage.
- The API changes more frequently than Prisma.

### Option C: Raw `pg` + hand-written SQL
Maximum control, zero abstraction.

**Pros:** No ORM overhead. SQL is exactly what you write.  
**Cons:** No type safety on query results. Migration management is manual. We already have `pg` for the LangGraph checkpointer — using raw SQL everywhere would mean duplicating migration logic and losing the type safety that TypeScript promises.

---

## Decision: drizzle-orm

The key insight: **the schema IS the types**.

```typescript
// src/db/schema.ts
export const interruptRegistry = pgTable("interrupt_registry", {
  interrupt_id: uuid("interrupt_id").primaryKey().defaultRandom(),
  thread_id:    text("thread_id").notNull(),
  status:       text("status").notNull().default("pending"),
  expires_at:   timestamp("expires_at", { withTimezone: true }).notNull(),
  // ...
});

// These types are DERIVED from the schema — no codegen needed
export type InterruptRegistry    = typeof interruptRegistry.$inferSelect;
export type NewInterruptRegistry = typeof interruptRegistry.$inferInsert;
```

Queries are typed automatically:

```typescript
const row = await db
  .select()
  .from(interruptRegistry)
  .where(eq(interruptRegistry.interrupt_id, id))
  .limit(1);
// row[0] is typed as InterruptRegistry | undefined — no type assertion needed
```

### Migration Workflow

```bash
# 1. Edit src/db/schema.ts
# 2. Generate SQL migration file
npx drizzle-kit generate   # → drizzle/0001_add_column.sql

# 3. Apply migration (in CI / Docker entrypoint)
npx drizzle-kit migrate    # or tsx scripts/setup-db.ts
```

The SQL migration files are in `git` — reviewable in PRs, auditable, reversible.

---

## Consequences

- **Import drizzle operations explicitly** — `import { eq, and, desc } from "drizzle-orm"` — no magic query builder on the client.
- **`drizzle/` folder in git** — migration SQL files are committed. Do not add to `.gitignore`.
- **Version sensitivity** — drizzle-orm `0.36.x` and `0.38.x` have different import paths for some utilities. Pin the version in `package.json`.
- **`drizzle.config.ts` required** — drizzle-kit needs this to locate the schema and output directory.
- **No Prisma** — if a new team member adds Prisma as a "convenience", remove it. Two ORMs managing the same tables will cause schema drift.
