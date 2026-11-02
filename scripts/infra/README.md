# scripts/infra

Host-level setup scripts for the production VPS. Each one is idempotent, prints what it did, and exits
non-zero with a reason on stderr when it cannot do its job.

| Script | What it does |
| --- | --- |
| `apply-link-funnel.sh` | Publishes `https://<node>.ts.net/apply/*` -> `127.0.0.1:3001/apply/*` through Tailscale Funnel and prints the public base URL. Runs on every deploy (`deploy/deploy.sh`), changes nothing when the mapping is already right. `--print-base-url` only prints the URL. |
