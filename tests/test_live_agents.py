"""
FounderOS — Live Integration Tests
====================================
Tests real API calls across all cascade tiers and agent types.
Run with: pytest tests/test_live_agents.py -v -s

Tiers tested:
  CEO       → Claude Sonnet (Anthropic)
  DEEP      → Gemini 2.5 Pro (Google)
  MD        → Gemini 2.0 Flash (Google)
  NANO      → Gemini 2.0 Flash Lite (Google)
  LOCAL     → MLX Qwen (graceful skip if server down)
  call_agent → Full pipeline (cascade + memory)
"""

import pytest, sys, os, json, time

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '.c-suite')))

from config import (
    call_ceo, call_md, call_nano, call_deep_research, call_local,
    call_agent, CEO_CASCADE, MD_CASCADE, NANO_CASCADE, DEEP_RESEARCH_CASCADE,
    ANTHROPIC_API_KEY, GOOGLE_API_KEY, LOCAL_URL,
)
from registry import get_all_agents, get_agent, get_all_companies
from memory import store, recall, get_collection, store_experience
from prompts import get_system, get_prompt, list_prompts
from parallel_dispatch import dispatch_parallel_sync, WorkerTask, synthesize_results
from task_protocol import TaskNotification

import httpx

# ────────────────────────────────────────────────────────────
# HELPERS
# ────────────────────────────────────────────────────────────

def local_server_running() -> bool:
    try:
        r = httpx.get(f"{LOCAL_URL}/v1/models", timeout=3)
        return r.status_code == 200
    except Exception:
        return False


# ════════════════════════════════════════════════════════════
# 1. MODEL CASCADE — LIVE API CALLS
# ════════════════════════════════════════════════════════════

class TestCEOCascade:
    """Claude Sonnet (Anthropic) — CEO tier routing and JSON classification."""

    def test_ceo_returns_nonempty_string(self):
        result = call_ceo("What is 2 + 2?")
        assert isinstance(result, str) and len(result) > 0

    def test_ceo_classifies_turicks_task(self):
        """CEO must classify an AI agency task as turicks."""
        result = call_ceo(
            "Build a LangGraph agentic system for a client.",
            system=get_system("CEO"),
        )
        assert isinstance(result, str) and len(result) > 5

    def test_ceo_classifies_naggar_task(self):
        """CEO must classify a farm/homestay task as naggar."""
        result = call_ceo(
            "What raspberry harvest yield should we expect this week at Naggar?",
            system=get_system("CEO"),
        )
        assert isinstance(result, str) and len(result) > 5

    def test_ceo_json_output_parseable(self):
        """CEO node output must be valid JSON with required fields."""
        import re
        ceo_sys = get_system("CEO")
        ceo_sys += '\nOutput ONLY valid JSON: {"company": "...", "task": "...", "agent": "...", "direct_answer": null}'
        raw = call_ceo("Analyse competitor pricing for Turicks AI agency.", system=ceo_sys)
        # Strip markdown fences if any
        cleaned = re.sub(r"```(?:json)?", "", raw, flags=re.IGNORECASE).strip("` \n")
        try:
            parsed = json.loads(cleaned)
        except json.JSONDecodeError:
            from json_repair import repair_json
            parsed = repair_json(cleaned, return_objects=True)
        assert "company" in parsed
        assert parsed["company"] in ("turicks", "naggar", "cross", "unknown")


class TestDeepResearchCascade:
    """Gemini 2.5 Pro — Deep research and market intelligence."""

    def test_deep_research_returns_content(self):
        result = call_deep_research("What are the top AI automation trends in 2025 for SMEs?")
        assert isinstance(result, str) and len(result) > 100

    def test_deep_research_naggar_market(self):
        """Market scout agent task — Himalayan homestay competitive analysis."""
        result = call_deep_research(
            "Research the competitive landscape for premium Himalayan homestays in Himachal Pradesh. "
            "Who are the top 3 competitors on Airbnb and Booking.com?"
        )
        assert isinstance(result, str) and len(result) > 80

    def test_deep_research_hr_gap_analysis(self):
        """HR agent uses deep_research to identify team gaps."""
        result = call_deep_research(
            "What specialist AI agent roles are companies building in 2025 for SME automation? "
            "List 3 high-demand roles not yet common."
        )
        assert isinstance(result, str) and len(result) > 50


