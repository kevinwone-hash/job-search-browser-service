/**
 * Discovery query configuration — MVI hardcoded set.
 *
 * Decision 45: These query strings are governance data and must be migrated to
 * the job-search-os cognitive DB before Sprint 1 is declared complete, so they
 * can be updated without a code deploy and reconciled against Decision 40
 * (Targeting Doctrine) on each change.
 *
 * Query design rationale (approved 2026-05-27):
 * - Healthcare vertical first (Decision 40 healthcare/B2C-first doctrine)
 * - Performance/digital/growth marketing specialization — Kevin's core SME
 * - NO geography suffix: geography filtering belongs in the evaluation layer
 *   (_location_eligible in extraction.py), NOT at discovery search time.
 *   Remote vs. hybrid vs. onsite eligibility is determined post-extraction.
 * - No "VP Marketing" or "Director Marketing" broad queries — avoids brand/
 *   creative/agency management noise that is outside Kevin's SME.
 *
 * Decision 46 rate limits are enforced in google-jobs-runner.ts.
 */

/** Approved MVI query strings. */
export const DISCOVERY_QUERIES: readonly string[] = [
  "VP Growth Marketing healthcare",
  "VP Performance Marketing healthcare",
  "Director Performance Marketing healthcare",
  "VP Digital Marketing healthcare",
  "Head of Growth healthcare",
];

/** Construct the Google Jobs SERP URL for a given query. */
export const googleJobsUrl = (query: string): string =>
  `https://www.google.com/search?q=${encodeURIComponent(query)}&ibp=htl;jobs`;

/**
 * Title-level pre-filter keywords.
 * A discovered job must contain at least one of these (case-insensitive substring)
 * in its title to pass the browser-side filter. Reduces ingest noise before
 * the more expensive extraction/evaluation step.
 *
 * Intentionally conservative — we catch VP, Director, Head of, SVP, EVP,
 * Senior Director. CMO is explicitly excluded (Decision in memory:
 * CMO = primary outreach audience, NOT a role Kevin applies for).
 */
export const TITLE_KEYWORDS: readonly string[] = [
  "vp",
  "vice president",
  "director",
  "head of",
  "svp",
  "evp",
  "senior director",
  "principal",
];

// ---------------------------------------------------------------------------
// Decision 46 rate limits
// ---------------------------------------------------------------------------

/** Maximum job cards to collect per query (Decision 46). */
export const MAX_CARDS_PER_QUERY = 20;

/**
 * Minimum delay between queries in milliseconds (Decision 46: min 2s).
 * Applied before each query navigation to avoid hammering Google.
 */
export const MIN_INTER_QUERY_DELAY_MS = 2500;

/**
 * Settle time after page navigation before DOM/JSON-LD extraction.
 * Google Jobs is a client-rendered SPA — give it time to hydrate.
 */
export const PAGE_SETTLE_MS = 3000;
