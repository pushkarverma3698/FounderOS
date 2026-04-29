# FounderOS V8 Upgrade Notes: The Sovereign Transition
**Version:** 8.0 | **Release Date:** April 13, 2026

## 1. M4 Memory Mastery: 16GB RAM Optimization
V8 introduces aggressive memory management for M4 devices with 16GB Unified Memory.
- **VRAM Flushing**: `MLXModelManager.unload_model()` now manually invokes garbage collection and clears weights after background daemons (AutoDream) finish, preventing system swap lag.
- **Hybrid Brains**: The "Coordinator" (CEO) and heavy "Senior Dev" logic have been moved to high-reasoning cloud tiers (o3-mini-high) to keep RAM free for local worker swarms.

## 2. Knowledge Wiki: Beyond Vector Search
Moving from flat ChromaDB fragments to an interlinked Knowledge Wiki.
- **Pattern**: `memory_extractor.py` now implements a `WikiManager`.
- **Logic**: Extracted facts are written as interlinked Markdown files in `docs/memories/wiki/` using `[[Topic]]` patterns.
- **Benefit**: Agents can now reason across linked nodes of knowledge, mimicking a human's "connected" memory.

## 3. Sovereign Negotiation (A2A)
Equipping FounderOS with the ability to "deal" with other AI agents.
- **A2ANegotiator**: A new logic layer in `a2a_gateway.py` that evaluates external agent offers (cost, ETA, quality).
- **Automation**: Agents can now autonomously reject partner offers that exceed Chairman-defined budget limits.
- **Simulation**: Added `PartnerAgentSimulator` to enable testing of negotiation loops in a isolated environment.

## 4. Native Tooling: Closing the Reliability Gap
In V8, we have moved beyond fragile bash-based automation.
- **Location**: `.c-suite/tools/`
- **Modules**:
    - `manager_upwork.py`: Structured bidding and lead intake logic.
    - `manager_github.py`: Native REST API interaction for PR reviews and issue management.
- **Impact**: Significant reduction in "Bash Syntax Errors" and improved tool-calling reliability.

---

## 5. Migration Guide from V7
- **Registry Update**: Ensure your high-stakes agents are set to the `code` cascade in `registry.py`.
- **Tools**: All agents should now favor calling the new native Python managers instead of raw bash for Upwork/GitHub tasks.
- **Wiki**: Run `AutoDream` once to populate your first Wiki entries from existing conversation historical logs.

*The FounderOS V8 Engine is now Sovereign.*