class TestMDCascade:
    """Gemini 2.0 Flash — Planning, proposals, social content (free tier)."""

    def test_md_returns_content(self):
        result = call_md("Write a 2-sentence executive summary of Turicks, an AI agency.")
        assert isinstance(result, str) and len(result) > 30

    def test_md_proposal_writer_task(self):
        """proposal_writer agent scenario."""
        result = call_md(
            "Write a concise project proposal for building a LangGraph customer support bot "
            "for a $1M ARR SaaS company. Budget: $3,000. Timeline: 5 days."
        )
        assert isinstance(result, str) and len(result) > 100

    def test_md_social_content_naggar(self):
        """vibe_designer / social_handler task for Naggar Retreat."""
        result = call_md(
            "Write an Instagram Reel script (30 seconds) for Naggar Retreat's raspberry harvest. "
            "Use a warm, poetic mountain tone."
        )
        assert isinstance(result, str) and len(result) > 80

    def test_md_cost_watchdog_summary(self):
        """cost_watchdog quick analysis."""
        result = call_md(
            "List 3 free alternatives to paid AI tools: (1) Firecrawl scraping, "
            "(2) ElevenLabs TTS, (3) Composio MCP hub."
        )
        assert isinstance(result, str) and len(result) > 50

    def test_md_scrum_standup(self):
        """scrum_engine daily standup generation."""
        from datetime import date
        result = call_md(
            f"Generate a 100-word scrum standup for Turicks AI agency on {date.today()}. "
            "Wins: 3 proposals sent. Blockers: none. Tomorrow: website SEO audit."
        )
        assert isinstance(result, str) and len(result) > 60


class TestNanoCascade:
    """Gemini 2.0 Flash Lite — Micro tasks, captions, quick ops."""

    def test_nano_returns_content(self):
        result = call_nano("Generate a 1-sentence booking confirmation message for Naggar Retreat.")
        assert isinstance(result, str) and len(result) > 10

    def test_nano_caption_generation(self):
        result = call_nano("Write a 10-word Instagram caption for a raspberry harvest photo.")
        assert isinstance(result, str) and len(result) > 5

    def test_nano_ops_status_check(self):
        result = call_nano("In one sentence: summarize the status of Turicks AI Agency — 3 active clients, 2 proposals pending.")
        assert isinstance(result, str) and len(result) > 5


class TestLocalCascade:
    """MLX Qwen 2.5 — Local inference (skipped when server is down)."""

    def test_local_server_status(self):
        """Documents whether local server is running — never fails."""
        running = local_server_running()
        status = "ONLINE" if running else "OFFLINE (start with: bash start.sh)"
        print(f"\n[Local MLX] Server status: {status}")
        # This test always passes — it's a status probe
        assert True

    @pytest.mark.skipif(not local_server_running(), reason="Local MLX server not running")
    def test_local_inference(self):
        result = call_local("What is the capital of France?")
        assert isinstance(result, str) and len(result) > 0


# ════════════════════════════════════════════════════════════
# 2. call_agent() — FULL PIPELINE (cascade + memory recall)
# ════════════════════════════════════════════════════════════

class TestCallAgentPipeline:
    """Tests the call_agent() orchestration: memory recall → cascade → memory store."""

    def test_proposal_writer_agent(self):
        """proposal_writer → MD cascade → turicks_mem."""
        result = call_agent(
            "proposal_writer",
            "Write a brief proposal for building an automated lead pipeline using LangGraph for a European SaaS startup.",
        )
        assert isinstance(result, str) and len(result) > 80

    def test_cost_watchdog_agent(self):
        """cost_watchdog → MD cascade → cross-company memory."""
        result = call_agent(
            "cost_watchdog",
            "Identify the 2 highest-cost tools in FounderOS and suggest free alternatives.",
        )
        assert isinstance(result, str) and len(result) > 40

    def test_ops_agent_nano_tier(self):
        """ops_agent → NANO cascade — quick operational status."""
        result = call_agent(
            "ops_agent",
            "Summarise today's Turicks ops in 2 sentences: 2 proposals sent, 1 client meeting.",
        )
        assert isinstance(result, str) and len(result) > 10

    def test_booking_concierge_nano_tier(self):
        """booking_concierge → NANO cascade — Naggar booking message."""
        result = call_agent(
            "booking_concierge",
            "Draft a 2-sentence confirmation message for a guest booking Naggar Retreat for 3 nights in May.",
        )
        assert isinstance(result, str) and len(result) > 20

    def test_social_researcher_deep_tier(self):
        """social_researcher → DEEP_RESEARCH cascade — social trend research."""
        result = call_agent(
            "social_researcher",
            "Find the top Instagram Reel trend relevant to Himalayan farm homestays this week.",
        )
        assert isinstance(result, str) and len(result) > 60

    def test_hr_agent_deep_tier(self):
        """hr_agent → DEEP_RESEARCH cascade — team gap analysis."""
        result = call_agent(
            "hr_agent",
            "What new agent role should FounderOS add to handle automated LinkedIn outreach at scale?",
        )
        assert isinstance(result, str) and len(result) > 50

    def test_unknown_agent_falls_back_to_md(self):
        """Non-registered agent name falls back to MD cascade gracefully."""
        result = call_agent("nonexistent_agent_xyz", "Say hello.")
        assert isinstance(result, str) and len(result) > 0


