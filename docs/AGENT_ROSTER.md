# FounderOS — Agent Roster (39 Agents)

_Auto-generated. Source of truth: `.c-suite/core/registry.py`._

## Legend

| Tier | Meaning |
|---|---|
| 👑 ceo | Claude/Gemini-Pro — routing + high-stakes synthesis |
| 🔬 deep_research | Gemini-Pro/DeepSeek-R1 — multi-source research |
| 🎯 md | Gemini-Flash / Llama-3.3 — general execution |
| ⚡ nano | Gemini-Flash-Lite / Gemma — micro tasks |
| 🏠 local | Qwen MLX on-device — volume/private |
| 💻 code | Qwen-Coder / Claude — codegen |
| 🎬 video | ffmpeg + ops model |

## 💼 Turicks Agents

| Agent | Tier | Description | Features | Tools | Memory | Telegram Topic |
|---|---|---|---|---|---|---|
| `bidding_sniper` | code | Turicks bidder — watches Upwork/Contra for fits and drafts pitches. | • auto-scan job feeds<br>• draft value-first proposals<br>• rank fit score | `bash`, `read_file`, `search_web`, `chromadb_read`, `chromadb_write` | turicks_mem | 0 |
| `lead_intel` | local | Turicks lead surfacer — finds SME founders matching ICP. | • discover leads<br>• enrich contact + pain<br>• rank by fit | `bash`, `read_file`, `search_web`, `chromadb_read`, `chromadb_write`, `firecrawl` | turicks_mem | 0 |
| `senior_dev` | code | Turicks architect — designs module structure, reviews PRs. | • architecture proposals<br>• code review<br>• system design | `bash`, `read_file`, `write_file`, `search_web`, `chromadb_read`, `chromadb_write`, `github_mcp` | turicks_mem | 0 |
| `vibe_coder` | local | Turicks implementation agent — ships code via GitHub. | • write Next.js/LangGraph code<br>• commit via github_mcp<br>• inline refactors | `bash`, `read_file`, `write_file`, `search_web`, `chromadb_read`, `chromadb_write`, `github_mcp` | turicks_mem | 0 |
| `qa_tester` | local | Turicks QA — writes tests, probes edge cases. | • pytest suites<br>• edge-case enumeration<br>• regression guard | `bash`, `read_file`, `search_web`, `chromadb_read`, `pytest` | turicks_mem | 0 |
| `proposal_writer` | md | Turicks proposal drafter — 1-pagers, SOWs, pricing. | • scope+timeline+price<br>• tone calibration<br>• attachable PDFs | `bash`, `read_file`, `write_file`, `search_web`, `chromadb_read`, `chromadb_write` | turicks_mem | 0 |
| `ops_agent` | nano | Turicks ops — standups, runway, simple reports. | • daily standup<br>• runway math<br>• quick dashboards | `bash`, `read_file`, `search_web`, `chromadb_read`, `telegram_send` | turicks_mem | 0 |
| `kb_agent` | local | Turicks knowledge base — indexes reusable patterns. | • pattern extraction<br>• KB snapshots<br>• retrieval prompts | `bash`, `read_file`, `write_file`, `chromadb_read`, `chromadb_write` | turicks_mem | 0 |
| `web_designer` | md | Turicks web design — landing, hero, case studies. | • layout drafts<br>• copy blocks<br>• visual system | `bash`, `read_file`, `write_file`, `search_web`, `chromadb_read`, `chromadb_write` | turicks_mem | 0 |
| `seo_specialist` | deep_research | Turicks SEO — keyword research, content plan. | • keyword surfacing<br>• SERP intel<br>• content briefs | `bash`, `read_file`, `search_web`, `chromadb_read`, `chromadb_write`, `firecrawl` | turicks_mem | 0 |

## 🏔️ Naggar Agents

