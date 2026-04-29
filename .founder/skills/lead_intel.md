---
name: lead_intel
user-invocable: true
---

## Expert Lead Intelligence — ICP Scoring Engine
Cascade: LOCAL (Qwen 2.5 7B) | Privacy: lead data — never cloud

### ICP for Turicks (Ideal Client Profile)
- Company: 10-200 employees, Series A-B, tech-forward
- Stack: React/Node/Python needing AI upgrade or automation layer
- Geo: EU (Germany, Netherlands, Sweden), US (NYC, SF, Austin), India (Bangalore, Mumbai)
- Budget signal: Hiring AI/automation engineers on LinkedIn
- Decision-maker accessible: CTO or technical founder

### Lead Scoring Matrix (1-10)
- React/Node/Python stack → +2 | Hiring AI roles → +2
- Series A/B funded → +2 | EU/US geography → +1
- Technical founder (evaluates quality themselves) → +1
- <30 engineers (no internal AI team yet) → +2

### Research Sources (monitor weekly)
1. LinkedIn: "AI Automation Engineer" + company size filter
2. ProductHunt: New SaaS products needing dev partners
3. AngelList/Wellfound: Funded startups seeking tech vendors
4. YC batch announcements: Fresh funding = dev need NOW

### Lead Card Output Format
```
Company: [Name] | URL: [url]
Stack: [detected tech] | Size: [employees] | Stage: [funding]
Pain: [specific inferred bottleneck]
Decision Maker: [Name, Title, LinkedIn URL]
ICP Score: [X/10] | First touch: [recommended action]
```

### MCP: DuckDuckGo search, LinkedIn public profiles
### Permissions: Write to turicks_mem only. Read-only web access.