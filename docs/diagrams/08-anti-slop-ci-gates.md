# 08 — Anti-Slop CI Gates

v2 rotted because nothing stopped complexity from creeping back — every incident
added a layer. v3 encodes "stay simple" as **six machine-checked rules** in
[`scripts/verify-architecture.ts`](../../scripts/verify-architecture.ts), run on
every PR via `pnpm gate`. The agent (and the tired human) can't rebuild the slop,
because the build fails.

```mermaid
flowchart LR
  pr["PR / commit"] --> gate["pnpm gate"]

  subgraph gate_steps["merge gate (in order)"]
    lint["lint · tsc --noEmit"] --> build["build · tsc"]
    build --> wiring["verify:wiring"]
    wiring --> arch["verify:arch"]
    arch --> test["test · $0 offline suite"]
  end

  gate --> gate_steps

  subgraph arch_rules["verify:arch — 6 rules"]
    r1["tombstones<br/>killed modules can't return"]
    r2["regex-routing = 0<br/>no regex router"]
    r3["gateway-imports = 0<br/>kernel ⇏ gateway"]
    r4["kernel-purity = 0<br/>no env/provider in kernel"]
    r5["loc-budget<br/>no src file > 400 lines"]
    r6["fail-open-catch<br/>needs // allow-failopen tag"]
  end

  arch --> arch_rules
  arch_rules --> ratchet[("architecture-baseline.json<br/>debt may ONLY shrink")]

  gate_steps -->|any red| block["❌ blocked"]
  gate_steps -->|all green| merge["✅ mergeable → beta → main"]

  classDef bad fill:#fdd,stroke:#c66;
  class block bad;
```

## The rules

| Rule | What it forbids | Current |
|------|-----------------|---------|
| **tombstones** | Recreating a killed module (`pre-router`, `execution-guard`, `office.ts`, `office-run`, domain subgraphs) | enforced |
| **regex-routing** | Routing a message by regex | `0` ✅ |
| **gateway-imports** | The kernel importing the gateway (wrong direction) | `0` ✅ |
| **kernel-purity** | The kernel reading env or constructing a provider client | `0` ✅ |
| **loc-budget** | Any `src` file over 400 lines (god modules) | enforced |
| **fail-open-catch** | A swallow-and-continue `catch` without an `// allow-failopen: <reason>` tag | ratcheted |

## The ratchet

`governance/architecture-baseline.json` records the known count of each debt. CI compares the PR's count to the baseline: **it may only go down.** You cannot add a new regex router or a new untagged fail-open catch — the counter refuses. Deleting slop is permanent because the gate won't let it grow back.

This is the discipline the [case studies](../turicks-case-studies/) argue for, expressed as code.
