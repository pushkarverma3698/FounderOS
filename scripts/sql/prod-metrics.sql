\pset border 2
\echo '=== A. LLM COST / CALL VOLUME (ai_call_costs) ==='
SELECT count(*) calls, round(sum(cost_usd)::numeric,4) total_usd,
       round(avg(cost_usd)::numeric,6) avg_usd,
       min(created_at)::date first, max(created_at)::date last,
       count(DISTINCT model) models
FROM agents.ai_call_costs;
SELECT model, count(*) n, round(sum(cost_usd)::numeric,4) usd
FROM agents.ai_call_costs GROUP BY model ORDER BY n DESC LIMIT 8;

\echo '=== B. HITL APPROVALS (the human gate, in production) ==='
SELECT status, count(*) n FROM agents.hitl_approvals GROUP BY status ORDER BY n DESC;
SELECT action, count(*) n FROM agents.hitl_approvals GROUP BY action ORDER BY n DESC LIMIT 12;
SELECT min(created_at)::date first, max(created_at)::date last FROM agents.hitl_approvals;

\echo '=== C. ACTION LOG (real side effects executed) ==='
SELECT action_type, count(*) n FROM agents.action_log GROUP BY action_type ORDER BY n DESC LIMIT 12;

\echo '=== D. AGENT RESULTS / MISSIONS ==='
SELECT count(*) FROM agents.agent_results;
SELECT count(*) FROM agents.checkpoints;

\echo '=== E. JOB INGEST RUNS (pipeline throughput) ==='
SELECT count(*) runs, min(created_at)::date first, max(created_at)::date last FROM agents.job_ingest_runs;

\echo '=== F. BRAIN / RAG CORPUS ==='
SELECT count(*) chunks, count(DISTINCT source_path) docs FROM brain.turicks_brain;

\echo '=== G. EVOLUTION FINDINGS (self-improvement loop) ==='
SELECT count(*) FROM agents.evolution_findings;
SELECT count(*) FROM agents.answer_evaluations;