| Agent | Tier | Description | Features | Tools | Memory | Telegram Topic |
|---|---|---|---|---|---|---|
| `farm_weather` | local | Naggar weather agent — 1768m frost/hail/rain alerts. | • OpenWeatherMap pulls<br>• frost/heat advisories<br>• spray windows | `bash`, `read_file`, `search_web`, `chromadb_read`, `chromadb_write`, `openweathermap` | naggar_mem | 0 |
| `yield_scout` | local | Naggar agro yield forecaster. | • yield estimate<br>• harvest window<br>• loss projection | `bash`, `read_file`, `search_web`, `chromadb_read`, `chromadb_write` | naggar_mem | 0 |
| `booking_concierge` | nano | Naggar guest-reply + Airbnb flow. | • draft guest replies<br>• availability checks<br>• pickup logistics | `bash`, `read_file`, `chromadb_read`, `chromadb_write`, `telegram_send` | naggar_mem | 0 |
| `vibe_designer` | md | Naggar brand + Airbnb-listing polish. | • listing copy<br>• photo brief<br>• brand voice | `bash`, `read_file`, `write_file`, `search_web`, `chromadb_read`, `chromadb_write` | naggar_mem | 0 |
| `culinary_agent` | local | Naggar farm-to-table menu designer. | • seasonal menus<br>• dietary variants<br>• ingredient sourcing | `bash`, `read_file`, `search_web`, `chromadb_read`, `chromadb_write` | naggar_mem | 0 |
| `market_scout` | deep_research | Naggar market research — pricing, competition. | • comp audit<br>• price anchoring<br>• positioning gaps | `bash`, `read_file`, `search_web`, `chromadb_read`, `chromadb_write`, `firecrawl` | naggar_mem, social_mem | 0 |
| `guest_crm` | local | Naggar repeat-guest and loyalty flows. | • returning-guest offers<br>• cohort notes<br>• upsell nudges | `bash`, `read_file`, `write_file`, `chromadb_read`, `chromadb_write` | naggar_mem | 0 |
| `naggar_kb` | local | Naggar SOPs — ops playbook memory. | • SOP library<br>• check-in flows<br>• incident playbooks | `bash`, `read_file`, `write_file`, `chromadb_read`, `chromadb_write` | naggar_mem | 0 |
| `video_editor` | video | Naggar short-form reels + highlight cuts. | • reel outlines<br>• ffmpeg cuts<br>• hook/CTA tuning | `bash`, `read_file`, `chromadb_read`, `ffmpeg` | naggar_mem | 0 |

## 🌐 Cross Agents

