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
export async function runDiscovery(runId: string): Promise<DiscoveryRunRecord> {
  const startedAt = new Date().toISOString();
  logger.info("discovery_run_starting", { run_id: runId, queries: DISCOVERY_QUERIES.length });

  const queryResults: DiscoveryQueryResult[] = [];
  let session = null;

  try {
    session = await createBrowserSession();
    const { page } = session;

    for (let i = 0; i < DISCOVERY_QUERIES.length; i++) {
      const query = DISCOVERY_QUERIES[i];

      // Decision 46: minimum inter-query delay (skip before first query)
      if (i > 0) {
        await page.waitForTimeout(MIN_INTER_QUERY_DELAY_MS);
      }

      const result = await _runQuery(page, query, runId);
      queryResults.push(result);

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
    total_seen: record.totalJobsSeen,
    total_matched: record.totalTitleMatched,
    total_dropped: record.totalTitleDropped,
    duration_ms: Date.now() - new Date(startedAt).getTime(),
  });

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
): Promise<DiscoveryQueryResult> {
  const result: DiscoveryQueryResult = {
    query,
    jobsSeen: 0,
    jobsTitleMatched: 0,
    jobsTitleDropped: 0,
    matchedJobs: [],
    errors: [],
  };

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

  return result;
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
