# `memory.py` — Component Reference

## 1. Description
The `memory.py` file maps local ChromaDB storage volumes. Instead of storing complex data inside of LLM context lengths, FounderOS pushes it here.

## 2. Core Elements
- `COLLECTION_TURICKS`: The agency database silo.
- `COLLECTION_NAGGAR`: The physical farm data silo.

## 3. Key Functions / V8 Features
1. `get_collection(name)`: Dynamically spins up persistent Chroma instances.
2. `store()`: Centralized `upsert` abstraction wrapping metadata.
3. `recall()`: Vector search fetching the Top `n_results`.
4. **WikiManager (V8)**: Evolving JSON fragments into an interlinked Knowledge Wiki in `docs/memories/wiki/` using `[[Topic]]` patterns.
5. `update_wiki()`: Procedurally generates Markdown files from high-confidence extracted facts.

## 4. Mermaid Flowchart
```mermaid
flowchart LR
    A[Agent Node] -->|store()| B((ChromaDB Persistent Layer))
    A -->|recall()| B
    
    B -->|V8 Extraction| C[memory_extractor.py]
    C -->|WikiManager| D[Knowledge Wiki]
    D -->|Markdown| E[[Topic.md]]
    D -->|Markdown| F[[Related_Topic.md]]
    
    E -.->|[[Link]]| F
    F -.->|[[Link]]| E
```
