/**
 * Types for the Google Jobs browser discovery module.
 *
 * Discovery is architecturally separate from ATS adapters — it reads and
 * reports jobs rather than filling forms. These types do NOT extend ATSAdapter
 * or RunContext; discovery has its own lifecycle.
 *
 * Decision 44: browser-native discovery via Browserbase/Playwright.
 * Decision 46: rate limits enforced in google-jobs-runner.ts.
 */

/** A single job surfaced during a Google Jobs browser session. */
export interface DiscoveredJob {
  /** Job title as extracted from Google Jobs. */
  title: string;
  /** Hiring company name. */
  company: string;
  /** Location string, or null if not found. */
  location: string | null;
  /**
   * Remote flag derived from JSON-LD jobLocationType field.
   * null means not determinable from discovery metadata — evaluation layer
   * (extraction.py / _location_eligible) is authoritative for eligibility.
   */
  remote: boolean | null;
  /**
   * URL as extracted from Google Jobs. May be a google.com/search URL,
   * an ATS URL, or an aggregator redirect URL.
   * job-search-os /ingest/discovery runs aggregator_resolver to upgrade
   * LOW/NONE confidence URLs to HIGH/MEDIUM ATS URLs server-side.
   */
  rawUrl: string;
  /**
   * Job description text if available from JSON-LD embeds.
   * Populated from schema.org/JobPosting description field.
   * null for DOM-extracted jobs where description is not in the card.
   */
  description: string | null;
  /** The query string that surfaced this job. */
  discoveryQuery: string;
  /** Whether this job was extracted from JSON-LD (primary) or DOM (fallback). */
  extractionMethod: "json_ld" | "dom";
}

/** Results for a single query within a discovery run. */
export interface DiscoveryQueryResult {
  query: string;
  /** Total job cards seen before title filter. */
  jobsSeen: number;
  /** Cards that passed the title keyword filter. */
  jobsTitleMatched: number;
  /** Cards that failed the title keyword filter. */
  jobsTitleDropped: number;
  /** Jobs that passed the filter — included in the ingest POST. */
  matchedJobs: DiscoveredJob[];
  /** Per-query error strings (non-fatal — run continues after query errors). */
  errors: string[];
}

/** Aggregate record for a complete discovery run across all queries. */
export interface DiscoveryRunRecord {
  runId: string;
  startedAt: string;   // ISO 8601 UTC
  completedAt: string; // ISO 8601 UTC
  totalJobsSeen: number;
  totalTitleMatched: number;
  totalTitleDropped: number;
  queryResults: DiscoveryQueryResult[];
}

/** Response shape for POST /discovery/run */
export interface DiscoveryRunResponse {
  runId: string;
  status: "started" | "already_running" | "error";
  message: string;
}

/** Ingest result returned by job-search-os /ingest/discovery */
export interface DiscoveryIngestResult {
  total: number;
  new: number;
  duplicates: number;
  errors: number;
}
