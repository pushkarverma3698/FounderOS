/**
 * FounderOS — Default Capability Mappings
 * =========================================
 * Maps logical capability identifiers to concrete tool IDs registered in the
 * ToolRegistry. Each worker contract references capabilities; the resolver
 * uses these mappings to produce the scoped tool manifest.
 *
 * Tool IDs here must match names in src/agents/capabilities.ts or
 * src/tools/registry/init.ts. Unmapped capabilities are not an error —
 * they represent future tools not yet registered.
 */

/**
 * Career-domain capability mappings.
 * Used by: career_operator, job_application_operator (future).
 */
export const CAREER_CAPABILITY_MAPPINGS: Record<string, string[]> = {
  "career.discovery": ["search_jobs", "search_web", "ingest_jobs"],
  "career.research": ["search_web", "scrape_url", "deep_research", "search_memory", "search_knowledge"],
  "career.contacts": ["search_web", "search_memory"],
  "career.outreach": ["send_email"],
  "career.applications": ["read_cv", "cv_gaps", "screen_job", "review_screened", "tailor_cv_for_row", "job_brief"],
  "professional_presence": ["linkedin_post", "linkedin_analytics", "linkedin_get_my_posts"],
};

/**
 * Research-domain capability mappings.
 * Used by: research_operator (future).
 */
export const RESEARCH_CAPABILITY_MAPPINGS: Record<string, string[]> = {
  "research.web": ["search_web", "scrape_url", "deep_research", "crawl_site"],
  "research.knowledge": ["search_knowledge", "search_turicks_brain"],
  "research.memory": ["search_memory", "record_event"],
};

/**
 * Sales-domain capability mappings.
 * Used by: sales_operator (future).
 */
export const SALES_CAPABILITY_MAPPINGS: Record<string, string[]> = {
  "sales.prospecting": ["search_web", "scan_ai_visibility", "get_gap_scans"],
  "sales.outreach": ["send_email"],
  "sales.knowledge": ["search_knowledge"],
};

/**
 * Social/content-domain capability mappings.
 * Used by: instagram_operator, seo_operator (future).
 */
export const SOCIAL_CAPABILITY_MAPPINGS: Record<string, string[]> = {
  "social.linkedin": ["linkedin_post", "linkedin_analytics", "linkedin_get_my_posts", "linkedin_read_comments", "draft_linkedin_reply", "draft_connection_note"],
  "social.scheduling": ["schedule_social_post", "list_scheduled_posts"],
  "social.creative": ["generate_image", "list_brand_assets"],
};

/** All default mappings merged. Order does not matter — mappings are keyed. */
export const DEFAULT_CAPABILITY_MAPPINGS: Record<string, string[]> = {
  ...CAREER_CAPABILITY_MAPPINGS,
  ...RESEARCH_CAPABILITY_MAPPINGS,
  ...SALES_CAPABILITY_MAPPINGS,
  ...SOCIAL_CAPABILITY_MAPPINGS,
};
