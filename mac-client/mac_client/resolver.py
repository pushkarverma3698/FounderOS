import json

RESOLVER_JS = """
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
  const fields = {
    first_name: { autocomplete: ['given-name'], type: [], terms: ['first name'] },
    last_name: { autocomplete: ['family-name'], type: [], terms: ['last name'] },
    full_name: { autocomplete: ['name'], type: [], terms: ['full name', 'your name'] },
    email: { autocomplete: ['email'], type: ['email'], terms: ['email'] },
    phone: { autocomplete: ['tel'], type: ['tel'], terms: ['phone', 'mobile'] },
    linkedin: { autocomplete: ['url'], type: ['url'], terms: ['linkedin'] },
    website: { autocomplete: ['url'], type: ['url'], terms: ['website', 'portfolio'] },
    resume: { autocomplete: [], type: ['file'], terms: ['resume', 'cv'] }
  };

  for (const [key, rules] of Object.entries(fields)) {
    let bestCandidates = [];
    let bestTier = 99;

    for (const el of inputs) {
      if (!el.offsetParent) continue; // invisible
      
      const labelEl = el.id ? document.querySelector(`label[for="${el.id}"]`) : el.closest('label');
      if (isDenied(el, labelEl)) continue;

      let tier = 99;
      if (rules.autocomplete.includes(el.autocomplete)) {
        tier = 1;
      } else if (rules.type.includes(el.type)) {
        tier = 2;
      } else {
        const text = getElementText(el) + ' ' + getElementText(labelEl);
        if (rules.terms.some(term => text.includes(term))) {
          tier = 3;
        }
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
