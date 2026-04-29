"""
FounderOS Telegram Formatter
============================
Beautiful, structured message templates for Telegram output.
All messages use HTML parse_mode for maximum readability.
"""
from __future__ import annotations
from datetime import datetime
from typing import Iterable

# ─────────────────────────────────────────────
# EMOJI KEY
# ─────────────────────────────────────────────
EMOJI = {
    "turicks": "💼", "naggar": "🏔️", "cross": "🌐",
    "ok": "✅", "fail": "❌", "warn": "⚠️", "info": "ℹ️",
    "run": "🚀", "brain": "🧠", "wrench": "🔧", "chart": "📊",
    "clock": "⏱️", "tool": "🛠️", "memo": "📝", "spark": "✨",
    "fire": "🔥", "money": "💰", "people": "👥", "bot": "🤖",
}

TIER_EMOJI = {
    "ceo": "👑", "deep_research": "🔬", "md": "🎯",
    "nano": "⚡", "local": "🏠", "code": "💻", "video": "🎬",
}


def _esc(s: str) -> str:
    """HTML-escape for Telegram parse_mode=HTML."""
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _truncate(s: str, n: int = 3500) -> str:
    s = str(s)
    if len(s) <= n:
        return s
    return s[:n] + "\n…[truncated]"


def header(title: str, subtitle: str = "") -> str:
    line = "━" * 28
    out = f"<b>{_esc(title)}</b>"
    if subtitle:
        out += f"\n<i>{_esc(subtitle)}</i>"
    return f"{line}\n{out}\n{line}"


def agent_report(
    agent: str,
    company: str,
    tier: str,
    task: str,
    result: str,
    tools_used: list[str] | None = None,
    model: str = "",
    duration_s: float | None = None,
    status: str = "ok",
) -> str:
    """Render a single agent's task output."""
    status_emoji = EMOJI.get(status, EMOJI["info"])
    co_emoji = EMOJI.get(company, "🌐")
    tier_e = TIER_EMOJI.get(tier, "🎯")

    lines = [
        f"{status_emoji} <b>{_esc(agent)}</b>  {co_emoji} <i>{_esc(company)}</i>  {tier_e} <code>{_esc(tier)}</code>",
        "",
        f"<b>📋 Task</b>\n<blockquote>{_esc(_truncate(task, 400))}</blockquote>",
        "",
        f"<b>💬 Result</b>\n<blockquote>{_esc(_truncate(result, 2500))}</blockquote>",
    ]
    meta_bits = []
    if model:
        meta_bits.append(f"🤖 <code>{_esc(model)}</code>")
    if tools_used:
        meta_bits.append(f"🛠 <code>{_esc(', '.join(tools_used))}</code>")
    if duration_s is not None:
        meta_bits.append(f"⏱ <code>{duration_s:.2f}s</code>")
    if meta_bits:
        lines.append("")
        lines.append(" │ ".join(meta_bits))
    lines.append(f"<i>{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}</i>")
    return "\n".join(lines)


def section_divider(title: str) -> str:
    return f"\n<b>─── {_esc(title)} ───</b>\n"


def production_summary(
    total: int,
    passed: int,
    failed: int,
    cross_tests: int,
    cross_passed: int,
    avg_duration: float,
    models_used: dict[str, int],
    per_company: dict[str, tuple[int, int]],
) -> str:
    readiness = "🟢 READY" if passed / max(total, 1) >= 0.85 else ("🟡 NEEDS WORK" if passed / max(total, 1) >= 0.6 else "🔴 NOT READY")
    lines = [
        header("FounderOS — Production Readiness Report", f"Run on {datetime.now():%Y-%m-%d %H:%M}"),
        "",
        f"<b>Verdict:</b> {readiness}",
        "",
        f"<b>{EMOJI['chart']} Agent Tests</b>",
        f"  • Total agents:   <b>{total}</b>",
        f"  • ✅ Passed:       <b>{passed}</b>",
        f"  • ❌ Failed:       <b>{failed}</b>",
        f"  • Pass rate:      <b>{passed/max(total,1)*100:.1f}%</b>",
        "",
        f"<b>🔄 Cross-Company Tests</b>",
        f"  • Total: <b>{cross_tests}</b>   Passed: <b>{cross_passed}</b>",
        "",
        f"<b>{EMOJI['clock']} Performance</b>",
        f"  • Avg duration/agent: <b>{avg_duration:.2f}s</b>",
        "",
        f"<b>{EMOJI['bot']} Models Used</b>",
    ]
    for model, count in sorted(models_used.items(), key=lambda x: -x[1]):
        lines.append(f"  • <code>{_esc(model)}</code>: {count}×")
    lines.append("")
    lines.append(f"<b>{EMOJI['people']} By Company</b>")
    for co, (p, t) in per_company.items():
        lines.append(f"  • {EMOJI.get(co,'🌐')} {co}: {p}/{t} passed")
    return "\n".join(lines)


def banner(text: str, emoji: str = "🚀") -> str:
    return f"{emoji} <b>{_esc(text)}</b> {emoji}"
