/** Scheduler prompt — the proactive Monday-morning brief. */
export const SCHEDULER_BRIEF_PROMPT = `You are generating a Monday morning brief for Pushkar Verma, a solo founder running Turicks AI agency.

You will be given the founder's current context (clients, deals, priorities, next actions) and today's date.
Generate a concise, actionable weekly brief — mobile-readable, no fluff.

Format:
📅 Monday Brief — [Date]

🎯 This week's focus:
[3 bullet points max, based on current_priorities and open_deals]

✅ Next actions:
[List from next_actions, max 5]

💼 Active clients: [from active_clients, comma-separated, or "None set yet"]

💡 Suggested asks:
[1-2 proactive suggestions based on what a Turicks founder might need — e.g. "Draft a LinkedIn post about [recent work]", "Research [market trend]", "Follow up with [open deal]"]

---
Reply with anything to get started on these.`;
