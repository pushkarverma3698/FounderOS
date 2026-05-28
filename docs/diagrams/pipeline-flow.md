# FounderOS — Pipeline Flows

> Graph-level flows for every department pod and the full outbound prospecting pipeline.

---

## Main FounderGraph (Top Level)

```mermaid
flowchart LR
    START(["▶ START"])
    SUP["🧠 Supervisor\nCEO-tier LLM\nclassifies + routes"]
    END_(["⏹ END"])

    PROS["📡 ProspectingPod\nsubgraph"]
    SALES["💼 SalesPod\nsubgraph"]
    ENG["⚙️ EngineeringPod\nsubgraph"]
    MKT["📣 MarketingPod\nsubgraph"]
    SOC["📱 SocialPod\nsubgraph"]

    START --> SUP
    SUP -->|"department=prospecting"| PROS
    SUP -->|"department=sales"| SALES
    SUP -->|"department=engineering"| ENG
    SUP -->|"department=marketing"| MKT
    SUP -->|"department=social"| SOC

    PROS -->|"outreach_tier set\n(icp_score ≥ 0.4)"| SALES
    PROS -->|"outreach_tier null\n(icp_score < 0.4)"| END_

    SALES --> END_
    ENG --> END_
    MKT --> END_
    SOC --> END_

    style SUP fill:#2d4059,color:#fff
    style PROS fill:#533483,color:#fff
    style SALES fill:#0f3460,color:#fff
```

---

## ProspectingPod — Outbound Lead Qualification

```mermaid
flowchart TD
    START(["▶ raw_input\n(URL or company name)"])

    DISAMB["🔍 disambiguate_node\nNANO tier · ~$0.0001\nCanonicalise URL + company name\nCreate/reuse outbound_leads row"]

    REDIS{{"Redis check\nresearch:{md5(url)}\nTTL 7 days"}}

    RESEARCH_HIT["✅ Cache hit\nReturn cached blob\ncost: $0.00"]
    RESEARCH_MISS["🌐 research_node\nNANO tier · ~$0.001\nTavily web search + LLM extract\npain_points · tech_stack · team_size · funding\nWrite to Redis TTL=7d"]

    ICP["🎯 icp_score_node\nMD tier · ~$0.002\nScore 0.0–1.0 vs Turicks ICP\nWrite to outbound_leads\n(icp_score · icp_rationale · outreach_tier)"]

    ROUTE{{"route_by_score\nPURE FUNCTION — no LLM"}}

    DISQ["🚫 disqualify_node\nTelegram daily digest\ncost: $0"]
    HANDOFF["🤝 handoff_node\nLead ready for SalesPod"]

    END_DISQ(["⏹ END"])
    END_QUAL(["⏩ SalesPod\n(with outreach_tier set)"])

    START --> DISAMB
    DISAMB --> REDIS
    REDIS -->|"HIT"| RESEARCH_HIT
    REDIS -->|"MISS"| RESEARCH_MISS
    RESEARCH_HIT --> ICP
    RESEARCH_MISS --> ICP
    ICP --> ROUTE
    ROUTE -->|"score < 0.4"| DISQ
    ROUTE -->|"score 0.4–0.69\noutreach_tier=md"| HANDOFF
    ROUTE -->|"score ≥ 0.70\noutreach_tier=ceo"| HANDOFF
    DISQ --> END_DISQ
    HANDOFF --> END_QUAL

    style REDIS fill:#533483,color:#fff
    style ROUTE fill:#2d4059,color:#fff
    style DISQ fill:#8b0000,color:#fff
    style HANDOFF fill:#006400,color:#fff
```

---

## SalesPod — Outreach Pipeline

> Updated Phase 2E: `sales_engineer_node` added between quota check and BDR.

