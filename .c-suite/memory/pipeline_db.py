"""
FounderOS — Lead & Revenue Pipeline Database
=============================================
SQLite-backed CRM for Turicks client acquisition.
Tracks leads → proposals → revenue with source attribution.

Tables:
  leads       — contacts from LinkedIn, Upwork, cold email, referral
  proposals   — bids and proposals with status
  linkedin_posts — posts with engagement metrics
  revenue     — closed deals and payments

Usage:
    from memory.pipeline_db import (
        init_pipeline_db, add_lead, update_lead_status,
        get_pipeline_summary, log_linkedin_post, add_revenue
    )
"""
from __future__ import annotations
import sqlite3
import json
from datetime import datetime
from pathlib import Path

DB_PATH = Path(__file__).parent / "pipeline.db"


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(str(DB_PATH))
    c.row_factory = sqlite3.Row
    return c


def init_pipeline_db() -> None:
    """Create all tables if they don't exist. Safe to call multiple times."""
    with _conn() as con:
        con.executescript("""
        CREATE TABLE IF NOT EXISTS leads (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            name                TEXT    NOT NULL,
            company             TEXT,
            linkedin_url        TEXT,
            email               TEXT,
            source              TEXT    NOT NULL,   -- linkedin_post | upwork | cold_email | referral | meetup
            status              TEXT    DEFAULT 'contacted',
            -- contacted | replied | call_booked | proposal_sent | closed_won | closed_lost
            potential_value_usd REAL    DEFAULT 0,
            notes               TEXT    DEFAULT '',
            created_at          TEXT    NOT NULL,
            updated_at          TEXT    NOT NULL
        );

        CREATE TABLE IF NOT EXISTS proposals (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            lead_id         INTEGER REFERENCES leads(id),
            platform        TEXT,           -- upwork | email | linkedin
            job_title       TEXT,
            proposal_text   TEXT,
            bid_amount_usd  REAL,
            status          TEXT DEFAULT 'sent',  -- sent | viewed | accepted | rejected
            external_id     TEXT,           -- upwork proposal_id, etc.
            submitted_at    TEXT,
            responded_at    TEXT
        );

        CREATE TABLE IF NOT EXISTS linkedin_posts (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            post_id             TEXT UNIQUE,
            url                 TEXT,
            pillar              TEXT,           -- BUILD_LOG | FOUNDER_STORY | AI_EDUCATION | REVENUE | AMSTERDAM
            content_preview     TEXT,
            impressions         INTEGER DEFAULT 0,
            likes               INTEGER DEFAULT 0,
            comments            INTEGER DEFAULT 0,
            shares              INTEGER DEFAULT 0,
            leads_generated     INTEGER DEFAULT 0,
            posted_at           TEXT,
            analytics_updated_at TEXT
        );

        CREATE TABLE IF NOT EXISTS revenue (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            lead_id     INTEGER REFERENCES leads(id),
            description TEXT,
            amount_usd  REAL    NOT NULL,
            currency    TEXT    DEFAULT 'USD',
            type        TEXT,   -- agency | template | retainer | course | gumroad
            received_at TEXT    NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_leads_status  ON leads(status);
        CREATE INDEX IF NOT EXISTS idx_leads_source  ON leads(source);
        CREATE INDEX IF NOT EXISTS idx_posts_pillar  ON linkedin_posts(pillar);
        """)
    print(f"✅  Pipeline DB ready: {DB_PATH}")


