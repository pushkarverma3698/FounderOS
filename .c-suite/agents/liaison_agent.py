"""
FounderOS — JobOS V4: Relationship Liaison Agent
=================================================
Manages ongoing conversations with recruiters and hiring managers.
Maintains thread history and pulls contextual research to draft replies.
"""

import sys
import os
import sqlite3
import logging
from datetime import datetime
from core.config import call_md, call_ceo
from memory.memory import chat_mem, career_mem, store, recall

log = logging.getLogger("LiaisonAgent")
DB_PATH = os.path.join(os.path.dirname(__file__), "leads.db")

class LiaisonAgent:
    def __init__(self, use_assistant_persona=True):
        self.persona = "Pushkar's Executive AI Assistant" if use_assistant_persona else "Pushkar Verma"

    def ingest_message(self, lead_id: int, sender: str, text: str):
        """Logs a new message to history and stores in vector memory."""
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute('''
            INSERT INTO conversation_history (lead_id, timestamp, sender, message)
            VALUES (?, ?, ?, ?)
        ''', (lead_id, datetime.now(), sender, text))
        conn.commit()
        conn.close()
        
        # Also store in vector memory for long-term pattern matching
        store(chat_mem, f"msg_{lead_id}_{datetime.now().timestamp()}", 
              f"[{sender}]: {text}", {"lead_id": lead_id, "sender": sender})

    def get_thread_history(self, lead_id: int, limit: int = 10):
        """Retrieves the last N messages for this lead."""
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute('''
            SELECT sender, message FROM conversation_history 
            WHERE lead_id = ? ORDER BY timestamp DESC LIMIT ?
        ''', (lead_id, limit))
        rows = cursor.fetchall()
        conn.close()
        return "\n".join([f"{r[0]}: {r[1]}" for r in reversed(rows)])

    def draft_reply(self, lead_id: int, incoming_message: str):
        """
        Generates a contextual reply.
        Inputs: Role/Company Context + Thread History + New Message.
        """
        # 1. Get Lead Details
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute("SELECT company, subject FROM leads WHERE id = ?", (lead_id,))
        lead_row = cursor.fetchone()
        conn.close()
        
        company = lead_row[0] if lead_row else "Unknown"
        
        # 2. Get Thread History
        history = self.get_thread_history(lead_id)
        
        # 3. Recall relevant career context (Research done during JobOS V3 phases)
        career_context = recall(career_mem, f"{company} interview prep", n_results=1)
        
        prompt = f"""You are acting as {self.persona}.
        
        CONTEXT FOR THIS RELATIONSHIP:
        - Company: {company}
        - Research: {career_context}
        
        CONVERSATION HISTORY:
        {history}
        
        NEW MESSAGE FROM RECRUITER:
        {incoming_message}
        
        TASK:
        Draft a high-signal, professional, and warm reply. 
        - If 'Assistant': Be helpful, professional, and efficient.
        - If 'Pushkar': Be technical, authoritative, and visionary.
        - Ensure we answer any specific questions asked in the new message.
        - Reference a detail from the 'Research' context if it adds value.
        
        Return ONLY the reply text.
        """
        
        reply = call_md(prompt)
        return reply

if __name__ == "__main__":
    # Test Script
    agent = LiaisonAgent()
    # Assume lead_id 1 exists
    # agent.ingest_message(1, "Recruiter", "Hi Pushkar, loved the resume. Can you chat on Tuesday?")
    # print(agent.draft_reply(1, "Can you chat on Tuesday?"))
    pass
