/**
 * FounderOS — CV signal dictionary
 * ================================
 * The curated vocabulary `extractSkillTerms` matches against posting bodies.
 *
 * A dictionary rather than a model pass, for three reasons: the same posting
 * yields the same signals forever (frequency counts are only meaningful if the
 * extractor is stable), it is unit-testable, and it costs nothing per posting —
 * which matters when the sweep runs daily and unattended.
 *
 * The cost of a fixed vocabulary is that it misses emerging terms. That gap is
 * covered by the unknown-term pass in skills.ts, which surfaces rising
 * candidates for the founder to promote into this file.
 *
 * ALIAS RULES (learned the hard way):
 *   · Aliases are lowercase; matching lowercases the haystack once.
 *   · Matching uses non-alphanumeric boundaries, so "go" would fire inside
 *     "going" — short, common English words are therefore NEVER used as aliases.
 *     Go is matched by "golang" only. Under-counting Go is a wrong number;
 *     matching every "go to" is a broken table.
 *   · Include every spelling that actually appears in postings, not the ones
 *     that ought to. "k8s", "node.js", "nodejs", "ci/cd", "ci cd".
 */

export type SkillCategory =
  | "language"
  | "framework"
  | "infra"
  | "data"
  | "ai"
  | "practice";

/**
 * How much a matched term counts toward ranking, by category.
 *
 * Measured, 2026-09-01: on raw matched-count, "Schuberg Philis — Windows DevOps
 * Engineer" (4/7: Azure, CI/CD, Linux, Mentoring) outranked "Flow Traders — AI
 * Engineer" (10/18: LangGraph, RAG, LLM, Prompt Engineering, AI Agents, Docker,
 * AWS, Azure, CI/CD, Observability) on fit score, because every matched term
 * counted the same regardless of whether it named a technology or described a
 * process every posting mentions. "Mentoring" and "Observability" are real
 * skills but they do not distinguish one candidate from another the way a named
 * language, framework or AI technology does — nearly every engineering posting
 * asks for some version of them.
 *
 * `practice` is downweighted for that reason; every other category counts at
 * full value. This is not "AI outranks backend" — a track's own CV is compared
 * against that track's own postings, so an AI posting only wins against a
 * backend one when it names more of what the CV actually states. The fix is
 * category-neutral: it lowers the weight of generic process vocabulary
 * wherever it appears, in every track.
 */
export const SKILL_CATEGORY_WEIGHT: Readonly<Record<SkillCategory, number>> = {
  language: 1,
  framework: 1,
  infra: 1,
  data: 1,
  ai: 1,
  practice: 0.35,
};

export interface SkillTerm {
  /** Canonical display form — what the founder reads in the gap report. */
  readonly term: string;
  readonly category: SkillCategory;
  /** Lowercase surface forms to match. Must include the canonical form. */
  readonly aliases: readonly string[];
}

