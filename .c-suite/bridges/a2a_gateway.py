"""
FounderOS — A2A (Agent-to-Agent) Protocol Gateway
===================================================
V7 NEW MODULE — Phase 3: External Interoperability

Implements Google's open A2A standard, allowing FounderOS agents to:
  1. Broadcast their capabilities via JSON "Agent Cards"
  2. Discover external third-party agents by capability
  3. Delegate tasks to remote agents and receive results

A2A vs MCP distinction:
  - MCP  = VERTICAL: connects agents to tools (databases, APIs, file systems)
  - A2A  = HORIZONTAL: connects agents to OTHER agents across platforms/vendors

Architecture:
  ┌─────────────────────────────────────────────────────────┐
  │  FounderOS A2A Gateway                                  │
  │                                                         │
  │  AgentCard: broadcast who we are + what we can do      │
  │  AgentRegistry: discover external A2A agents            │
  │  delegate_task(): send task → external agent → wait    │
  └─────────────────────────────────────────────────────────┘

Reference: https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/
"""

import json
import logging
import asyncio
import time
from dataclasses import dataclass, asdict, field
from typing import Any
import httpx

log = logging.getLogger("A2AGateway")


# ─── Agent Card Definition ─────────────────────────────────────────────────────
@dataclass
class A2ACapability:
    """Describes a single task capability this agent can perform."""
    name:        str
    description: str
    input_schema:  dict = field(default_factory=dict)
    output_schema: dict = field(default_factory=dict)


@dataclass
class A2AAgentCard:
    """
    JSON manifest broadcast by an A2A-compatible agent.
    External agents use this to discover and validate what this agent can do.
    """
    agent_id:     str
    name:         str
    version:      str
    description:  str
    base_url:     str   # Where to send task requests
    capabilities: list[A2ACapability] = field(default_factory=list)
    metadata:     dict  = field(default_factory=dict)

    def to_json(self) -> str:
        d = asdict(self)
        return json.dumps(d, indent=2, ensure_ascii=False)


# ─── FounderOS Own Agent Card ─────────────────────────────────────────────────
FOUNDEROS_AGENT_CARD = A2AAgentCard(
    agent_id    = "founderos-v7",
    name        = "FounderOS Autonomous Empire",
    version     = "7.0.0",
    description = (
        "FounderOS is a 27-agent autonomous orchestration system managing two companies: "
        "Turicks (AI agency) and Naggar (eco-retreat). It offers capabilities spanning "
        "proposal generation, social media content, farm operations, revenue pipeline, "
        "web scraping, and project management."
    ),
    base_url    = "http://localhost:8080/a2a",  # Local A2A endpoint
    capabilities=[
        A2ACapability(
            name        = "generate_proposal",
            description = "Generate a tailored freelance project proposal for a given job description.",
            input_schema  = {"job_description": "string", "budget": "string"},
            output_schema = {"proposal": "string", "word_count": "integer"},
        ),
        A2ACapability(
            name        = "social_content_batch",
            description = "Generate a batch of social media posts for Instagram/LinkedIn.",
            input_schema  = {"topic": "string", "platform": "string", "count": "integer"},
            output_schema = {"posts": "array"},
        ),
        A2ACapability(
            name        = "market_research",
            description = "Deep research on a market niche, competitor landscape, or ICP.",
            input_schema  = {"query": "string", "depth": "string"},
            output_schema = {"report": "string", "sources": "array"},
        ),
        A2ACapability(
            name        = "scrum_planning",
            description = "Generate a daily scrum plan assigning tasks to 27 internal agents.",
            input_schema  = {"context": "string"},
            output_schema = {"plan": "array"},
        ),
    ],
    metadata={
        "owner":    "Pushkar Verma",
        "timezone": "IST",
        "stack":    ["LangGraph", "ChromaDB", "Gemini", "Claude", "Qwen2.5-MLX"],
    }
)


# ─── External Agent Registry ──────────────────────────────────────────────────
@dataclass
class ExternalAgent:
    """Represents a discovered external A2A-compatible agent."""
    agent_id:    str
    name:        str
    base_url:    str
    capabilities: list[str]  # List of capability names


class A2ARegistry:
    """
    Registry of known external A2A agents.
    In production, this would query a discovery endpoint or use static config.

    Uses __init_subclass__-style lazy initialisation so the dict is created
    exactly once per process but is not accidentally shared via annotation.
    """
    _agents: dict[str, ExternalAgent] = None  # type: ignore[assignment]

    @classmethod
    def _ensure(cls) -> dict:
        if cls._agents is None:
            cls._agents = {}
        return cls._agents

    @classmethod
    def register(cls, agent: ExternalAgent):
        """Register an external agent manually."""
        cls._ensure()[agent.agent_id] = agent
        log.info(f"[A2A] Registered external agent: {agent.name} @ {agent.base_url}")

    @classmethod
    def find_by_capability(cls, capability: str) -> list[ExternalAgent]:
        """Find all registered agents that offer a specific capability."""
        return [
            a for a in cls._ensure().values()
            if capability in a.capabilities
        ]

    @classmethod
    async def discover_from_url(cls, agent_card_url: str) -> ExternalAgent | None:
        """
        Fetch and parse a remote agent's card, then register them.
        Agents expose their cards at a well-known endpoint (e.g., /.well-known/agent-card).
        """
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(agent_card_url)
                resp.raise_for_status()
                card = resp.json()
                agent = ExternalAgent(
                    agent_id     = card.get("agent_id", agent_card_url),
                    name         = card.get("name", "Unknown Agent"),
                    base_url     = card.get("base_url", agent_card_url),
                    capabilities = [c["name"] for c in card.get("capabilities", [])],
                )
                cls.register(agent)
                return agent
        except Exception as e:
            log.warning(f"[A2A] Failed to discover agent at {agent_card_url}: {e}")
            return None