# ─────────────────────────────────────────────
# Leads
# ─────────────────────────────────────────────
def add_lead(
    name: str,
    company: str = "",
    source: str = "unknown",
    linkedin_url: str = "",
    email: str = "",
    notes: str = "",
    potential_value_usd: float = 0.0,
) -> int:
    now = datetime.utcnow().isoformat()
    with _conn() as con:
        cur = con.execute(
            """INSERT INTO leads
               (name, company, linkedin_url, email, source, notes, potential_value_usd, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (name, company, linkedin_url, email, source, notes, potential_value_usd, now, now),
        )
        return cur.lastrowid


def update_lead_status(lead_id: int, status: str, notes: str = "") -> None:
    now = datetime.utcnow().isoformat()
    with _conn() as con:
        con.execute(
            "UPDATE leads SET status=?, updated_at=?, notes=notes||? WHERE id=?",
            (status, now, f"\n[{now[:10]}] {notes}" if notes else "", lead_id),
        )


def get_leads(status: str | None = None, limit: int = 50) -> list[dict]:
    with _conn() as con:
        if status:
            rows = con.execute(
                "SELECT * FROM leads WHERE status=? ORDER BY updated_at DESC LIMIT ?",
                (status, limit),
            ).fetchall()
        else:
            rows = con.execute(
                "SELECT * FROM leads ORDER BY updated_at DESC LIMIT ?", (limit,)
            ).fetchall()
    return [dict(r) for r in rows]


# ─────────────────────────────────────────────
# Proposals
# ─────────────────────────────────────────────
def add_proposal(
    lead_id: int | None,
    platform: str,
    job_title: str,
    proposal_text: str,
    bid_amount_usd: float,
    external_id: str = "",
) -> int:
    now = datetime.utcnow().isoformat()
    with _conn() as con:
        cur = con.execute(
            """INSERT INTO proposals
               (lead_id, platform, job_title, proposal_text, bid_amount_usd, external_id, submitted_at)
               VALUES (?,?,?,?,?,?,?)""",
            (lead_id, platform, job_title, proposal_text, bid_amount_usd, external_id, now),
        )
        return cur.lastrowid


# ─────────────────────────────────────────────
# LinkedIn posts
# ─────────────────────────────────────────────
def log_linkedin_post(
    post_id: str,
    url: str,
    pillar: str,
    content_preview: str,
) -> int:
    now = datetime.utcnow().isoformat()
    with _conn() as con:
        try:
            cur = con.execute(
                """INSERT INTO linkedin_posts (post_id, url, pillar, content_preview, posted_at)
                   VALUES (?,?,?,?,?)""",
                (post_id, url, pillar, content_preview[:300], now),
            )
            return cur.lastrowid
        except sqlite3.IntegrityError:
            return -1  # duplicate


def update_post_analytics(post_id: str, impressions: int, likes: int,
                           comments: int, shares: int = 0) -> None:
    now = datetime.utcnow().isoformat()
    with _conn() as con:
        con.execute(
            """UPDATE linkedin_posts
               SET impressions=?, likes=?, comments=?, shares=?, analytics_updated_at=?
               WHERE post_id=?""",
            (impressions, likes, comments, shares, now, post_id),
        )


# ─────────────────────────────────────────────
# Revenue
# ─────────────────────────────────────────────
def add_revenue(
    amount_usd: float,
    description: str,
    type_: str = "agency",
    lead_id: int | None = None,
) -> int:
    now = datetime.utcnow().isoformat()
    with _conn() as con:
        cur = con.execute(
            """INSERT INTO revenue (lead_id, description, amount_usd, type, received_at)
               VALUES (?,?,?,?,?)""",
            (lead_id, description, amount_usd, type_, now),
        )
        return cur.lastrowid


# ─────────────────────────────────────────────
# Pipeline summary (used by pipeline_md agent)
# ─────────────────────────────────────────────
def get_pipeline_summary() -> dict:
    with _conn() as con:
        by_status = {}
        for row in con.execute(
            "SELECT status, COUNT(*) as n, SUM(potential_value_usd) as val FROM leads GROUP BY status"
        ):
            by_status[row["status"]] = {"count": row["n"], "value": round(row["val"] or 0, 2)}

        mtd = con.execute(
            "SELECT COALESCE(SUM(amount_usd),0) FROM revenue WHERE received_at >= date('now','start of month')"
        ).fetchone()[0]

        proposals_week = con.execute(
            "SELECT COUNT(*) FROM proposals WHERE submitted_at >= date('now','-7 days')"
        ).fetchone()[0]

        posts_week = con.execute(
            "SELECT COUNT(*), COALESCE(MAX(impressions),0) FROM linkedin_posts WHERE posted_at >= date('now','-7 days')"
        ).fetchone()

        top_source = con.execute(
            "SELECT source, COUNT(*) as n FROM leads GROUP BY source ORDER BY n DESC LIMIT 1"
        ).fetchone()

    total_pipeline_value = sum(v["value"] for v in by_status.values())
    total_leads = sum(v["count"] for v in by_status.values())

    return {
        "pipeline_by_status":     by_status,
        "total_leads":            total_leads,
        "total_pipeline_usd":     round(total_pipeline_value, 2),
        "mtd_revenue_usd":        round(mtd, 2),
        "proposals_this_week":    proposals_week,
        "posts_this_week":        posts_week[0],
        "max_post_impressions":   posts_week[1],
        "top_lead_source":        top_source["source"] if top_source else "N/A",
        "generated_at":           datetime.utcnow().isoformat(),
    }


def get_summary_text() -> str:
    """Human-readable pipeline summary for agent use."""
    s = get_pipeline_summary()
    lines = [
        f"📊 PIPELINE SUMMARY — {s['generated_at'][:10]}",
        f"",
        f"💰 MTD Revenue:       ${s['mtd_revenue_usd']:,.0f}",
        f"🎯 Total Leads:       {s['total_leads']} (${s['total_pipeline_usd']:,.0f} pipeline)",
        f"",
        f"Lead stages:",
    ]
    stage_icons = {
        "contacted": "📨", "replied": "💬", "call_booked": "📅",
        "proposal_sent": "📄", "closed_won": "✅", "closed_lost": "❌",
    }
    for status, data in s["pipeline_by_status"].items():
        icon = stage_icons.get(status, "•")
        lines.append(f"  {icon} {status:<18} {data['count']:>3}  (${data['value']:,.0f})")
    lines += [
        f"",
        f"📝 This week:",
        f"  Posts:      {s['posts_this_week']} | Best: {s['max_post_impressions']} impressions",
        f"  Proposals:  {s['proposals_this_week']}",
        f"  Top source: {s['top_lead_source']}",
    ]
    return "\n".join(lines)


if __name__ == "__main__":
    init_pipeline_db()
    print("\nSample summary:")
    print(get_summary_text())
