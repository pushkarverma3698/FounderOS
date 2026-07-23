# 05 — Deployment Pipeline

How a commit reaches production. Promotion is **two-stage** (work branch → `beta`
→ `main`, ADR-045; the former `stable` tier was retired). **`main` IS production** —
only humans merge to it, and every merge auto-deploys to the Hetzner VPS after CI
passes. Full runbook + Day-1 gotchas: [`docs/guides/DEPLOYMENT.md`](../guides/DEPLOYMENT.md).

```mermaid
flowchart TD
  pr[Feature branch + PR] -->|CI-green| beta[(beta)]
  beta -->|human merge only| main[(main)]
  main --> ci

  subgraph ci["CI workflow (.github/workflows/ci.yml)"]
    lint[lint · tsc + eslint] --> unit[unit tests]
    unit --> integ[integration<br/>skip w/o GOOGLE key]
    integ --> evalj[eval + readme metrics<br/>skip w/o key]
  end

  ci -->|workflow_run: success AND branch=main| cd

  subgraph cd["CD workflow (deploy.yml)"]
    render[render /opt/founderos/.env<br/>from base64 PROD_DOTENV secret] --> validate[validate DATABASE_URL present]
    validate --> ssh[appleboy/ssh-action → VPS]
    ssh --> pull[git pull + pnpm install + build]
    pull --> migrate[drizzle migrate]
    migrate --> restart[sudo systemctl restart founderos<br/>NOPASSWD-scoped]
  end

  cd --> health{GET /health<br/>200?}
  health -- yes --> live([🟢 LIVE])
  health -- no --> rollback[deploy fails loud<br/>previous unit still running]

  subgraph vps["Hetzner VPS · YOUR_VPS_IP"]
    app["founderos.service<br/>(native systemd, Node 22)"]
    dpg[("Docker: Postgres")]
    dol["Docker: Ollama"]
    app --- dpg
    app --- dol
  end
  restart -.-> app

  classDef live fill:#22c55e,stroke:#15803d,color:#fff
  class live live
```

**Hard-won facts**
- CI gating must happen at the **step** level via `env`, not a job-level `if:` —
  `secrets.*` in a job-level `if:` silently invalidates the whole workflow (0s pass).
- The box `.env` + the `PROD_DOTENV` GitHub secret are the **single source of truth**
  for prod env. **Never re-push the local Mac `.env.production`** — it has a stale DB
  password and would overwrite working prod values. Refresh the Mac copy *from* the box.
- Postgres + Ollama run as Docker containers; the app itself runs **native** under
  systemd (not containerized) so deploys are a fast `git pull` + restart.
- Deploy key `~/.ssh/founderos_deploy`; SSH `founderos@YOUR_VPS_IP:22`; the deploy
  user's only NOPASSWD sudo right is `systemctl restart founderos`.