```mermaid
flowchart TD
    START(["▶ task\n(prospect info or lead_id)"])

    INTEL["🔍 lead_intel_node\ndeep_research tier\nResearch prospect\nBuild ICP profile + score\noutput: LeadProfile + intel_report"]

    SUPP{{"suppressionCheckEdge\nPURE — queries do_not_contact\nno LLM"}}
    QUOTA{{"quotaCheckEdge\nPURE — Redis INCR quota:{tenant}:{date}\nno LLM"}}

    SE["🧠 sales_engineer_node\nMD tier (Gemini Flash)\nChoose outreach angle autonomously\nangle · hook · value_prop · proof_point · cta\nNo HITL — internal decision"]

    BDR["✍️ bdr_node\nMD or CEO tier (banded by ICP score)\nExecute sales_engineer strategy exactly\nPain-first · ≤150 words · no banned phrases"]

    CRITIC["🔎 critic_node\nCRITIC tier (claude-haiku FIRST)\nReview against critique-rules.md\nReturn: APPROVED | NEEDS_REVISION + violations"]

    AFTER_CRITIC{{"afterCriticEdge\nPURE — checks verdict + revision_count"}}

    HITL["👤 hitl_node\nwrite hitl_approvals (DB)\nsend Telegram inline keyboard\ncall interrupt()"]

    HITL_GATE{{"hitl_gate_edge\nPURE — checks HITL outcome"}}

    FINALIZE["✅ finalize_node\nINSERT action_log (idempotency)\nSend email via Composio\nUpdate outbound_leads → sent"]

    SUPP_END(["⏹ END (suppressed)"])
    QUOTA_END(["⏹ END (quota exceeded)"])
    END_(["⏹ END"])

    START --> INTEL
    INTEL --> SUPP
    SUPP -->|"clean"| QUOTA
    SUPP -->|"suppressed"| SUPP_END
    QUOTA -->|"under limit"| SE
    QUOTA -->|"quota exceeded"| QUOTA_END
    SE --> BDR
    BDR --> CRITIC
    CRITIC --> AFTER_CRITIC
    AFTER_CRITIC -->|"APPROVED"| HITL
    AFTER_CRITIC -->|"NEEDS_REVISION\nrevision_count < max"| BDR
    AFTER_CRITIC -->|"NEEDS_REVISION\nmax revisions hit"| HITL
    HITL --> HITL_GATE
    HITL_GATE -->|"approved"| FINALIZE
    HITL_GATE -->|"rejected"| END_
    FINALIZE --> END_

    style SUPP fill:#533483,color:#fff
    style QUOTA fill:#533483,color:#fff
    style AFTER_CRITIC fill:#533483,color:#fff
    style HITL_GATE fill:#533483,color:#fff
    style SE fill:#1a472a,color:#fff
    style CRITIC fill:#2d4059,color:#fff
    style HITL fill:#0f3460,color:#fff
    style SUPP_END fill:#8b0000,color:#fff
    style QUOTA_END fill:#8b0000,color:#fff
```

---

## Generator-Critic Loop (Detail)

```mermaid
sequenceDiagram
    participant BDR as BDR Node (generator)
    participant CRIT as Critic Node
    participant EDGE as afterCriticEdge (pure fn)

    Note over BDR: Gemini family (google provider)
    Note over CRIT: Anthropic family (claude-haiku)
    Note over CRIT: Different training data = genuine adversarial review

    BDR->>CRIT: draft email + intel_report
    CRIT->>CRIT: Load critique-rules.md (dept: sales)
    CRIT-->>EDGE: { result: "NEEDS_REVISION", rule_violations: ["banned phrase: 'I wanted to reach out'"] }
    EDGE->>BDR: revision_count < max → retry with violations

    BDR->>CRIT: revised draft (revision 1)
    CRIT-->>EDGE: { result: "APPROVED", notes: "Clean, specific, pain-first" }
    EDGE->>EDGE: → HITL
```

---

## Idempotency Guard (Crash Safety)

```mermaid
flowchart TD
    BEFORE["Before external action\n(email send / LinkedIn post / GitHub push)"]
    KEY["Derive idempotency_key\n= action_type:interrupt_id"]
    INSERT["INSERT action_log\n(idempotency_key)\n.onConflictDoNothing()"]
    CHECK{{"Did insert succeed?"}}>
    SKIP["Log: 'already done'\nreturn (skip action)"]
    ACT["Execute external action\n(send email via Composio)"]

    BEFORE --> KEY
    KEY --> INSERT
    INSERT --> CHECK
    CHECK -->|"no rows inserted\n(key already existed)"| SKIP
    CHECK -->|"1 row inserted\n(first time)"| ACT

    style INSERT fill:#0f3460,color:#fff
    style CHECK fill:#533483,color:#fff
    style SKIP fill:#8b0000,color:#fff
    style ACT fill:#006400,color:#fff
```

---

## Cost Flow Per Prospect

```mermaid
flowchart LR
    subgraph "$0.000 — Cached"
        C1["research_node\ncache HIT\n< 5ms"]
    end

    subgraph "~$0.003 — Full Run"
        D1["disambiguate\n$0.0001\nNANO"]
        D2["research\n$0.001\nNANO + Tavily"]
        D3["icp_score\n$0.002\nMD tier"]
    end

    subgraph "~$0.02–0.04 — Full Sales"
        S1["lead_intel\n$0.005\ndeep_research"]
        S2["bdr\n$0.003–0.015\nMD or CEO tier"]
        S3["critic\n$0.002\ncritic tier"]
    end

    C1 -->|"cache hit path"| D3
    D1 --> D2
    D2 --> D3
    D3 -->|"icp ≥ 0.4"| S1
    S1 --> S2
    S2 --> S3
```
