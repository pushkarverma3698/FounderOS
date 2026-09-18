export interface FieldMap {
  first_name?: string[];
  last_name?: string[];
  full_name?: string[];
  email?: string[];
  phone?: string[];
  linkedin?: string[];
  website?: string[];
  resume?: string[];
}

export const GREENHOUSE: FieldMap = {
  first_name: ["#first_name", 'input[name="job_application[first_name]"]', 'input[autocomplete="given-name"]'],
  last_name: ["#last_name", 'input[name="job_application[last_name]"]', 'input[autocomplete="family-name"]'],
  email: ["#email", 'input[name="job_application[email]"]', 'input[type="email"]'],
  phone: ["#phone", 'input[name="job_application[phone]"]', 'input[type="tel"]'],
  linkedin: ['input[aria-label="LinkedIn Profile"]', 'input[name*="linkedin"]', 'input[id*="linkedin"]', 'input[aria-label*="LinkedIn" i]', 'input[placeholder*="LinkedIn" i]'],
  website: ['input[aria-label="Website"]', 'input[name*="website"]', 'input[id*="website"]', 'input[aria-label*="Website" i]', 'input[placeholder*="Website" i]'],
  resume: ['#resume', 'input[id="resume"]', 'input[type="file"]'],
};

export const LEVER: FieldMap = {
  full_name: ['input[name="name"]', "#name"],
  email: ['input[name="email"]', "#email", 'input[type="email"]'],
  phone: ['input[name="phone"]', "#phone", 'input[type="tel"]'],
  linkedin: ['input[name="urls[LinkedIn]"]', 'input[name*="linkedin"]'],
  website: ['input[name="urls[Portfolio]"]', 'input[name="urls[Other]"]'],
  resume: ['input[name="resume"]', 'input[type="file"]'],
};

export const ASHBY: FieldMap = {
  first_name: ['input[name="_systemfield_name.first"]'],
  last_name: ['input[name="_systemfield_name.last"]'],
  full_name: ['input[name="_systemfield_name"]', 'input[aria-label="Name"]'],
  email: ['input[name="_systemfield_email"]', 'input[type="email"]'],
  phone: ['input[name="_systemfield_phone"]', 'input[type="tel"]'],
  linkedin: ['input[name*="linkedin"]', 'input[aria-label*="LinkedIn"]'],
  website: ['input[name*="website"]', 'input[aria-label*="Website"]'],
  resume: ['input[type="file"]'],
};

export const WORKABLE: FieldMap = {
  first_name: ["#firstname"],
  last_name: ["#lastname"],
  email: ["#email", 'input[type="email"]'],
  phone: ['input[name="phone"]', 'input[type="tel"]'],
  resume: ['input[name="resume"]', 'input[type="file"]'],
};

export const RECRUITEE: FieldMap = {
  full_name: ['input[name="candidate.name"]'],
  email: ['input[name="candidate.email"]', 'input[type="email"]'],
  phone: ['input[name="candidate.phone"]', 'input[type="tel"]'],
  resume: ['input[name="candidate.cv"]', 'input[type="file"]'],
};

const _HOST_MARKERS = [
  { ats: "greenhouse", markers: ["greenhouse.io", "boards.greenhouse.io", "job-boards.greenhouse.io"] },
  { ats: "lever", markers: ["lever.co", "jobs.lever.co"] },
  { ats: "ashby", markers: ["ashbyhq.com", "jobs.ashbyhq.com"] },
  { ats: "workable", markers: ["workable.com", "apply.workable.com"] },
  { ats: "recruitee", markers: ["recruitee.com"] },
] as const;

export function atsForUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const lowered = url.toLowerCase();
  for (const { ats, markers } of _HOST_MARKERS) {
    if (markers.some((marker) => lowered.includes(marker))) {
      return ats;
    }
  }
  return null;
}

export function fieldMapFor(url: string): FieldMap | null {
  const ats = atsForUrl(url);
  switch (ats) {
    case "greenhouse": return GREENHOUSE;
    case "lever": return LEVER;
    case "ashby": return ASHBY;
    case "workable": return WORKABLE;
    case "recruitee": return RECRUITEE;
    default: return null;
  }
}

export function resolveApplicationUrl(url: string, ats: string | null): string {
  if (ats === "ashby") {
    const urlObj = new URL(url);
    let path = urlObj.pathname.replace(/\/$/, "");
    if (!path.endsWith("/application")) {
      urlObj.pathname = `${path}/application`;
    }
    return urlObj.toString();
  }
  if (ats === "workable") {
    const urlObj = new URL(url);
    let path = urlObj.pathname.replace(/\/$/, "");
    if (!path.endsWith("/apply")) {
      urlObj.pathname = `${path}/apply/`;
    }
    return urlObj.toString();
  }
  return url;
}