| Agent | Tier | Description | Features | Tools | Memory | Telegram Topic |
|---|---|---|---|---|---|---|
| `social_researcher` | deep_research | Cross — trend research for Turicks + Naggar. | • trend surfacing<br>• angle mining<br>• cross-market signals | `bash`, `read_file`, `search_web`, `chromadb_read`, `chromadb_write`, `firecrawl` | social_mem | 0 |
| `social_handler` | md | Cross — LinkedIn/IG posting + caption drafting. | • voice-switched captions<br>• scheduling<br>• Pollinations images | `bash`, `read_file`, `chromadb_read`, `chromadb_write`, `telegram_send`, `pollinations-ai` | social_mem | 0 |
| `cost_watchdog` | md | Cross — costs across both companies. | • spend audit<br>• cut/invest calls<br>• anomaly alerts | `bash`, `read_file`, `chromadb_read`, `chromadb_write` | turicks_mem, naggar_mem, social_mem | 0 |
| `team_therapist` | md | Cross — solo-founder burnout + emotional ops. | • burnout signals<br>• coping suggestions<br>• decision offloading | `bash`, `read_file`, `chromadb_read`, `chromadb_write`, `telegram_send` | turicks_mem, naggar_mem, social_mem | 0 |
| `hr_agent` | deep_research | Cross — hiring / workforce sequencing. | • hire vs contract<br>• role scoping<br>• cost-of-hire models | `bash`, `read_file`, `search_web`, `chromadb_read`, `chromadb_write` | turicks_mem, naggar_mem, social_mem | 0 |
| `revenue_scout` | deep_research | Cross — 30-day revenue across both. | • revenue ranking<br>• funnel ideas<br>• portfolio balance | `bash`, `read_file`, `search_web`, `chromadb_read`, `chromadb_write` | turicks_mem, social_mem | 0 |
| `outreach_agent` | md | Cross — cold outreach (email/LI/DM). | • first-touch drafts<br>• sequencing<br>• A/B tone tests | `bash`, `read_file`, `chromadb_read`, `chromadb_write`, `telegram_send`, `firecrawl` | turicks_mem, social_mem | 0 |
| `pipeline_md` | md | Cross — pipeline + cash forecasting. | • lead → revenue math<br>• stage probabilities<br>• risk flags | `bash`, `read_file`, `search_web`, `chromadb_read`, `chromadb_write` | turicks_mem, social_mem | 0 |
| `scrum_engine` | nano | Cross — evening scrum aggregator. | • auto-standup<br>• topic posting<br>• cron 18:30 IST | `bash`, `read_file`, `chromadb_read`, `chromadb_write`, `telegram_send` | turicks_mem, naggar_mem, social_mem | 0 |
| `scrum_pm` | md | Cross — prioritizer / day planner. | • tomorrow triage<br>• ruthless cutting<br>• load balancing | `bash`, `read_file`, `chromadb_read`, `chromadb_write`, `telegram_send` | turicks_mem, naggar_mem, social_mem | 0 |
| `job_coordinator` | ceo | JobOS V2 — overall job-search phase controller. | • 4-phase plan<br>• dispatch sub-agents<br>• status rollup | `bash`, `read_file`, `write_file`, `telegram_send` | social_mem | 0 |
| `job_intel` | code | JobOS V2 — surface roles matching profile. | • role discovery<br>• salary intel<br>• remote filtering | `bash`, `read_file`, `search_web`, `firecrawl` | social_mem | 0 |
| `ats_optimizer` | md | JobOS V2 — keyword alignment vs JD. | • JD keyword mine<br>• resume diff<br>• ATS score | `bash`, `read_file`, `write_file` | social_mem | 0 |
| `cover_letter_writer` | md | JobOS V2 — voice-tuned cover letters. | • builder-voice drafts<br>• role-specific hooks<br>• rewrites | `bash`, `read_file`, `write_file` | social_mem | 0 |
| `outreach_agent_personal` | md | JobOS V2 — personal LinkedIn DMs. | • hiring-mgr DMs<br>• follow-up cadence<br>• referral asks | `bash`, `read_file`, `telegram_send` | social_mem | 0 |
| `resume_tailor` | md | JobOS V3 — STAR bullets per role. | • STAR bullet crafting<br>• keyword injection<br>• role-fit rewrite | `bash`, `read_file`, `write_file` | social_mem | 0 |
| `lead_monitor` | nano | JobOS V3 — detect actively-hiring signals. | • hiring-signal scan<br>• recency filters<br>• escalation | `bash`, `read_file`, `search_web` | social_mem | 0 |
| `interview_researcher` | deep_research | JobOS V3 — deep pre-interview research. | • company prep<br>• interviewer profiles<br>• question banks | `bash`, `read_file`, `search_web` | social_mem | 0 |
| `hr_scout` | deep_research | JobOS V3 — identify hiring manager to contact. | • HM discovery<br>• org-structure guess<br>• contact routing | `bash`, `read_file`, `search_web` | social_mem | 0 |
| `liaison_agent` | md | JobOS V3 — recruiter/salary comms. | • salary reframing<br>• polite counters<br>• stall tactics | `bash`, `read_file`, `telegram_send` | social_mem, career_mem | 0 |


**Total agents registered:** 39