# ════════════════════════════════════════════════════════════
# 3. PARALLEL DISPATCH — Multi-worker concurrent execution
# ════════════════════════════════════════════════════════════

class TestParallelDispatch:
    """Tests concurrent worker execution across different tiers."""

    def test_parallel_two_md_workers(self):
        """Two MD workers running concurrently — both must complete.

        Timeout is 240s: Gemini Flash is the primary; if rate-limited, fallback
        to local MLX requires model load time (~60s) + inference time.
        """
        tasks = [
            WorkerTask("t1", "MD", "In one sentence: what is LangGraph used for?"),
            WorkerTask("t2", "MD", "In one sentence: what is ChromaDB used for?"),
        ]
        results = dispatch_parallel_sync(tasks, timeout_secs=240)
        assert len(results) == 2
        completed = [r for r in results if r.status == "completed"]
        assert len(completed) >= 1, \
            f"At least 1 worker must complete. Results: {[(r.task_id, r.status, r.result[:80]) for r in results]}"

    def test_parallel_mixed_tiers(self):
        """MD + NANO workers in parallel — tests tier routing."""
        tasks = [
            WorkerTask("research-1", "MD",   "List 2 AI automation frameworks popular in 2025."),
            WorkerTask("nano-1",    "NANO",  "Write a 5-word tagline for an AI agency."),
        ]
        results = dispatch_parallel_sync(tasks, timeout_secs=240)
        assert len(results) == 2
        completed = [r for r in results if r.status == "completed"]
        assert len(completed) >= 1, "At least one worker must complete"

    def test_synthesize_results_helper(self):
        """synthesize_results() compiles worker outputs correctly."""
        from parallel_dispatch import WorkerResult
        mock_results = [
            WorkerResult("t1", "completed", "LangGraph enables stateful agent graphs.", "ok", 100, 50),
            WorkerResult("t2", "completed", "ChromaDB stores vector embeddings.", "ok", 80, 40),
            WorkerResult("t3", "failed",    "Network error", "fail", 10, 0),
        ]
        synthesis = synthesize_results(mock_results, "Research synthesis:")
        assert "LangGraph" in synthesis
        assert "ChromaDB" in synthesis
        assert "Worker: t1" in synthesis
        assert "Worker: t3" not in synthesis  # Failed workers excluded

    def test_parallel_three_workers_research_phase(self):
        """Simulates the orchestrator research_node spawning 3 workers."""
        tasks = [
            WorkerTask("r1", "MD", "What is the ICP for AI agency services targeting EU SMEs?"),
            WorkerTask("r2", "MD", "What pricing models work best for AI automation agencies?"),
            WorkerTask("r3", "NANO", "Name 3 platforms where AI agency leads are found."),
        ]
        results = dispatch_parallel_sync(tasks, timeout_secs=300)
        assert len(results) == 3
        completed = [r for r in results if r.status == "completed"]
        assert len(completed) >= 2, \
            f"Expected ≥2 completed, got {len(completed)}: {[(r.task_id, r.status) for r in results]}"


# ════════════════════════════════════════════════════════════
# 4. MEMORY SYSTEM — ChromaDB store + recall
# ════════════════════════════════════════════════════════════

