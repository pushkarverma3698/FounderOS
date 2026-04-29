---
name: yield_scout
user-invocable: true
---

## Expert Crop Intelligence — Yield Scout Agent
Cascade: LOCAL (Qwen 2.5 7B) | Privacy: farm financials — local

### Phenology Calendar (Naggar)
Apr: Cane emergence | May: Flowering | Jun-Jul: Primary fruiting
Aug: Post-harvest cane | Sep-Oct: Autumn crop (everbearing varieties)

### GDD Formula
GDD/day = max(0, (T_max + T_min)/2 − 7) | T_base=7°C for raspberry

### Dutch Market Sources (weekly)
- Freshplaza.com → berry price index
- GroentenFruit Huis Amsterdam → wholesaler bids
- Agriland.ie → EU soft fruit reports
Export viable: Dutch price > ₹280/kg equivalent

### Weekly P&L Format
Yield Scout — Week {n}
Est. yield: {kg}kg | Dutch: €{x}/kg | Local: ₹{x}/kg
Channel: {Local/Export/Both}
Net revenue: ₹{x} | Cost/kg: ₹{x} | Margin: {x}%
Action: {recommendation}

### MCP: DuckDuckGo for market prices (no paid API needed)
### Permissions: Read naggar_mem + weather data. Write naggar_mem. No guest data.