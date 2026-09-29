"""Heuristic DOM fallback: fills the GAPS in a field map we already trust.

It runs only after a hand-written map (adapters.py) has planned its fills, and
only for a field that map did not cover. It never decides on its own that an
unknown form is safe to touch, and it never fills a cover letter, a
work-authorisation answer or any other free-text question.

LABELS ARE ENGLISH AND DUTCH (A4, 2026-09-29). Most Dutch finance postings are
written in Dutch and so are their forms: "Voornaam", "E-mailadres",
"Telefoonnummer". A Dutch term and its English twin sit in the SAME field's
`terms` below, so both resolve to one field and nothing is filled twice ("cv"
is the same word in both languages and is listed once).

TWO RULES FOR EVERY TERM, both pinned by tests/test_resolver_labels.py:
  * no bare word that lives inside other labels. "naam" is inside voornaam,
    achternaam, bedrijfsnaam and gebruikersnaam, so it would type her full name
    into a company box. A term is specific enough to be a label on its own.
  * a label that matches no term stays unresolved. Unknown means the founder
    fills it by hand, never that we pick the nearest field.
"""

import json

#: How each field is recognised, most trusted first: the `autocomplete`
#: attribute (tier 1), the input `type` (tier 2), then words in the label,
#: placeholder, aria-label, name or id (tier 3). The tables are data so the
#: JavaScript below is generated from them and cannot drift from what the
#: tests read. Terms are lowercase: the page text is lowercased before matching.
FIELD_RULES = {
    "first_name": {"autocomplete": ["given-name"], "type": [], "terms": ["first name", "voornaam"]},
    "last_name": {"autocomplete": ["family-name"], "type": [], "terms": ["last name", "achternaam", "familienaam"]},
    "full_name": {
        "autocomplete": ["name"],
        "type": [],
        "terms": ["full name", "your name", "volledige naam", "uw naam", "je naam", "jouw naam"],
    },
    "email": {"autocomplete": ["email"], "type": ["email"], "terms": ["email", "e-mail", "mailadres"]},
    "phone": {"autocomplete": ["tel"], "type": ["tel"], "terms": ["phone", "mobile", "telefoon", "mobiel"]},
    "linkedin": {"autocomplete": ["url"], "type": ["url"], "terms": ["linkedin"]},
    "website": {"autocomplete": ["url"], "type": ["url"], "terms": ["website", "portfolio"]},
    "resume": {"autocomplete": [], "type": ["file"], "terms": ["resume", "cv", "curriculum vitae"]},
    # Recognised, never filled: it exists so a cover-letter upload is not
    # mistaken for the resume box (any `type=file` input is a resume candidate).
    "cover_letter": {
        "autocomplete": [],
        "type": [],
        "terms": [
            "cover letter", "motivation letter", "motivational letter",
            "motivatiebrief", "begeleidende brief", "sollicitatiebrief",
        ],
    },
}

_RESOLVER_JS_TEMPLATE = """
(() => {
  const DENY_TERMS = ['visa', 'sponsor', 'salary', 'notice', 'gender', 'race', 'ethnicity', 'disability', 'veteran', 'authorisation', 'authorization'];
  
  function getElementText(el) {
    if (!el) return '';
    let text = (el.innerText || el.textContent || '').toLowerCase();
    if (el.placeholder) text += ' ' + el.placeholder.toLowerCase();
    if (el.getAttribute('aria-label')) text += ' ' + el.getAttribute('aria-label').toLowerCase();
    if (el.name) text += ' ' + el.name.toLowerCase();
    if (el.id) text += ' ' + el.id.toLowerCase();
    return text;
  }

  function isDenied(el, labelEl) {
    const text = getElementText(el) + ' ' + getElementText(labelEl);
    return DENY_TERMS.some(term => text.includes(term));
  }

  const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea'));
  
  const results = {};
  const fields = __FIELD_RULES__;

  // An upload that only says "cover letter" is not the resume box, whatever its
  // type. One that names the CV as well ("CV en motivatiebrief") still is.
  function isCoverLetterOnly(text) {
    return fields.cover_letter.terms.some(term => text.includes(term))
      && !fields.resume.terms.some(term => text.includes(term));
  }

  for (const [key, rules] of Object.entries(fields)) {
    let bestCandidates = [];
    let bestTier = 99;

    for (const el of inputs) {
      if (!el.offsetParent) continue; // invisible
      
      const labelEl = el.id ? document.querySelector(`label[for="${el.id}"]`) : el.closest('label');
      if (isDenied(el, labelEl)) continue;

      const text = getElementText(el) + ' ' + getElementText(labelEl);
      if (key === 'resume' && isCoverLetterOnly(text)) continue;

      let tier = 99;
      if (rules.autocomplete.includes(el.autocomplete)) {
        tier = 1;
      } else if (rules.type.includes(el.type)) {
        tier = 2;
      } else if (rules.terms.some(term => text.includes(term))) {
        tier = 3;
      }

      if (tier < bestTier) {
        bestTier = tier;
        bestCandidates = [el];
      } else if (tier === bestTier && tier < 99) {
        bestCandidates.push(el);
      }
    }

    if (bestCandidates.length === 1) {
      const el = bestCandidates[0];
      if (!el.dataset.founderosId) {
        el.dataset.founderosId = 'fo-' + Math.random().toString(36).substr(2, 9);
      }
      results[key] = `[data-founderos-id="${el.dataset.founderosId}"]`;
    }
  }

  return results;
})();
"""

RESOLVER_JS = _RESOLVER_JS_TEMPLATE.replace("__FIELD_RULES__", json.dumps(FIELD_RULES))

async def resolve_fallback_fields(page, profile, existing_plan):
    """
    Run JS to heuristically map unknown fields and return additional plans.
    """
    # Keys we already planned to fill via hand-written adapters
    covered_keys = {p[0] for p in existing_plan}
    
    # Evaluate resolver JS
    resolved = await page.evaluate(RESOLVER_JS)
    
    fallback_plan = []
    
    # Map the resolved selectors back to the profile data
    if "first name" not in covered_keys and "name" not in covered_keys:
        if resolved.get("first_name"):
            fallback_plan.append(("first name", (resolved["first_name"],), profile.first_name))
        if resolved.get("last_name"):
            fallback_plan.append(("last name", (resolved["last_name"],), profile.last_name))
        if not resolved.get("first_name") and resolved.get("full_name"):
            fallback_plan.append(("name", (resolved["full_name"],), f"{profile.first_name} {profile.last_name}"))
            
    if "email" not in covered_keys and resolved.get("email"):
        fallback_plan.append(("email", (resolved["email"],), profile.email))
        
    if "phone" not in covered_keys and resolved.get("phone"):
        fallback_plan.append(("phone", (resolved["phone"],), profile.phone))
        
    if "linkedin" not in covered_keys and resolved.get("linkedin") and getattr(profile, "linkedin", None):
        fallback_plan.append(("linkedin", (resolved["linkedin"],), profile.linkedin))
        
    if "website" not in covered_keys and resolved.get("website") and getattr(profile, "website", None):
        fallback_plan.append(("website", (resolved["website"],), profile.website))
        
    # The resume upload logic is handled separately in apply.py, but we can pass the selector
    resume_selector = resolved.get("resume")
    
    return fallback_plan, resume_selector
