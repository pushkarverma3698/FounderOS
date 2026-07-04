/**
 * FounderOS — Ops Cockpit UI (Phase 5)
 * ====================================
 * A single self-contained HTML page (no build step) served at `/cockpit` by the
 * health server. Vanilla JS polls the read-only `/api/v1/cockpit/*` + `/audit`
 * endpoints. Kept dependency-free so it deploys with the service and works
 * everywhere (KISS, rule #17). If WEB_GATEWAY_TOKEN is set, append `?token=`.
 */

export const COCKPIT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>FounderOS — Ops Cockpit</title>
<style>
  :root {
    --bg: #0a0e14; --panel: #121823; --line: #1f2937; --txt: #e5e9f0;
    --dim: #8b97a8; --accent: #38bdf8; --ok: #34d399; --warn: #fbbf24; --bad: #f87171;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--txt);
    font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  header { display: flex; align-items: center; gap: 12px; padding: 14px 20px;
    border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--bg); }
  header h1 { font-size: 16px; margin: 0; letter-spacing: .5px; }
  header .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--dim); }
  header .meta { color: var(--dim); font-size: 12px; margin-left: auto; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
    gap: 16px; padding: 20px; }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
    padding: 16px; min-height: 120px; }
  .panel h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 1px;
    color: var(--accent); margin: 0 0 12px; }
  .kpis { display: flex; gap: 18px; flex-wrap: wrap; margin-bottom: 8px; }
  .kpi b { display: block; font-size: 22px; }
  .kpi span { color: var(--dim); font-size: 11px; text-transform: uppercase; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--line); }
  th { color: var(--dim); font-weight: 500; }
  .tag { display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 11px;
    background: #1e293b; color: var(--dim); margin: 2px 4px 2px 0; }
  .tag.on { background: #0f2f23; color: var(--ok); }
  .tag.off { background: #2f1414; color: var(--bad); }
  .st-up { color: var(--ok); } .st-down { color: var(--bad); } .st-deg { color: var(--warn); }
  input { width: 100%; padding: 8px 10px; background: #0d131c; border: 1px solid var(--line);
    border-radius: 7px; color: var(--txt); font: inherit; margin-bottom: 10px; }
  .muted { color: var(--dim); }
  .err { color: var(--bad); }
  pre { white-space: pre-wrap; word-break: break-word; margin: 4px 0 0; color: var(--dim); }
  .scroll { max-height: 320px; overflow: auto; }
</style>
</head>
<body>
<header>
  <span class="dot" id="hdot"></span>
  <h1>FounderOS — Ops Cockpit</h1>
  <span class="meta" id="meta">connecting…</span>
</header>
<div class="grid">
  <section class="panel" id="p-health"><h2>System health</h2><div class="muted">loading…</div></section>
  <section class="panel" id="p-cost"><h2>Token &amp; cost (7d)</h2><div class="muted">loading…</div></section>
  <section class="panel" id="p-state"><h2>Departments &amp; hierarchy</h2><div class="muted">loading…</div></section>
  <section class="panel" id="p-mcp"><h2>Bridged MCP servers</h2><div class="muted">loading…</div></section>
  <section class="panel" id="p-know"><h2>Knowledge search</h2>
    <input id="kq" placeholder="search turicks-brain…" autocomplete="off" />
    <div id="kres" class="muted">type a query and press Enter</div>
  </section>
  <section class="panel" id="p-audit"><h2>Action log (latest)</h2><div class="muted">loading…</div></section>
</div>
<script>
const TOKEN = new URLSearchParams(location.search).get("token");
const q = (p) => "/api/v1" + p + (TOKEN ? (p.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(TOKEN) : "");
const esc = (s) => String(s ?? "").replace(/[&<>]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
const num = (n) => Number(n ?? 0).toLocaleString();
async function getJSON(p){ const r = await fetch(q(p)); if(!r.ok) throw new Error(r.status+" "+p); return r.json(); }

function renderHealth(h){
  const cls = h.status === "ok" ? "st-up" : "st-deg";
  document.getElementById("hdot").style.background = h.status === "ok" ? "var(--ok)" : "var(--warn)";
  const spend = Object.entries(h.spend_today_usd || {}).map(([t,v]) => esc(t)+": $"+Number(v).toFixed(4)).join(" · ") || "—";
  document.getElementById("p-health").innerHTML = "<h2>System health</h2>" +
    "<div class='kpis'>" +
    "<div class='kpi'><b class='"+cls+"'>"+esc(h.status)+"</b><span>status</span></div>" +
    "<div class='kpi'><b class='"+(h.checks.database==='up'?'st-up':'st-down')+"'>"+esc(h.checks.database)+"</b><span>database</span></div>" +
    "<div class='kpi'><b class='"+(h.checks.gmail_active==='up'?'st-up':h.checks.gmail_active==='down'?'st-down':'st-deg')+"'>"+esc(h.checks.gmail_active)+"</b><span>gmail</span></div>" +
    "<div class='kpi'><b class='"+(h.checks.rag==='up'?'st-up':'st-deg')+"'>"+esc(h.checks.rag)+"</b><span>rag</span></div>" +
    "</div>" +
    "<div class='muted'>v"+esc(h.version)+" · up "+num(h.uptime_s)+"s · backend "+esc(h.checks.gmail_backend)+"</div>" +
    "<div class='muted'>spend today — "+spend+"</div>";
}
function renderCost(c){
  const t = c.totals || {};
  const rows = (c.rows||[]).slice(0,12).map(r =>
    "<tr><td>"+esc(r.model||"—")+"</td><td>"+esc(r.agent||"—")+"</td><td>"+num(r.calls)+"</td>" +
    "<td>"+num(Number(r.total_tokens_in)+Number(r.total_tokens_out))+"</td><td>$"+Number(r.total_cost_usd||0).toFixed(4)+"</td></tr>").join("");
  document.getElementById("p-cost").innerHTML = "<h2>Token &amp; cost ("+esc(c.days)+"d)</h2>" +
    "<div class='kpis'>" +
    "<div class='kpi'><b>$"+Number(t.costUsd||0).toFixed(2)+"</b><span>spend</span></div>" +
    "<div class='kpi'><b>"+num(t.calls)+"</b><span>calls</span></div>" +
    "<div class='kpi'><b>"+num(t.tokensIn)+"</b><span>tokens in</span></div>" +
    "<div class='kpi'><b>"+num(t.tokensOut)+"</b><span>tokens out</span></div></div>" +
    (rows ? "<div class='scroll'><table><tr><th>model</th><th>agent</th><th>calls</th><th>tokens</th><th>cost</th></tr>"+rows+"</table></div>"
          : "<div class='muted'>no cost rows in window</div>");
}
function renderState(s){
  const deps = (s.departments||[]).map(d => "<span class='tag'>"+esc(d)+"</span>").join("");
  const sg = s.subgraphs || {};
  document.getElementById("p-state").innerHTML = "<h2>Departments &amp; hierarchy</h2>" +
    "<div style='margin-bottom:10px'>"+deps+"</div>" +
    "<div><span class='tag "+(sg.engineering?'on':'off')+"'>engineering subgraph "+(sg.engineering?'ON':'OFF')+"</span>" +
    "<span class='tag "+(sg.revenue?'on':'off')+"'>revenue subgraph "+(sg.revenue?'ON':'OFF')+"</span></div>";
  const mcp = (s.mcpServers||[]);
  document.getElementById("p-mcp").innerHTML = "<h2>Bridged MCP servers</h2>" +
    (mcp.length ? "<table><tr><th>server</th><th>departments</th><th>write-gated</th></tr>" +
      mcp.map(m => "<tr><td>"+esc(m.name)+"</td><td class='muted'>"+esc((m.departments||[]).join(", "))+"</td><td>"+num(m.writeTools)+"</td></tr>").join("") + "</table>"
      : "<div class='muted'>no MCP servers bridged</div>");
}
function renderAudit(a){
  const rows = (a.entries||[]).slice(0,30).map(e =>
    "<tr><td class='muted'>"+esc((e.created_at||"").toString().slice(5,19))+"</td><td>"+esc(e.action)+"</td>" +
    "<td class='muted'>"+esc(e.target||e.recipient||"")+"</td></tr>").join("");
  document.getElementById("p-audit").innerHTML = "<h2>Action log (latest)</h2>" +
    (rows ? "<div class='scroll'><table><tr><th>time</th><th>action</th><th>target</th></tr>"+rows+"</table></div>"
          : "<div class='muted'>no audit rows</div>");
}
async function refresh(){
  try {
    const [health, c, s, a] = await Promise.all([
      fetch("/health").then(r=>r.json()).catch(()=>null), // /health lives outside /api/v1
      getJSON("/cockpit/cost?days=7"),
      getJSON("/cockpit/state"), getJSON("/audit"),
    ]);
    if (health) renderHealth(health);
    renderCost(c); renderState(s); renderAudit(a);
    document.getElementById("meta").textContent = "updated " + new Date().toLocaleTimeString();
  } catch(e){
    document.getElementById("meta").innerHTML = "<span class='err'>"+esc(e.message)+"</span>";
  }
}
async function search(){
  const v = document.getElementById("kq").value.trim();
  const box = document.getElementById("kres");
  if(!v){ box.className="muted"; box.textContent="type a query and press Enter"; return; }
  box.className="muted"; box.textContent="searching…";
  try {
    const r = await getJSON("/cockpit/knowledge?q="+encodeURIComponent(v));
    box.className="";
    box.innerHTML = (r.results||[]).length
      ? r.results.map(k => "<div style='margin-bottom:10px'><b>"+esc(k.title)+"</b> <span class='tag'>"+esc(k.entry_type)+"</span><pre>"+esc((k.content||"").slice(0,260))+"</pre></div>").join("")
      : "<span class='muted'>no matches</span>";
  } catch(e){ box.className="err"; box.textContent=e.message; }
}
document.getElementById("kq").addEventListener("keydown", e => { if(e.key==="Enter") search(); });
refresh(); setInterval(refresh, 10000);
</script>
</body>
</html>`;