# ─── Task Delegation Engine ───────────────────────────────────────────────────
async def delegate_task(
    capability:    str,
    task_payload:  dict[str, Any],
    timeout_secs:  float = 30.0,
) -> dict[str, Any] | None:
    """
    Find a registered external agent that offers a capability and delegate the task.

    Steps:
      1. Find capable agents in the registry.
      2. Send a JSON-RPC style task request.
      3. Poll for result (async, non-blocking).
      4. Return the result dict, or None on failure.

    Args:
        capability:   e.g. "generate_proposal"
        task_payload: Dict of input data matching the capability's input_schema.
        timeout_secs: How long to wait for a response.

    Returns:
        The agent's response dict, or None if no agent found / timeout.
    """
    agents = A2ARegistry.find_by_capability(capability)
    if not agents:
        log.warning(f"[A2A] No registered agent found for capability: '{capability}'")
        return None

    # Try agents in order until one succeeds
    for agent in agents:
        endpoint = f"{agent.base_url.rstrip('/')}/tasks"
        task_request = {
            "task_id":    f"founderos-{int(time.time())}",
            "from_agent": FOUNDEROS_AGENT_CARD.agent_id,
            "capability": capability,
            "payload":    task_payload,
        }
        try:
            async with httpx.AsyncClient(timeout=timeout_secs) as client:
                log.info(f"[A2A] Delegating '{capability}' → {agent.name} ({agent.base_url})")
                resp = await client.post(endpoint, json=task_request)
                resp.raise_for_status()
                result = resp.json()
                log.info(f"[A2A] Received result from {agent.name}: {str(result)[:200]}")
                return result
        except Exception as e:
            log.warning(f"[A2A] Delegation to {agent.name} failed: {e}. Trying next agent.")

    log.error(f"[A2A] All agents failed for capability: '{capability}'")
    return None


# ─── V8 Sovereign Negotiation ──────────────────────────────────────────────────

class A2ANegotiator:
    """
    Handles 'Counter-Offer' logic for V8.
    If an external agent returns a cost/time that exceeds FounderOS policy,
    the Negotiator attempts to haggle or rejects the proposal.
    """
    def __init__(self, budget_limit: float = 100.0):
        self.budget_limit = budget_limit

    def evaluate_partnership(self, partner_agent: str, offer: dict) -> bool:
        """
        Decide whether to accept an external agent's offer.
         offer example: {"cost": 50, "eta_hours": 2, "quality_score": 0.9}
        """
        cost = offer.get("cost", 0)
        if cost > self.budget_limit:
            log.warning(f"[Negotiator] REJECTED {partner_agent}: Cost {cost} exceeds limit {self.budget_limit}")
            return False
        
        log.info(f"[Negotiator] ACCEPTED {partner_agent} offer: {offer}")
        return True


class PartnerAgentSimulator:
    """
    V8 Transition Tool: Simulates an external partner for testing.
    Responds to A2A requests with randomized quality and costs.
    """
    @staticmethod
    def process_task(capability: str, payload: dict) -> dict:
        log.info(f"[A2A-Simulator] Processing '{capability}' for FounderOS...")
        import random
        # Simulate business logic
        return {
            "status": "completed",
            "result": f"Simulated {capability} result for {payload.get('topic', 'unknown')}",
            "economics": {
                "cost": random.randint(10, 80),
                "eta_hours": random.randint(1, 5)
            }
        }


# ─── Serve FounderOS Agent Card ───────────────────────────────────────────────
def get_founderos_card_json() -> str:
    """Return the FounderOS agent card as JSON for the /.well-known/agent-card endpoint."""
    return FOUNDEROS_AGENT_CARD.to_json()


# ─── Example: Pre-register known partner agents ───────────────────────────────
# In production, discover these dynamically. These are static placeholders.
A2ARegistry.register(ExternalAgent(
    agent_id     = "example-scheduling-agent",
    name         = "External Scheduling Agent (Placeholder)",
    base_url     = "http://localhost:9001/a2a",  # replace with real endpoint
    capabilities = ["schedule_meeting", "send_calendar_invite"],
))


if __name__ == "__main__":
    # Print FounderOS Agent Card for verification
    print(get_founderos_card_json())
