-- P5: Separate operational (agents) vs knowledge (brain) schemas.
-- Idempotent: safe to re-run on databases already migrated.

CREATE SCHEMA IF NOT EXISTS agents;
CREATE SCHEMA IF NOT EXISTS brain;

-- ── agents schema (operational / LangGraph / signals) ─────────────────────────
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'hitl_approvals') THEN
    ALTER TABLE public.hitl_approvals SET SCHEMA agents;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'ai_call_costs') THEN
    ALTER TABLE public.ai_call_costs SET SCHEMA agents;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'action_log') THEN
    ALTER TABLE public.action_log SET SCHEMA agents;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'outbound_leads') THEN
    ALTER TABLE public.outbound_leads SET SCHEMA agents;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'do_not_contact') THEN
    ALTER TABLE public.do_not_contact SET SCHEMA agents;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'agent_results') THEN
    ALTER TABLE public.agent_results SET SCHEMA agents;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'dept_signals') THEN
    ALTER TABLE public.dept_signals SET SCHEMA agents;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'founder_context') THEN
    ALTER TABLE public.founder_context SET SCHEMA agents;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'conversations') THEN
    ALTER TABLE public.conversations SET SCHEMA agents;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'episodic_memory') THEN
    ALTER TABLE public.episodic_memory SET SCHEMA agents;
  END IF;
  -- LangGraph checkpoint tables
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'checkpoints') THEN
    ALTER TABLE public.checkpoints SET SCHEMA agents;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'checkpoint_blobs') THEN
    ALTER TABLE public.checkpoint_blobs SET SCHEMA agents;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'checkpoint_writes') THEN
    ALTER TABLE public.checkpoint_writes SET SCHEMA agents;
  END IF;
END $$;

-- ── brain schema (knowledge / pgvector) ─────────────────────────────────────
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'knowledge_entries') THEN
    ALTER TABLE public.knowledge_entries SET SCHEMA brain;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'personal_rag') THEN
    ALTER TABLE public.personal_rag SET SCHEMA brain;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'turicks_brain') THEN
    ALTER TABLE public.turicks_brain SET SCHEMA brain;
  END IF;
END $$;
