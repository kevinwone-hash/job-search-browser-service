/**
 * Google Jobs browser discovery runner.
 *
 * Decision 44: browser-native discovery via Browserbase/Playwright.
 * Decision 46: rate limits enforced here — see constants in query-config.ts.
 *
 * Architecture:
 *   - One Browserbase session covers all queries (NOT one session per query).
 *   - JSON-LD extraction is primary (Google embeds schema.org/JobPosting data).
 *   - DOM extraction is the fallback when JSON-LD is absent or yields 0 jobs.
 *   - Title-level keyword filter runs browser-side to reduce ingest noise.
 *   - Per-query errors are isolated — a failing query logs and continues.
 *   - session.close() is always called in a finally block.
 *
 * Geography policy (DO NOT add location constraints here):
 *   Geography eligibility (remote/hybrid/onsite + Atlanta for non-remote)
 *   is enforced by _location_eligible() in extraction.py AFTER Claude
 *   evaluation. Discovery maximizes qualified recall. Do not filter by
 *   location at search time — that belongs in the evaluation layer.
 */

import { createBrowserSession } from "../browser-session.js";
import { logger } from "../logger.js";
import { DiscoveryIngestClient } from "./ingest-client.js";
import {
  DISCOVERY_QUERIES,
  MAX_CARDS_PER_QUERY,
  MIN_INTER_QUERY_DELAY_MS,
  PAGE_SETTLE_MS,
  TITLE_KEYWORDS,
  googleJobsUrl,
} from "./query-config.js";
import type {
  DiscoveredJob,
  DiscoveryQueryResult,
  DiscoveryRunRecord,
} from "./types.js";

import type { Page } from "playwright-core";

const ingestClient = new DiscoveryIngestClient();

// ---------------------------------------------------------------------------
// Diagnostic result store (in-memory, last run only)
// ---------------------------------------------------------------------------

export interface DiagnosticPageState {
  currentUrl: string;
  pageTitle: string;
  bodyText: string;
  jsonLdCount: number;
  jsonLdTypes: string[];
  cardSelectors: Record<string, number>;
  iframeCount: number;
  shadowRootCount: number;
  interstitialHints: string[];
  totalElements: number;
}

export interface DiagnosticQueryRecord {
  query: string;
  pageState: DiagnosticPageState | null;
  jobsSeen: number;
  jobsTitleMatched: number;
  errors: string[];
}

export interface DiagnosticStore {
  runId: string;
  sessionId: string;
  replayUrl: string;
  startedAt: string;
  completedAt: string | null;
  queries: DiagnosticQueryRecord[];
}

let _lastDiagnostic: DiagnosticStore | null = null;