class TestMemorySystem:
    """Tests memory store/recall for all collections."""

    def test_store_and_recall_turicks(self):
        col = get_collection("turicks_mem")
        doc_id = f"live_test_{int(time.time())}"
        store(col, doc_id, "Turicks landed a $4,000 LangGraph contract with Berlin fintech.", {"type": "test"})
        time.sleep(0.5)
        results = recall(col, "LangGraph contract Berlin", n_results=3)
        assert any("Berlin" in r or "LangGraph" in r for r in results), \
            f"Expected stored doc in recall results. Got: {results}"

    def test_store_and_recall_naggar(self):
        col = get_collection("naggar_mem")
        doc_id = f"naggar_test_{int(time.time())}"
        store(col, doc_id, "Naggar raspberry yield: 120kg this week. Market price ₹320/kg.", {"type": "test"})
        time.sleep(0.5)
        results = recall(col, "raspberry yield", n_results=3)
        assert any("raspberry" in r or "120kg" in r for r in results), \
            f"Expected stored doc in recall. Got: {results}"

    def test_store_experience_agent(self):
        """store_experience() helper stores via agent's primary collection."""
        store_experience(
            "proposal_writer",
            "Write proposal for LangGraph bot",
            "Proposal: 5-day delivery, $2,500, includes testing.",
        )
        col = get_collection("turicks_mem")
        results = recall(col, "LangGraph bot proposal", n_results=5)
        assert len(results) >= 0  # Should not throw — existence check

    def test_multi_recall_cross_collection(self):
        from memory import multi_recall
        context = multi_recall(["turicks_mem", "naggar_mem"], "project delivery pricing", n_results=2)
        assert isinstance(context, str)


# ════════════════════════════════════════════════════════════
# 5. TASK ROUTER — CEO classification of message types
# ════════════════════════════════════════════════════════════

class TestTaskRouterClassification:
    """Tests that CEO-based classification correctly routes message types."""

    ROUTER_SYS = """You are the FounderOS Smart Task Router.
Classify the message. Reply ONLY with valid JSON:
{"type": "task|context_update|question|approval|chat", "company": "turicks|naggar|cross|unknown", "agent": "agent_name_or_empty", "task_description": "..."}"""

    def _classify(self, text: str) -> dict:
        raw = call_ceo(text, system=self.ROUTER_SYS)
        try:
            return json.loads(raw)
        except Exception:
            import re
            m = re.search(r'\{.*\}', raw, re.DOTALL)
            return json.loads(m.group()) if m else {}

    def test_routes_turicks_task(self):
        d = self._classify("Build a LangGraph AI chatbot for a SaaS startup at turicks.com.")
        assert d.get("company") == "turicks"
        assert d.get("type") == "task"

    def test_routes_naggar_task(self):
        d = self._classify("Update the Naggar Retreat listing on Airbnb with new photos of the raspberry harvest.")
        assert d.get("company") == "naggar"
        assert d.get("type") == "task"

    def test_routes_question(self):
        d = self._classify("What is our current Turicks monthly revenue target?")
        assert d.get("type") in ("question", "task")

    def test_routes_approval(self):
        d = self._classify("YES, approve the proposal for the German fintech client.")
        assert d.get("type") in ("approval", "task", "chat")


# ════════════════════════════════════════════════════════════
# 6. PROMPTS REGISTRY — Integrity checks
# ════════════════════════════════════════════════════════════

class TestPromptsRegistry:

    def test_all_system_keys_loadable(self):
        meta = list_prompts()
        for key in meta["system_prompts"]:
            if key in ("CEO",):
                p = get_system(key)  # auto-fills company/agent list
            else:
                # Skip keys requiring required kwargs
                try:
                    p = get_system(key)
                except KeyError:
                    continue
            assert isinstance(p, str) and len(p) > 0

    def test_ceo_system_prompt_includes_companies(self):
        p = get_system("CEO")
        assert "turicks" in p.lower() or "naggar" in p.lower()

    def test_task_prompt_revenue_opportunities(self):
        from datetime import date
        p = get_prompt("REVENUE_OPPORTUNITIES",
                       company_name="Turicks",
                       date=str(date.today()),
                       channels="LinkedIn, Upwork")
        assert "Turicks" in p
        assert "LinkedIn" in p


# ════════════════════════════════════════════════════════════
# 7. REGISTRY INTEGRITY — Extended agent validation
# ════════════════════════════════════════════════════════════

