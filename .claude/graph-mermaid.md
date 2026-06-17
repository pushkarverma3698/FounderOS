# FounderOS Architecture Graph

```mermaid
graph TB
  dept_admin["admin"]:::dept
  dept_research["research"]:::dept
  dept_comms["comms"]:::dept
  dept_engineering["engineering"]:::dept
  dept_marketing["marketing"]:::dept
  dept_sales["sales"]:::dept
  dept_personal["personal"]:::dept
  dept_jobhunt["jobhunt"]:::dept
  tool_read_context["read_context"]:::tool
  tool_update_context["update_context"]:::tool
  tool_search_memory["search_memory"]:::tool
  tool_record_event["record_event"]:::tool
  tool_list_pending_signals["list_pending_signals"]:::tool
  tool_search_web["search_web"]:::tool
  tool_search_knowledge["search_knowledge"]:::tool
  tool_search_turicks_brain["search_turicks_brain"]:::tool
  tool_publish_signal["publish_signal"]:::tool
  tool_send_email["send_email"]:::tool
  tool_read_emails["read_emails"]:::tool
  tool_create_calendar_event["create_calendar_event"]:::tool
  tool_github_read["github_read"]:::tool
  tool_github_write["github_write"]:::tool
  tool_project_workflow["project_workflow"]:::tool
  tool_claude_code["claude_code"]:::tool
  tool_linkedin_post["linkedin_post"]:::tool
  tool_read_file["read_file"]:::tool
  tool_list_dir["list_dir"]:::tool
  tool_send_file["send_file"]:::tool
  tool_write_file["write_file"]:::tool
  tool_run_shell["run_shell"]:::tool
  tool_browser["browser"]:::tool
  tool_search_personal_rag["search_personal_rag"]:::tool
  tool_read_cv["read_cv"]:::tool
  tool_search_jobs["search_jobs"]:::tool
  service_supervisor["Supervisor"]:::service
  service_telegam["Telegram Gateway"]:::service
  service_hitl["HITL (Human-in-the-loop)"]:::service
  service_postgres["PostgreSQL"]:::service
  service_redis["Redis"]:::service
  service_ollama["Ollama (nomic-embed-text)"]:::service
  store_turicks_brain["turicks_brain (pgvector)"]:::service
  store_personal_rag["personal_rag (pgvector)"]:::service
  service_judge["Claude Judge"]:::service
  agent_admin_agent -->|belongs_to| dept_admin
  agent_research_agent -->|belongs_to| dept_research
  agent_comms_agent -->|belongs_to| dept_comms
  agent_engineering_agent -->|belongs_to| dept_engineering
  agent_marketing_agent -->|belongs_to| dept_marketing
  agent_sales_agent -->|belongs_to| dept_sales
  agent_personal_agent -->|belongs_to| dept_personal
  agent_jobhunt_agent -->|belongs_to| dept_jobhunt
  tool_read_context -->|belongs_to| dept_admin
  tool_update_context -->|belongs_to| dept_admin
  tool_search_memory -->|belongs_to| dept_admin
  tool_record_event -->|belongs_to| dept_admin
  tool_list_pending_signals -->|belongs_to| dept_admin
  tool_search_web -->|belongs_to| dept_research
  tool_search_knowledge -->|belongs_to| dept_research
  tool_search_turicks_brain -->|belongs_to| dept_research
  tool_publish_signal -->|belongs_to| dept_research
  tool_send_email -->|belongs_to| dept_comms
  tool_read_emails -->|belongs_to| dept_comms
  tool_create_calendar_event -->|belongs_to| dept_comms
  tool_github_read -->|belongs_to| dept_engineering
  tool_github_write -->|belongs_to| dept_engineering
  tool_project_workflow -->|belongs_to| dept_engineering
  tool_claude_code -->|belongs_to| dept_engineering
  tool_search_web -->|belongs_to| dept_marketing
  tool_linkedin_post -->|belongs_to| dept_marketing
  tool_search_knowledge -->|belongs_to| dept_marketing
  tool_search_turicks_brain -->|belongs_to| dept_marketing
  tool_search_web -->|belongs_to| dept_sales
  tool_send_email -->|belongs_to| dept_sales
  tool_search_knowledge -->|belongs_to| dept_sales
  tool_search_turicks_brain -->|belongs_to| dept_sales
  tool_read_file -->|belongs_to| dept_personal
  tool_list_dir -->|belongs_to| dept_personal
  tool_send_file -->|belongs_to| dept_personal
  tool_write_file -->|belongs_to| dept_personal
  tool_run_shell -->|belongs_to| dept_personal
  tool_browser -->|belongs_to| dept_personal
  tool_search_personal_rag -->|belongs_to| dept_personal
  tool_search_turicks_brain -->|belongs_to| dept_personal
  tool_read_cv -->|belongs_to| dept_jobhunt
  tool_search_jobs -->|belongs_to| dept_jobhunt
  tool_send_email -->|belongs_to| dept_jobhunt
  tool_search_personal_rag -->|belongs_to| dept_jobhunt
  dept_admin -->|calls| service_supervisor
  dept_admin -->|calls| service_telegam
  dept_research -->|calls| service_supervisor
  dept_research -->|calls| service_telegam
  dept_comms -->|calls| service_supervisor
  dept_comms -->|calls| service_telegam
  dept_engineering -->|calls| service_supervisor
  dept_engineering -->|calls| service_telegam
  dept_marketing -->|calls| service_supervisor
  dept_marketing -->|calls| service_telegam
  dept_sales -->|calls| service_supervisor
  dept_sales -->|calls| service_telegam
  dept_personal -->|calls| service_supervisor
  dept_personal -->|calls| service_telegam
  dept_jobhunt -->|calls| service_supervisor
  dept_jobhunt -->|calls| service_telegam
  service_supervisor -->|calls| service_hitl
  service_supervisor -->|depends_on| service_postgres
  service_supervisor -->|depends_on| service_redis
  tool_search_turicks_brain -->|depends_on| service_ollama
  tool_search_turicks_brain -->|depends_on| store_turicks_brain
  tool_search_personal_rag -->|depends_on| service_ollama
  tool_search_personal_rag -->|depends_on| store_personal_rag
  store_turicks_brain -->|depends_on| service_ollama
  store_turicks_brain -->|depends_on| service_postgres
  store_personal_rag -->|depends_on| service_postgres
  tool_publish_signal -->|depends_on| service_postgres
  service_supervisor -->|depends_on| service_judge

  classDef dept fill:#3b82f6,stroke:#1e40af,color:#fff
  classDef tool fill:#10b981,stroke:#065f46,color:#fff
  classDef service fill:#f59e0b,stroke:#b45309,color:#fff
```