export const SKILL_DICTIONARY: readonly SkillTerm[] = [
  // ── Languages ──────────────────────────────────────────────────────────────
  { term: "Python", category: "language", aliases: ["python"] },
  { term: "TypeScript", category: "language", aliases: ["typescript"] },
  { term: "JavaScript", category: "language", aliases: ["javascript"] },
  { term: "Go", category: "language", aliases: ["golang", "go programming"] },
  { term: "Java", category: "language", aliases: ["java"] },
  { term: "C#", category: "language", aliases: ["c#", "csharp"] },
  { term: "C++", category: "language", aliases: ["c++", "cpp"] },
  { term: "Rust", category: "language", aliases: ["rust"] },
  { term: "Scala", category: "language", aliases: ["scala"] },
  { term: "Kotlin", category: "language", aliases: ["kotlin"] },
  { term: "SQL", category: "language", aliases: ["sql"] },
  { term: "Bash", category: "language", aliases: ["bash", "shell scripting"] },
  { term: "PHP", category: "language", aliases: ["php"] },
  { term: "Ruby", category: "language", aliases: ["ruby"] },
  { term: "Swift", category: "language", aliases: ["swift"] },

  // ── AI / ML ────────────────────────────────────────────────────────────────
  { term: "LangChain", category: "ai", aliases: ["langchain"] },
  { term: "LangGraph", category: "ai", aliases: ["langgraph"] },
  { term: "LlamaIndex", category: "ai", aliases: ["llamaindex", "llama index"] },
  { term: "RAG", category: "ai", aliases: ["rag", "retrieval augmented generation", "retrieval-augmented generation"] },
  { term: "Vector Database", category: "ai", aliases: ["vector database", "vector db", "vector store", "vector search"] },
  { term: "Embeddings", category: "ai", aliases: ["embeddings", "embedding model"] },
  { term: "Fine-tuning", category: "ai", aliases: ["fine-tuning", "fine tuning", "finetuning", "lora", "peft"] },
  { term: "LLM", category: "ai", aliases: ["llm", "llms", "large language model", "large language models"] },
  { term: "Prompt Engineering", category: "ai", aliases: ["prompt engineering", "prompting"] },
  { term: "AI Agents", category: "ai", aliases: ["ai agents", "agentic", "agent orchestration", "multi-agent", "multi agent", "autonomous agents"] },
  { term: "MCP", category: "ai", aliases: ["mcp", "model context protocol"] },
  { term: "OpenAI", category: "ai", aliases: ["openai", "gpt-4", "gpt-5"] },
  { term: "Anthropic", category: "ai", aliases: ["anthropic", "claude"] },
  { term: "Hugging Face", category: "ai", aliases: ["hugging face", "huggingface"] },
  { term: "Transformers", category: "ai", aliases: ["transformers", "transformer models"] },
  { term: "PyTorch", category: "ai", aliases: ["pytorch"] },
  { term: "TensorFlow", category: "ai", aliases: ["tensorflow"] },
  { term: "scikit-learn", category: "ai", aliases: ["scikit-learn", "sklearn", "scikit learn"] },
  { term: "MLOps", category: "ai", aliases: ["mlops", "llmops"] },
  { term: "MLflow", category: "ai", aliases: ["mlflow"] },
  { term: "Evals", category: "ai", aliases: ["evals", "eval harness", "model evaluation", "llm evaluation", "offline evaluation"] },
  { term: "Guardrails", category: "ai", aliases: ["guardrails", "ai safety", "content moderation"] },
  { term: "NLP", category: "ai", aliases: ["nlp", "natural language processing"] },
  { term: "Computer Vision", category: "ai", aliases: ["computer vision"] },
  { term: "Reinforcement Learning", category: "ai", aliases: ["reinforcement learning", "rlhf"] },
  { term: "Ollama", category: "ai", aliases: ["ollama"] },
  { term: "vLLM", category: "ai", aliases: ["vllm"] },
  { term: "Weights & Biases", category: "ai", aliases: ["weights & biases", "weights and biases", "wandb"] },

  // ── Frameworks ─────────────────────────────────────────────────────────────
  { term: "FastAPI", category: "framework", aliases: ["fastapi"] },
  { term: "Django", category: "framework", aliases: ["django"] },
  { term: "Flask", category: "framework", aliases: ["flask"] },
  { term: "Node.js", category: "framework", aliases: ["node.js", "nodejs"] },
  { term: "Express", category: "framework", aliases: ["express.js", "expressjs"] },
  { term: "NestJS", category: "framework", aliases: ["nestjs", "nest.js"] },
  { term: "React", category: "framework", aliases: ["react", "react.js", "reactjs"] },
  { term: "Next.js", category: "framework", aliases: ["next.js", "nextjs"] },
  { term: "Vue", category: "framework", aliases: ["vue.js", "vuejs"] },
  { term: "Angular", category: "framework", aliases: ["angular"] },
  { term: "Svelte", category: "framework", aliases: ["svelte", "sveltekit"] },
  { term: "Spring Boot", category: "framework", aliases: ["spring boot", "springboot"] },
  { term: ".NET", category: "framework", aliases: [".net", "dotnet", "asp.net"] },
  { term: "GraphQL", category: "framework", aliases: ["graphql"] },
  { term: "REST API", category: "framework", aliases: ["rest api", "restful", "rest apis"] },
  { term: "gRPC", category: "framework", aliases: ["grpc"] },

  // ── Infrastructure ─────────────────────────────────────────────────────────
  { term: "Docker", category: "infra", aliases: ["docker", "containerisation", "containerization"] },
  { term: "Kubernetes", category: "infra", aliases: ["kubernetes", "k8s"] },
  { term: "Terraform", category: "infra", aliases: ["terraform"] },
  { term: "Pulumi", category: "infra", aliases: ["pulumi"] },
  { term: "Ansible", category: "infra", aliases: ["ansible"] },
  { term: "AWS", category: "infra", aliases: ["aws", "amazon web services"] },
  { term: "Azure", category: "infra", aliases: ["azure"] },
  { term: "GCP", category: "infra", aliases: ["gcp", "google cloud"] },
  { term: "CI/CD", category: "infra", aliases: ["ci/cd", "ci cd", "continuous integration", "continuous delivery"] },
  { term: "GitHub Actions", category: "infra", aliases: ["github actions"] },
  { term: "GitLab CI", category: "infra", aliases: ["gitlab ci", "gitlab-ci"] },
  { term: "Jenkins", category: "infra", aliases: ["jenkins"] },
  { term: "Linux", category: "infra", aliases: ["linux", "unix"] },
  { term: "Nginx", category: "infra", aliases: ["nginx"] },
  { term: "Serverless", category: "infra", aliases: ["serverless", "aws lambda"] },
  { term: "Helm", category: "infra", aliases: ["helm"] },
  { term: "ArgoCD", category: "infra", aliases: ["argocd", "argo cd"] },
  { term: "Prometheus", category: "infra", aliases: ["prometheus"] },
  { term: "Grafana", category: "infra", aliases: ["grafana"] },
  { term: "OpenTelemetry", category: "infra", aliases: ["opentelemetry", "otel"] },
  { term: "Datadog", category: "infra", aliases: ["datadog"] },
  { term: "Sentry", category: "infra", aliases: ["sentry"] },
  { term: "Redis", category: "infra", aliases: ["redis"] },
  { term: "Kafka", category: "infra", aliases: ["kafka"] },
  { term: "RabbitMQ", category: "infra", aliases: ["rabbitmq"] },

  // ── Data ───────────────────────────────────────────────────────────────────
  { term: "PostgreSQL", category: "data", aliases: ["postgresql", "postgres"] },
  { term: "SQLAlchemy", category: "data", aliases: ["sqlalchemy"] },
  { term: "MySQL", category: "data", aliases: ["mysql"] },
  { term: "MongoDB", category: "data", aliases: ["mongodb", "mongo"] },
  { term: "Elasticsearch", category: "data", aliases: ["elasticsearch", "opensearch"] },
  { term: "Snowflake", category: "data", aliases: ["snowflake"] },
  { term: "BigQuery", category: "data", aliases: ["bigquery"] },
  { term: "Databricks", category: "data", aliases: ["databricks"] },
  { term: "Spark", category: "data", aliases: ["apache spark", "pyspark"] },
  { term: "Airflow", category: "data", aliases: ["airflow"] },
  { term: "dbt", category: "data", aliases: ["dbt"] },
  { term: "Pandas", category: "data", aliases: ["pandas"] },
  { term: "NumPy", category: "data", aliases: ["numpy"] },
  { term: "ETL", category: "data", aliases: ["etl", "elt", "data pipelines", "data pipeline"] },
  { term: "Data Warehouse", category: "data", aliases: ["data warehouse", "data lake", "lakehouse"] },
  { term: "pgvector", category: "data", aliases: ["pgvector"] },
  { term: "Pinecone", category: "data", aliases: ["pinecone"] },
  { term: "Weaviate", category: "data", aliases: ["weaviate"] },
  { term: "Qdrant", category: "data", aliases: ["qdrant"] },
  { term: "ClickHouse", category: "data", aliases: ["clickhouse"] },
  { term: "DuckDB", category: "data", aliases: ["duckdb"] },

  // ── Practices ──────────────────────────────────────────────────────────────
  { term: "Agile", category: "practice", aliases: ["agile", "scrum", "kanban"] },
  { term: "TDD", category: "practice", aliases: ["tdd", "test-driven", "test driven development"] },
  { term: "Microservices", category: "practice", aliases: ["microservices", "microservice"] },
  { term: "Event-Driven", category: "practice", aliases: ["event-driven", "event driven", "event sourcing"] },
  { term: "Domain-Driven Design", category: "practice", aliases: ["domain-driven design", "domain driven design"] },
  { term: "System Design", category: "practice", aliases: ["system design", "solution architecture"] },
  { term: "Distributed Systems", category: "practice", aliases: ["distributed systems"] },
  { term: "Observability", category: "practice", aliases: ["observability", "monitoring and alerting"] },
  { term: "Unit Testing", category: "practice", aliases: ["unit testing", "unit tests"] },
  { term: "Integration Testing", category: "practice", aliases: ["integration testing", "integration tests", "end-to-end testing"] },
  { term: "A/B Testing", category: "practice", aliases: ["a/b testing", "a/b tests", "experimentation"] },
  { term: "Code Review", category: "practice", aliases: ["code review", "code reviews", "pull requests"] },
  { term: "Mentoring", category: "practice", aliases: ["mentoring", "mentorship", "coaching junior"] },
  { term: "Stakeholder Management", category: "practice", aliases: ["stakeholder management", "stakeholders"] },
];
