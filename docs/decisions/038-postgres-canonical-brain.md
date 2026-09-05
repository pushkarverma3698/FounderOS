# ADR 038: Postgres as the Canonical Brain

**Date**: 2026-09-05
**Status**: Accepted

## Context
FounderOS previously used a hybrid architecture for long-term memory: Postgres for application state and a separate Python-based FastMCP server (`turicks-brain-rag`) using ChromaDB for IDE integrations (Claude, Cursor, Antigravity). This resulted in fragmented memory, synchronization issues (`brain:sync` drift), duplicated embeddings, and a lack of a single source of truth.

## Decision
1. **PostgreSQL + pgvector is the Single Source of Truth**: Postgres owns all memories, decisions, code knowledge, bugs, architecture decisions, experiments, project state, and embeddings.
2. **Chroma is Deprecated**: No application is allowed to treat Chroma, a local vector DB, a cache, or an IDE directory as authoritative memory.
3. **One Retrieval Implementation**: `hybridRagSearch()` is the canonical retrieval implementation. All clients (FounderOS, Claude, Cursor, Antigravity) use this identical logic via the `searchBrain` contract.
4. **Thin Clients**: FounderOS connects directly to Postgres. IDEs connect to a thin `turicks-brain-mcp` TypeScript adapter that exposes standard endpoints (`search_memory`, `get_memory`, `remember`, `save_decision`, `save_bug`) directly backed by Postgres.
5. **Unified Ingestion**: All writes go through a single `brain_ingest()` pipeline that handles normalization, deduplication, classification, and embedding generation.

## Consequences
- **Positive**: Complete elimination of brain drift. "Is my Chroma fresh?" is no longer a question.
- **Positive**: Simplified architecture. One read path, one write path, one store.
- **Negative**: Requires network connectivity (SSH tunnel or VPN) for IDEs to access the VPS-hosted database during local development.