/** Returns the in-memory result of the most recent diagnostic run, or null. */
export function getLastDiagnostic(): DiagnosticStore | null {
  return _lastDiagnostic;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Execute a full Google Jobs discovery run.
 *
 * Creates one Browserbase session, runs all DISCOVERY_QUERIES in sequence
 * with rate-limiting delays, extracts matching jobs, POSTs results to
 * job-search-os /ingest/discovery, writes observability keys, and sends
 * a Telegram run-summary notification.
 *
 * Called by POST /discovery/run in index.ts.
 * Never throws — all errors are caught and logged.
 */
/**
 * @param runId            Short identifier for log correlation.
 * @param diagnosticQueries  Optional override query list. When set, replaces
 *                         DISCOVERY_QUERIES for this run only. State keys and
 *                         Telegram notification are skipped — Railway logs are
 *                         the sole output. Use for single-query SERP recon.
 */
export async function runDiscovery(
  runId: string,
  diagnosticQueries?: readonly string[],
): Promise<DiscoveryRunRecord> {
  const queries = diagnosticQueries ?? DISCOVERY_QUERIES;
  const isDiagnostic = !!diagnosticQueries;

  const startedAt = new Date().toISOString();
  logger.info("discovery_run_starting", {
    run_id: runId,
    queries: queries.length,
    diagnostic: isDiagnostic,
    query_list: queries,
  });

  const queryResults: DiscoveryQueryResult[] = [];
  let session = null;

  try {
    session = await createBrowserSession();
    const { page, sessionId } = session;

    // Log Browserbase session for replay/screenshot access in dashboard
    const replayUrl = `https://www.browserbase.com/sessions/${sessionId}`;
    logger.info("discovery_browserbase_session", {
      run_id: runId,
      session_id: sessionId,
      replay_url: replayUrl,
    });

    // Initialise diagnostic store for this run
    if (isDiagnostic) {
      _lastDiagnostic = {
        runId,
        sessionId,
        replayUrl,
        startedAt,
        completedAt: null,
        queries: [],
      };
    }

    for (let i = 0; i < queries.length; i++) {
      const query = queries[i];

      // Decision 46: minimum inter-query delay (skip before first query)
      if (i > 0) {
        await page.waitForTimeout(MIN_INTER_QUERY_DELAY_MS);
      }

      const { result, pageState } = await _runQuery(page, query, runId, isDiagnostic);
      queryResults.push(result);

      // Store per-query diagnostic data
      if (isDiagnostic && _lastDiagnostic) {
        _lastDiagnostic.queries.push({
          query,
          pageState: pageState ?? null,
          jobsSeen: result.jobsSeen,
          jobsTitleMatched: result.jobsTitleMatched,
          errors: result.errors,
        });
      }

      logger.info("discovery_query_complete", {
        run_id: runId,
        query,
        seen: result.jobsSeen,
        matched: result.jobsTitleMatched,
        dropped: result.jobsTitleDropped,
        errors: result.errors.length,
      });
    }
  } catch (err) {
    logger.error("discovery_session_error", {
      run_id: runId,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    if (session) {
      await session.close();
    }
  }

  const completedAt = new Date().toISOString();

  const record: DiscoveryRunRecord = {
    runId,
    startedAt,
    completedAt,
    totalJobsSeen: queryResults.reduce((s, r) => s + r.jobsSeen, 0),
    totalTitleMatched: queryResults.reduce((s, r) => s + r.jobsTitleMatched, 0),
    totalTitleDropped: queryResults.reduce((s, r) => s + r.jobsTitleDropped, 0),
    queryResults,
  };

  logger.info("discovery_run_complete", {
    run_id: runId,
    diagnostic: isDiagnostic,
    total_seen: record.totalJobsSeen,
    total_matched: record.totalTitleMatched,
    total_dropped: record.totalTitleDropped,
    duration_ms: Date.now() - new Date(startedAt).getTime(),
  });

  // Diagnostic runs skip ingest + state writes — result stored in _lastDiagnostic
  if (isDiagnostic) {
    if (_lastDiagnostic) {
      _lastDiagnostic.completedAt = completedAt;
    }
    logger.info("discovery_diagnostic_complete", {
      run_id: runId,
      total_seen: record.totalJobsSeen,
      result_available_at: "GET /discovery/last-diagnostic",
    });
    return record;
  }

  // --- POST to job-search-os /ingest/discovery ---
  const allMatchedJobs = queryResults.flatMap((r) => r.matchedJobs);
  let ingestResult = { total: 0, new: 0, duplicates: 0, errors: 0 };
  let runStatus: "ok" | string = "ok";

  if (allMatchedJobs.length > 0) {
    try {
      ingestResult = await ingestClient.ingestJobs(allMatchedJobs, runId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      runStatus = `error: ${msg.slice(0, 200)}`;
      logger.error("discovery_ingest_failed", { run_id: runId, error: msg });
    }
  } else {
    logger.info("discovery_no_matched_jobs_skipping_ingest", { run_id: runId });
  }

  // --- Observability + Telegram (non-fatal) ---
  await Promise.allSettled([
    ingestClient.writeRunState(record, ingestResult, runStatus),
    ingestClient.notifyRunComplete(record, ingestResult),
  ]);

  return record;
}

// ---------------------------------------------------------------------------
// Per-query runner
// ---------------------------------------------------------------------------

async function _runQuery(
  page: Page,
  query: string,
  runId: string,
  isDiagnostic: boolean = false,
): Promise<{ result: DiscoveryQueryResult; pageState: DiagnosticPageState | null }> {
  const result: DiscoveryQueryResult = {
    query,
    jobsSeen: 0,
    jobsTitleMatched: 0,
    jobsTitleDropped: 0,
    matchedJobs: [],
    errors: [],
  };
  let pageState: DiagnosticPageState | null = null;

  try {
    // Navigate to Google Jobs SERP
    const url = googleJobsUrl(query);
    logger.info("discovery_query_navigating", { run_id: runId, query, url });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });

    // Google Jobs is a client-rendered SPA — wait for the jobs panel to hydrate
    await page.waitForTimeout(PAGE_SETTLE_MS);

    // Try to wait for job cards to appear; continue even if selector times out
    // (page may have loaded differently — fall through to extraction)
    try {
      await page.waitForSelector(
        '[data-jk], .iFjolb, [jsname="MZArnb"] li, .gjrt',
        { timeout: 8_000 },
      );
    } catch {
      logger.warn("discovery_query_job_cards_not_found", {
        run_id: runId,
        query,
        hint: "No known card selectors visible — attempting JSON-LD extraction anyway",
      });
    }

    // Diagnostic: capture + log page state to determine extraction failure root cause
    if (isDiagnostic) {
      pageState = await _logPageDiagnostics(page, query, runId);
    }

    // --- Primary: JSON-LD extraction ---
    let jobs = await _extractJsonLd(page, query);
    let method: "json_ld" | "dom" = "json_ld";

    if (jobs.length === 0) {
      // --- Fallback: DOM extraction ---
      logger.info("discovery_query_jsonld_empty_trying_dom", { run_id: runId, query });
      jobs = await _extractFromDom(page, query);
      method = "dom";
    }

    logger.info("discovery_query_extracted", {
      run_id: runId,
      query,
      method,
      count: jobs.length,
    });

    // --- Title-level pre-filter ---
    // Runs browser-side (here) to reduce ingest volume.
    // The evaluation layer (extraction.py) is the authoritative filter.
    for (const job of jobs) {
      result.jobsSeen++;

      if (_passesTitle(job.title)) {
        result.jobsTitleMatched++;
        result.matchedJobs.push(job);

        // Decision 46: cap per-query matched jobs
        if (result.matchedJobs.length >= MAX_CARDS_PER_QUERY) {
          logger.info("discovery_query_card_cap_reached", {
            run_id: runId,
            query,
            cap: MAX_CARDS_PER_QUERY,
          });
          break;
        }
      } else {
        result.jobsTitleDropped++;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("discovery_query_error", { run_id: runId, query, error: msg });
    result.errors.push(msg);
    // Non-fatal — caller continues to next query
  }

  return { result, pageState };
}

// ---------------------------------------------------------------------------
// JSON-LD extraction (primary path)
// ---------------------------------------------------------------------------

/**
 * Extract jobs from schema.org/JobPosting JSON-LD embeds in the page.
 *
 * Google embeds structured data in Google Jobs search results, making
 * this the most reliable extraction path. Returns [] if no JobPosting
 * data is found — caller falls through to DOM extraction.
 */
async function _extractJsonLd(page: Page, query: string): Promise<DiscoveredJob[]> {
  return page.evaluate((q: string) => {
    const scripts = Array.from(
      document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]'),
    );

    const jobs: Array<{
      title: string;
      company: string;
      location: string | null;
      remote: boolean | null;
      rawUrl: string;
      description: string | null;
      discoveryQuery: string;
      extractionMethod: "json_ld";
    }> = [];

    for (const script of scripts) {
      let data: unknown;
      try {
        data = JSON.parse(script.textContent ?? "");
      } catch {
        continue;
      }

      if (!data || typeof data !== "object") continue;
      const d = data as Record<string, unknown>;

      // Collect individual JobPosting items from various embed shapes:
      //   1. ItemList of JobPosting items (most common in SERP)
      //   2. Single JobPosting at top level
      //   3. Array of JobPosting objects
      const items: unknown[] = [];

      if (d["@type"] === "ItemList") {
        const elements = d["itemListElement"];
        if (Array.isArray(elements)) {
          for (const el of elements) {
            const item = (el as Record<string, unknown>)?.["item"] ?? el;
            items.push(item);
          }
        }
      } else if (d["@type"] === "JobPosting") {
        items.push(d);
      } else if (Array.isArray(data)) {
        for (const el of data as unknown[]) {
          if ((el as Record<string, unknown>)?.["@type"] === "JobPosting") {
            items.push(el);
          }
        }
      }

      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const j = item as Record<string, unknown>;
        if (j["@type"] !== "JobPosting") continue;

        const org = j["hiringOrganization"] as Record<string, unknown> | undefined;
        const loc = j["jobLocation"] as Record<string, unknown> | undefined;
        const addr = loc?.["address"] as Record<string, unknown> | undefined;

        const title = String(j["title"] ?? "").trim();
        const company = String(org?.["name"] ?? "").trim();
        if (!title || !company) continue;

        const city = String(addr?.["addressLocality"] ?? "").trim();
        const region = String(addr?.["addressRegion"] ?? "").trim();
        const locationStr = city && region ? `${city}, ${region}` : city || region || null;

        // jobLocationType: TELECOMMUTE = fully remote per schema.org spec
        const remote =
          j["jobLocationType"] === "TELECOMMUTE" ? true
          : j["applicantLocationRequirements"] ? null  // has location req but unknown type
          : null;

        const rawUrl = String(j["url"] ?? j["sameAs"] ?? "").trim();
        const description = j["description"] ? String(j["description"]).slice(0, 4000) : null;

        jobs.push({
          title,
          company,
          location: locationStr,
          remote,
          rawUrl,
          description,
          discoveryQuery: q,
          extractionMethod: "json_ld",
        });
      }
    }

    return jobs;
  }, query);
}

// ---------------------------------------------------------------------------
// DOM extraction (fallback path)
// ---------------------------------------------------------------------------

/**
 * Extract job data from the rendered Google Jobs card DOM.
 *
 * Used when JSON-LD yields no results. Google Jobs card selectors are
 * less stable than JSON-LD — this path is best-effort. Individual card
 * failures are silently skipped.
 *
 * Note: Google Jobs card links typically point to a google.com SERP URL,
 * not the ATS directly. job-search-os /ingest/discovery runs
 * aggregator_resolver to attempt ATS URL resolution server-side.
 */
async function _extractFromDom(page: Page, query: string): Promise<DiscoveredJob[]> {
  return page.evaluate((q: string) => {
    // Google Jobs card container selectors — ordered by specificity
    const cardSelectors = [
      'li[data-jk]',
      '.iFjolb',
      '[jsname="MZArnb"] li',
      '.gjrt',
    ];

    let cards: Element[] = [];
    for (const sel of cardSelectors) {
      const found = Array.from(document.querySelectorAll(sel));
      if (found.length > 0) {
        cards = found;
        break;
      }
    }

    const jobs: Array<{
      title: string;
      company: string;
      location: string | null;
      remote: boolean | null;
      rawUrl: string;
      description: string | null;
      discoveryQuery: string;
      extractionMethod: "dom";
    }> = [];

    for (const card of cards) {
      try {
        // Title — multiple fallback selectors
        const titleEl =
          card.querySelector('.nJlQNd') ??
          card.querySelector('[data-jk] h3') ??
          card.querySelector('h3') ??
          card.querySelector('[role="heading"]');
        const title = titleEl?.textContent?.trim() ?? "";
        if (!title) continue;

        // Company
        const companyEl =
          card.querySelector('.vNEEBe') ??
          card.querySelector('.nJlQNd + div') ??
          card.querySelector('[data-jk] [class*="company"]');
        const company = companyEl?.textContent?.trim() ?? "";
        if (!company) continue;

        // Location
        const locationEl =
          card.querySelector('.Qk80Jf') ??
          card.querySelector('[data-jk] [class*="location"]');
        const location = locationEl?.textContent?.trim() || null;

        // Remote hint from location text
        const remote =
          location?.toLowerCase().includes("remote") ? true
          : location?.toLowerCase().includes("hybrid") ? null
          : null;

        // URL — prefer "Apply on company website" link; fall back to card href
        const applyLink = card.querySelector<HTMLAnchorElement>(
          'a[aria-label*="Apply"], a[href*="://"][href*="apply"], a[data-jk]',
        );
        const rawUrl =
          (applyLink?.href && !applyLink.href.includes("google.com/search"))
            ? applyLink.href
            : (card.querySelector<HTMLAnchorElement>("a")?.href ?? "");

        jobs.push({
          title,
          company,
          location,
          remote,
          rawUrl,
          description: null,  // JD text not available in card DOM; extraction.py fetches it
          discoveryQuery: q,
          extractionMethod: "dom",
        });
      } catch {
        // Skip individual malformed card — don't abort the whole DOM pass
      }
    }

    return jobs;
  }, query);
}

// ---------------------------------------------------------------------------
// Diagnostic page state logger
// ---------------------------------------------------------------------------

/**
 * Logs detailed page state after navigation + settle to diagnose extraction failures.
 *
 * Captures in a single page.evaluate() call to minimize round-trips:
 *   - Current URL + page title (detect consent pages, bot interstitials, redirects)
 *   - Body text first 500 chars (detect blank page, error page, CAPTCHA text)
 *   - JSON-LD script count + @types present (detect whether Google embeds structured data)
 *   - Card selector hit counts (detect whether job cards rendered)
 *   - Iframe count + any shadow roots on body children (detect SPA containment patterns)
 *   - Any element with text "consent", "cookie", "verify", "captcha" (detect interstitials)
 */
async function _logPageDiagnostics(
  page: Page,
  query: string,
  runId: string,
): Promise<DiagnosticPageState | null> {
  try {
    const diag = await page.evaluate(() => {
      // Current URL and title
      const currentUrl = window.location.href;
      const pageTitle = document.title;

      // Body text — first 500 chars
      const bodyText = (document.body?.innerText ?? "").slice(0, 500).replace(/\s+/g, " ").trim();

      // JSON-LD scripts
      const jsonLdScripts = Array.from(
        document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]'),
      );
      const jsonLdCount = jsonLdScripts.length;
      const jsonLdTypes: string[] = [];
      for (const s of jsonLdScripts) {
        try {
          const parsed = JSON.parse(s.textContent ?? "");
          const t = (parsed as Record<string, unknown>)?.["@type"];
          if (t) jsonLdTypes.push(String(t));
        } catch {
          jsonLdTypes.push("parse_error");
        }
      }

      // Card selector counts — test each independently
      const cardSelectors: Record<string, number> = {
        "li[data-jk]": document.querySelectorAll("li[data-jk]").length,
        ".iFjolb": document.querySelectorAll(".iFjolb").length,
        '[jsname="MZArnb"] li': document.querySelectorAll('[jsname="MZArnb"] li').length,
        ".gjrt": document.querySelectorAll(".gjrt").length,
        // Additional broad selectors for diagnostics
        '[data-ved][data-rc]': document.querySelectorAll("[data-ved][data-rc]").length,
        'div[class*="job"]': document.querySelectorAll('div[class*="job"]').length,
        'li[class*="job"]': document.querySelectorAll('li[class*="job"]').length,
      };

      // Iframe count
      const iframeCount = document.querySelectorAll("iframe").length;

      // Shadow roots on body children (rare but possible SPA pattern)
      const shadowRootCount = Array.from(document.body?.children ?? []).filter(
        (el) => el.shadowRoot !== null,
      ).length;

      // Interstitial detection — text patterns that indicate bot/consent pages
      const bodyLower = (document.body?.innerText ?? "").toLowerCase();
      const interstitialHints: string[] = [];
      if (bodyLower.includes("consent")) interstitialHints.push("consent");
      if (bodyLower.includes("cookie")) interstitialHints.push("cookie");
      if (bodyLower.includes("captcha")) interstitialHints.push("captcha");
      if (bodyLower.includes("verify you are human")) interstitialHints.push("human_verify");
      if (bodyLower.includes("unusual traffic")) interstitialHints.push("unusual_traffic");
      if (bodyLower.includes("before you continue")) interstitialHints.push("before_you_continue");
      if (bodyLower.includes("sign in")) interstitialHints.push("sign_in");

      return {
        currentUrl,
        pageTitle,
        bodyText,
        jsonLdCount,
        jsonLdTypes,
        cardSelectors,
        iframeCount,
        shadowRootCount,
        interstitialHints,
        totalElements: document.querySelectorAll("*").length,
      };
    });

    logger.info("discovery_query_page_diagnostic", {
      run_id: runId,
      query,
      current_url: diag.currentUrl,
      page_title: diag.pageTitle,
      body_text_preview: diag.bodyText,
      json_ld_count: diag.jsonLdCount,
      json_ld_types: diag.jsonLdTypes,
      card_selectors: diag.cardSelectors,
      iframe_count: diag.iframeCount,
      shadow_root_count: diag.shadowRootCount,
      interstitial_hints: diag.interstitialHints,
      total_elements: diag.totalElements,
    });

    return diag as DiagnosticPageState;
  } catch (err) {
    logger.warn("discovery_query_diagnostic_failed", {
      run_id: runId,
      query,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Title filter
// ---------------------------------------------------------------------------

/**
 * Returns true if the job title contains at least one TITLE_KEYWORDS entry.
 * Case-insensitive substring match.
 *
 * CMO is intentionally absent — CMO is Kevin's outreach audience, not a
 * target application role (see feedback_cmo_distinction memory).
 */
function _passesTitle(title: string): boolean {
  const t = title.toLowerCase();
  return TITLE_KEYWORDS.some((keyword) => t.includes(keyword));
}
