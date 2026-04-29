"""
FounderOS — JobOS V3: Lead Monitoring Agent
============================================
Scans a configured mailbox for interview invitations and application updates.
Triggered by APScheduler. Logs findings to leads.db and alerts Telegram.
"""

import imaplib
import email
import sqlite3
import os
import logging
from datetime import datetime
from core.config import TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID

# Configuration (Add these to .env)
IMAP_SERVER = os.getenv("IMAP_SERVER", "imap.gmail.com")
IMAP_USER = os.getenv("IMAP_USER", "")
IMAP_PASS = os.getenv("IMAP_PASS", "")  # Use App Password
TOPIC_JOB_OS = int(os.getenv("TOPIC_JOB_OS", "0"))

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("LeadTracker")

DB_PATH = os.path.join(os.path.dirname(__file__), "leads.db")

def init_db():
    """Initializes the job funnel database."""
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS leads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company TEXT,
            status TEXT, -- 'Applied', 'Interview', 'Offer', 'Rejected'
            last_update TIMESTAMP,
            subject TEXT,
            snippet TEXT
        )
    ''')
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS conversation_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            lead_id INTEGER,
            timestamp TIMESTAMP,
            sender TEXT, -- 'Pushkar', 'Recruiter'
            message TEXT,
            FOREIGN KEY(lead_id) REFERENCES leads(id)
        )
    ''')
    conn.commit()
    conn.close()

def scan_mailbox():
    """Scans for lead-related emails."""
    if not IMAP_USER or not IMAP_PASS:
        log.warning("IMAP credentials missing. Skipping scan.")
        return []

    try:
        mail = imaplib.IMAP4_SSL(IMAP_SERVER)
        mail.login(IMAP_USER, IMAP_PASS)
        mail.select("inbox")

        # Search for common interview/update keywords
        # 2025/2026 common triggers: "Interview", "Invitation", "Next steps", "Schedule"
        type, data = mail.search(None, '(OR SUBJECT "Interview" (OR SUBJECT "Invitation" SUBJECT "Next steps"))')
        
        mail_ids = data[0].split()
        new_leads = []

        for m_id in mail_ids[-5:]:  # Check last 5 relevant emails
            typ, m_data = mail.fetch(m_id, '(RFC822)')
            msg = email.message_from_bytes(m_data[0][1])
            subject = msg['subject']
            sender = msg['from']
            date_str = msg['date']
            
            # Simple check if already processed (could be improved with UID tracking)
            if is_new_lead(subject, sender):
                log.info(f"🎯 NEW LEAD DETECTED: {subject} from {sender}")
                lead_info = {
                    "company": extract_company(sender, subject),
                    "status": "Interview",
                    "subject": subject,
                    "date": date_str
                }
                save_lead(lead_info)
                new_leads.append(lead_info)

        mail.logout()
        return new_leads

    except Exception as e:
        log.error(f"Mail scan failed: {e}")
        return []

def extract_company(sender, subject):
    """Simple heuristic to extract company name."""
    if "@" in sender:
        domain = sender.split("@")[1].split(".")[0]
        return domain.capitalize()
    return "Unknown"

def is_new_lead(subject, sender):
    """Check if we've already logged this subject/sender combo."""
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("SELECT id FROM leads WHERE subject = ? AND company LIKE ?", (subject, f"%{extract_company(sender, subject)}%"))
    exists = cursor.fetchone()
    conn.close()
    return not exists

def save_lead(info):
    """Persists lead to SQLite."""
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute('''
        INSERT INTO leads (company, status, last_update, subject)
        VALUES (?, ?, ?, ?)
    ''', (info['company'], info['status'], datetime.now(), info['subject']))
    conn.commit()
    conn.close()

def run_lead_check():
    """Main entry point for cron."""
    init_db()
    leads = scan_mailbox()
    if leads:
        # Trigger Telegram Alert (Mocked for now or import from telegram_gateway)
        log.info(f"Action: Alert Pushkar about {len(leads)} new leads.")
        # In production: await notify_telegram(leads)

if __name__ == "__main__":
    run_lead_check()
