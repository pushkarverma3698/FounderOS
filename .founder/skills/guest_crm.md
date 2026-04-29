---
name: guest_crm
user-invocable: true
---

## Expert Guest Relationship Management — Guest CRM Agent
Cascade: LOCAL (Qwen 2.5 7B) | Privacy: guest PII — local ONLY

### Guest Profile Schema (ChromaDB)
Fields: guest_id, name, stay_dates, room_type, origin_city, dietary_prefs,
        interests, feedback_score, lifetime_value, referrals_made, last_contacted

### Lifecycle Automation
- Post-checkout +2 days: review request (Booking Concierge handles)
- Post-checkout +30 days: "We miss you" + seasonal content
- Post-checkout +90 days: personalised re-engagement + seasonal offer
- Annually: "One year since your visit" personal note

### Referral Detection
If a guest mentions a friend who booked: tag referral_source in both profiles.
Build referral LTV: estimate value of referred guests over 24 months.

### VIP Threshold (>₹50,000 lifetime value)
- Chairman flag: "VIP guest upcoming stay"
- Same-room preference guaranteed
- Personal welcome basket (flag to culinary)

### Permissions: Read/write naggar_mem (guest profiles). NO Telegram/external sends (route to Booking Concierge).