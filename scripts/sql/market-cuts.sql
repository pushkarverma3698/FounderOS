\pset border 2
\echo '=== 1. TOP TITLES (ai track) ==='
SELECT title, count(*) n FROM agents.job_applications
WHERE track='ai' GROUP BY title ORDER BY n DESC LIMIT 25;

\echo '=== 2. TITLE KEYWORDS across all 911 ==='
WITH k(label,pat) AS (VALUES
 ('AI Engineer','\mai engineer'),('ML Engineer','\m(ml|machine learning) engineer'),
 ('Data Scientist','data scientist'),('LLM','\mllm\M|large language'),
 ('GenAI in title','\mgen ?ai\M|generative'),('Agent in title','\magent'),
 ('Backend','\mbackend\M|\mback[ -]end\M'),('Fullstack','\mfull[ -]?stack\M'),
 ('Frontend','\mfrontend\M|\mfront[ -]end\M'),('Platform','\mplatform\M'),
 ('Senior','\msenior\M|\msr\.?\M'),('Staff/Principal','\mstaff\M|\mprincipal\M'),
 ('Lead','\mlead\M'),('Junior/Grad','\mjunior\M|\mgraduate\M|\mintern\M'))
SELECT k.label, count(*) FILTER (WHERE j.title ~* k.pat) n,
 round(100.0*count(*) FILTER (WHERE j.title ~* k.pat)/count(*),1) pct
FROM k CROSS JOIN agents.job_applications j GROUP BY k.label ORDER BY n DESC;

\echo '=== 3. SENIORITY / YEARS demanded (ai track descriptions) ==='
WITH y(label,pat) AS (VALUES
 ('1-2 yrs','\m[1-2]\+? *(-|to)? *[0-9]? *years?'),
 ('3+ yrs','\m3\+? *(-|to)? *[0-9]? *years?'),
 ('5+ yrs','\m5\+? *(-|to)? *[0-9]? *years?'),
 ('8+ yrs','\m([8-9]|1[0-9])\+? *(-|to)? *[0-9]? *years?'))
SELECT y.label, count(*) FILTER (WHERE j.description ~* y.pat) n
FROM y CROSS JOIN agents.job_applications j WHERE j.track='ai' GROUP BY y.label ORDER BY n DESC;

\echo '=== 4. AI-track: NL vs IN skill deltas (top differentiators) ==='
WITH t(label,pat) AS (VALUES
 ('LangGraph','\mlanggraph\M'),('LangChain','\mlangchain\M'),('MCP','model context protocol|\mmcp\M'),
 ('RAG','\mrag\M|retrieval[ -]augmented'),('eval','\meval(s|uation)?\M'),
 ('agent','\magent(s|ic)?\M'),('multi-agent','multi[ -]?agent'),('guardrails','guardrail'),
 ('observability','observabilit'),('Python','\mpython\M'),('TypeScript','\mtypescript\M'),
 ('Kubernetes','\mkubernetes\M|\mk8s\M'),('fine-tuning','fine[ -]?tun'),('HITL','human[ -]in[ -]the[ -]loop|\mhitl\M'))
SELECT t.label,
 count(*) FILTER (WHERE j.country='NL' AND j.description ~* t.pat) nl,
 round(100.0*count(*) FILTER (WHERE j.country='NL' AND j.description ~* t.pat)
   /NULLIF(count(*) FILTER (WHERE j.country='NL'),0),1) nl_pct,
 count(*) FILTER (WHERE j.country='IN' AND j.description ~* t.pat) "in",
 round(100.0*count(*) FILTER (WHERE j.country='IN' AND j.description ~* t.pat)
   /NULLIF(count(*) FILTER (WHERE j.country='IN'),0),1) in_pct
FROM t CROSS JOIN agents.job_applications j WHERE j.track='ai' GROUP BY t.label ORDER BY nl_pct DESC NULLS LAST;

\echo '=== 5. CO-OCCURRENCE: the production-agent stack ==='
SELECT
 count(*) FILTER (WHERE description ~* '\magent(s|ic)?\M') AS agents_,
 count(*) FILTER (WHERE description ~* '\magent(s|ic)?\M' AND description ~* '\meval(s|uation)?\M') AS agents_eval,
 count(*) FILTER (WHERE description ~* '\magent(s|ic)?\M' AND description ~* '\meval(s|uation)?\M' AND description ~* 'production[ -](system|environment|grade|ready)') AS agents_eval_prod,
 count(*) FILTER (WHERE description ~* '\magent(s|ic)?\M' AND description ~* '\mrag\M|retrieval[ -]augmented') AS agents_rag,
 count(*) AS total
FROM agents.job_applications WHERE track='ai';

\echo '=== 6. SALARY + SPONSOR posture (NL) ==='
SELECT salary_status, count(*) n FROM agents.job_applications WHERE country='NL' GROUP BY salary_status ORDER BY n DESC;
SELECT sponsor_verdict, count(*) n FROM agents.job_applications WHERE country='NL' GROUP BY sponsor_verdict ORDER BY n DESC;

\echo '=== 7. VOLUME over time (weekly discovery) ==='
SELECT date_trunc('week',created_at)::date wk, count(*) n,
 count(*) FILTER (WHERE track='ai') ai
FROM agents.job_applications GROUP BY wk ORDER BY wk;

\echo '=== 8. TOP HIRING COMPANIES (ai track) ==='
SELECT company, count(*) n FROM agents.job_applications WHERE track='ai' GROUP BY company ORDER BY n DESC LIMIT 20;
