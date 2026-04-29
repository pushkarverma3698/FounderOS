"""
FounderOS — LinkedIn Analytics Feedback Loop
=============================================
Runs daily at 09:00 IST. Pulls engagement data on posts from 24-48h ago.
Writes performance insights back to social_mem so social_handler improves over time.
Also updates pipeline_db.linkedin_posts with fresh metrics.
"""
from __future__ import annotations
import json, logging
from datetime import datetime
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).parent.parent))

log = logging.getLogger("analytics_loop")


async def run_analytics_check() -> str:
    """
    Main entry point — called by scheduler daily at 09:00 IST.
    Returns a summary string.
    """
    try:
        from tools.tool_linkedin import LinkedInPoster         # type: ignore
        from memory.pipeline_db import get_leads, update_post_analytics  # type: ignore
        import chromadb

        chroma_path = str(Path(__file__).parent.parent / "memory" / "chroma_data")
        client = chromadb.PersistentClient(path=chroma_path)
        collection = client.get_or_create_collection("social_mem")
        poster = LinkedInPoster()

        # Query recent posts stored by social_handler
        results = collection.query(
            query_texts=["recent linkedin post url post_id"],
            n_results=10,
            where={"type": "posted"} if False else None,  # ChromaDB basic: no filter
        )

        insights: list[dict] = []
        docs = results.get("documents", [[]])[0]
        metas = results.get("metadatas", [[]])[0]

        for doc, meta in zip(docs, metas):
            if meta.get("type") not in ("posted", "linkedin_post"):
                continue
            post_id = meta.get("post_id", "")
            if not post_id or post_id.startswith("playwright_"):
                continue

            analytics = poster.get_post_analytics(post_id)
            if "error" in analytics:
                continue

            # Update pipeline_db
            update_post_analytics(
                post_id,
                impressions=analytics.get("impressions", 0),
                likes=analytics.get("likes", 0),
                comments=analytics.get("comments", 0),
                shares=analytics.get("shares", 0),
            )

            insights.append({
                "post_id":    post_id,
                "pillar":     meta.get("pillar", "UNKNOWN"),
                "impressions": analytics.get("impressions", 0),
                "likes":       analytics.get("likes", 0),
                "comments":    analytics.get("comments", 0),
                "posted_at":   meta.get("posted_at", ""),
            })

        if not insights:
            return "Analytics: no tracked posts found (likely new account)."

        best = max(insights, key=lambda x: x["impressions"])
        worst = min(insights, key=lambda x: x["impressions"])

        insight_text = f"""
ANALYTICS INSIGHT — {datetime.utcnow().strftime('%Y-%m-%d')}
Best pillar:  {best['pillar']} ({best['impressions']} impressions, {best['likes']} likes)
Worst pillar: {worst['pillar']} ({worst['impressions']} impressions)
All recent:
{json.dumps(insights, indent=2)}

RECOMMENDATION: Weight {best['pillar']} posts more heavily this week.
"""

        collection.add(
            documents=[insight_text],
            ids=[f"analytics_{datetime.utcnow().strftime('%Y%m%d')}"],
            metadatas=[{
                "type": "analytics_insight",
                "best_pillar": best["pillar"],
                "date": datetime.utcnow().isoformat(),
            }],
        )

        summary = (
            f"📊 Analytics complete:\n"
            f"Best: {best['pillar']} — {best['impressions']} impressions, {best['likes']} likes\n"
            f"Insight saved to social_mem."
        )
        log.info(summary)

        # Telegram alert
        try:
            import os, requests
            tok  = os.environ["TELEGRAM_BOT_TOKEN"]
            chat = os.environ["TELEGRAM_CHAT_ID"]
            topic = int(os.getenv("TOPIC_SOCIAL", 6))
            requests.post(f"https://api.telegram.org/bot{tok}/sendMessage", json={
                "chat_id": chat, "message_thread_id": topic,
                "text": summary, "parse_mode": "HTML",
            }, timeout=10)
        except Exception:
            pass

        return summary

    except Exception as e:
        log.error(f"Analytics loop error: {e}")
        return f"Analytics ERROR: {e}"


if __name__ == "__main__":
    import asyncio
    print(asyncio.run(run_analytics_check()))
