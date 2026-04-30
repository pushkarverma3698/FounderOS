# `config.py` — Component Reference

## 1. Description
`config.py` houses the economic, circuit-breaking, and resilient structural logic of FounderOS. It contains the Model Cascaded routing dictionary ensuring the system remains highly available regardless of downstream API outages.

## 2. Core Elements
- `TIER_0` to `TIER_5` constant mappings.
- `TPM_LIMITS`: Hardcoded tokens-per-minute array governing model allocations per provider.

## 3. Key Functions / V8 Features
1. **MLX Native Core (V8 Optimization)**: Optimizes local execution for Apple M4. `load_model()` uses 4-bit quantization to fit within 16GB RAM.
2. **Forced Local Mode (Active)**: All agent cascades are configured to prioritize `local` execution. 
3. **Server-First Logic (V8.2)**: To prevent double-loading models into RAM (critical for 16GB M4 Macs), the system now checks if the `mlx_lm.server` is running on port 8000. If active, it routes all local requests through the server instead of invoking the native kernel.
4. **VRAM Flushing**: `unload_model()` flushes weights from Unified Memory to prevent system swap overhead during background swarms.
3. **High-Reasoning Cascades**: Integration of `o3-mini-high` for logical "Sovereign" decision making.
4. `call_with_fallback()`: Central router that prioritizes Native Kernels before cloud providers.

## 4. Mermaid Flowchart
```mermaid
graph TD
    Trigger((Agent Wants LLM)) --> A{TPM Budget Available?}
    A -- NO --> B[Reject early to save cost]
    A -- YES --> C[call_with_fallback]
    
    C --> D{Is Local Tier?}
    D -- YES --> E{Is HTTP Server Up?}
    E -- YES --> F[Use Local HTTP Server]
    E -- NO --> G[Attempt Native MLX Kernel]
    G -- Success --> V8[Unload Model / Flush RAM]
    V8 --> Z((Return Result))
    F --> Z

    D -- NO --> G[Attempt Cloud Model 1]
    G -- 200 OK --> Z
    G -- Error --> H[Apply Exponential Jitter]
    H --> I[Attempt Cloud Model 2]
    I --> Z
```