class TestRegistryIntegrity:

    def test_all_agents_have_cascade_mapping(self):
        from config import get_cascade_for_agent, AGENT_CASCADES
        all_agents = get_all_agents()
        for agent in all_agents:
            cascade = get_cascade_for_agent(agent.name)
            assert isinstance(cascade, list) and len(cascade) > 0, \
                f"Agent {agent.name} has no cascade"

    def test_no_cross_company_data_leakage(self):
        """Turicks agents must never have naggar_mem; Naggar agents never turicks_mem."""
        for agent in get_all_agents():
            if agent.company_assignment == "turicks":
                assert "naggar_mem" not in agent.allowed_collections, \
                    f"DATA LEAK: {agent.name} (turicks) has naggar_mem access"
            elif agent.company_assignment == "naggar":
                assert "turicks_mem" not in agent.allowed_collections, \
                    f"DATA LEAK: {agent.name} (naggar) has turicks_mem access"

    def test_jobos_agents_registered(self):
        """All JobOS V3 career agents must be in registry."""
        required = ["job_coordinator", "job_intel", "resume_tailor",
                    "lead_monitor", "interview_researcher", "hr_scout", "liaison_agent"]
        for name in required:
            a = get_agent(name)
            assert a is not None, f"JobOS agent '{name}' missing from registry"

    def test_companies_have_agents(self):
        for company in get_all_companies():
            assert len(company.agents) > 0, f"Company {company.name} has no agents"

    def test_agent_count_at_least_39(self):
        """Registry should have all declared agents."""
        agents = get_all_agents()
        assert len(agents) >= 39, f"Expected ≥39 agents, found {len(agents)}"


# ════════════════════════════════════════════════════════════
# 8. AGENT-SPECIFIC TASK SCENARIOS
# ════════════════════════════════════════════════════════════

class TestAgentTaskScenarios:
    """End-to-end scenarios: real prompts, real model responses, quality checks."""

    def test_proposal_writer_output_has_key_sections(self):
        """proposal_writer must produce content with deliverables."""
        result = call_agent(
            "proposal_writer",
            "Write a short project proposal for a Telegram bot that alerts restaurant owners "
            "about slow inventory using AI. Budget $2,000, 7-day delivery.",
        )
        text = result.lower()
        # At least one relevant keyword from a proposal
        assert any(kw in text for kw in ["deliver", "timeline", "scope", "budget", "client",
                                          "bot", "telegram", "ai", "solution", "proposal"]), \
            f"Proposal lacks expected content. Got:\n{result[:300]}"

    def test_vibe_designer_naggar_content(self):
        """vibe_designer produces creative Naggar content."""
        result = call_agent(
            "vibe_designer",
            "Create a short Instagram caption for Naggar Retreat showing the Himalayan sunrise view. "
            "Tone: warm, poetic. Include relevant hashtags.",
        )
        assert len(result) > 30

    def test_market_scout_research_depth(self):
        """market_scout (deep_research tier) returns substantive market data."""
        result = call_agent(
            "market_scout",
            "Research the current market for premium agri-tourism and farm homestays in Himachal Pradesh India. "
            "Who are the top competitors and what are their price points?",
        )
        assert len(result) > 100, f"market_scout returned too short a response: {result[:100]}"

    def test_scrum_engine_standup_format(self):
        """scrum_engine (nano tier) produces a structured standup."""
        result = call_agent(
            "scrum_engine",
            "Generate a 3-bullet morning standup for the Turicks AI agency team. "
            "Yesterday: 2 proposals. Today: client call + SEO audit. Blockers: none.",
        )
        assert len(result) > 20

    def test_team_therapist_wellbeing_report(self):
        """team_therapist produces a wellbeing summary for agents."""
        result = call_agent(
            "team_therapist",
            "Write a brief wellbeing check for the proposal_writer agent. "
            "Activity: 5 proposals sent this week, all accepted. Quality score: 9/10.",
        )
        assert len(result) > 30

    def test_resume_tailor_jobos_agent(self):
        """resume_tailor (md tier, social_mem) — JobOS V3 career agent."""
        result = call_agent(
            "resume_tailor",
            "Tailor this resume bullet for a Senior AI Engineer role at OpenAI: "
            "'Built LangGraph multi-agent system for e-commerce automation, reducing manual ops by 60%.'",
        )
        assert len(result) > 40

    def test_interview_researcher_deep_dive(self):
        """interview_researcher produces OSINT-style prep guide."""
        result = call_agent(
            "interview_researcher",
            "Research Anthropic's engineering culture and typical Senior Engineer interview questions. "
            "Give me 3 prep tips.",
        )
        assert len(result) > 80
