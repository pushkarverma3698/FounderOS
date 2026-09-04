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

export const FINANCE_SKILL_DICTIONARY: readonly SkillTerm[] = [
  { term: "IFRS", category: "practice", aliases: ["ifrs", "international financial reporting standards"] },
  { term: "GAAP", category: "practice", aliases: ["gaap", "dutch gaap", "us gaap"] },
  { term: "Financial Modeling", category: "practice", aliases: ["financial modeling", "financial modelling", "dcf", "valuation"] },
  { term: "Financial Analysis", category: "practice", aliases: ["financial analysis", "fp&a", "variance analysis"] },
  { term: "Budgeting & Forecasting", category: "practice", aliases: ["budgeting", "forecasting", "budgeting and forecasting", "cash flow forecasting"] },
  { term: "SAP", category: "framework", aliases: ["sap", "sap erp", "sap s/4hana"] },
  { term: "Excel / Advanced Excel", category: "framework", aliases: ["excel", "advanced excel", "vlookup", "pivot tables", "macros", "vba"] },
  { term: "Power BI", category: "framework", aliases: ["power bi", "powerbi"] },
  { term: "Tableau", category: "framework", aliases: ["tableau"] },
  { term: "Oracle / Netsuite", category: "framework", aliases: ["oracle", "netsuite", "oracle netsuite"] },
  { term: "QuickBooks", category: "framework", aliases: ["quickbooks", "qbo"] },
  { term: "Xero", category: "framework", aliases: ["xero"] },
  { term: "Auditing", category: "practice", aliases: ["audit", "auditing", "internal audit", "external audit", "statutory audit"] },
  { term: "Tax Compliance", category: "practice", aliases: ["tax compliance", "vat", "btw", "corporate tax", "transfer pricing"] },
  { term: "Accounts Payable", category: "practice", aliases: ["accounts payable", "ap", "p2p", "procure to pay"] },
  { term: "Accounts Receivable", category: "practice", aliases: ["accounts receivable", "ar", "o2c", "order to cash"] },
  { term: "General Ledger", category: "practice", aliases: ["general ledger", "gl", "month-end close", "year-end close"] },
  { term: "Reconciliation", category: "practice", aliases: ["reconciliation", "bank reconciliation", "balance sheet reconciliation"] },
  { term: "Treasury & Cash Management", category: "practice", aliases: ["treasury", "cash management", "liquidity management"] },
  { term: "Risk & Compliance", category: "practice", aliases: ["risk management", "internal controls", "sox", "compliance"] },

  // Added 2026-09-04 from a real CV (Tashi Goyal): tools and frameworks the
  // tech dictionary already has (Python, SQL) don't reach finance-profile
  // screening, because getSkillDictionary picks ONE list by name, not a union —
  // so they had zero chance of matching here until added directly.
  { term: "Power Query", category: "framework", aliases: ["power query"] },
  { term: "SQL", category: "framework", aliases: ["sql", "structured query language"] },
  { term: "Python", category: "framework", aliases: ["python"] },
  { term: "R / RStudio", category: "framework", aliases: ["rstudio", "r studio", " r programming"] },
  { term: "COSO Framework", category: "practice", aliases: ["coso", "coso framework"] },
  { term: "KYC / AML", category: "practice", aliases: ["kyc", "aml", "anti-money laundering", "know your customer", "cdd", "client due diligence"] },
  { term: "FATCA / MiFID / EMIR", category: "practice", aliases: ["fatca", "mifid", "emir"] },
  { term: "Management Reporting", category: "practice", aliases: ["management reporting", "mis reporting", "mis"] },
  { term: "Business Case Modeling", category: "practice", aliases: ["business case", "business case modeling", "business case modelling"] },
  { term: "Headcount / FTE Planning", category: "practice", aliases: ["headcount planning", "fte tracker", "fte phasing", "workforce planning"] },
];

export function getSkillDictionary(name: string = "tech"): readonly SkillTerm[] {
  if (name === "finance") return FINANCE_SKILL_DICTIONARY;
  return SKILL_DICTIONARY;
}
