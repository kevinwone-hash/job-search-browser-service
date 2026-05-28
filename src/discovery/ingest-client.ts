/**
 * Discovery ingest client — browser-service → job-search-os HTTP calls.
 *
 * All outbound calls from the discovery module to job-search-os go through
 * this module. Mirrors the WorkflowClient pattern: a single AxiosInstance
 * with shared auth, keeping google-jobs-runner.ts free of HTTP concerns.
 *
 * Responsibilities:
 *   1. POST /ingest/discovery — send matched jobs for server-side resolver
 *      pass, ingest_batch dedup, and extraction queuing.
 *   2. POST /api/v1/platform-state (batch) — write 3 observability keys
 *      after each run completes.
 *   3. POST Telegram sendMessage — send run summary notification.
 */

import axios, { AxiosInstance } from "axios";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { DiscoveredJob, DiscoveryIngestResult, DiscoveryRunRecord } from "./types.js";

export class DiscoveryIngestClient {
  private readonly http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      baseURL: config.jobSearchApiUrl,
      headers: {
        "X-API-Key": config.jobSearchApiKey,
        "Content-Type": "application/json",
      },
      timeout: 30_000,
    });
  }

  /**
   * POST matched jobs to job-search-os /ingest/discovery.
   *
   * job-search-os will:
   *   1. Run aggregator_resolver on each URL (HIGH/MEDIUM → resolved ATS URL)
   *   2. Apply server-side title validation pass
   *   3. ingest_batch() — fingerprint dedup (idempotent)
   *   4. run_extraction_background() per new job (Claude evaluation gates /review)
   *
   * Returns the BatchIntakeResponse counts.
   */
  async ingestJobs(
    jobs: DiscoveredJob[],
    runId: string,
  ): Promise<DiscoveryIngestResult> {
    if (jobs.length === 0) {
      return { total: 0, new: 0, duplicates: 0, errors: 0 };
    }

    const payload = {
      run_id: runId,
      jobs: jobs.map((j) => ({
        source: "google_jobs",
        company: j.company,
        title: j.title,
        location: j.location ?? undefined,
        remote: j.remote ?? undefined,
        posting_url: j.rawUrl || undefined,
        description: j.description ?? undefined,
        raw_payload: {
          discovery_query: j.discoveryQuery,
          extraction_method: j.extractionMethod,
          run_id: runId,
        },
      })),
    };

    logger.info("discovery_ingest_posting", {
      run_id: runId,
      job_count: jobs.length,
    });

    const res = await this.http.post<DiscoveryIngestResult>(
      "/api/v1/ingest/discovery",
      payload,
    );

    logger.info("discovery_ingest_accepted", {
      run_id: runId,
      total: res.data.total,
      new: res.data.new,
      duplicates: res.data.duplicates,
      errors: res.data.errors,
    });

    return res.data;
  }

  /**
   * Write 3 platform_state observability keys to job-search-os after
   * a discovery run completes. Mirrors _write_intake_state in scheduler.py.
   *
   * Keys written:
   *   discovery.google_jobs.last_run_at      — ISO 8601 UTC timestamp
   *   discovery.google_jobs.last_run_status  — "ok" or "error: <message>"
   *   discovery.google_jobs.last_run_summary — JSON with run counts
   */
  async writeRunState(
    record: DiscoveryRunRecord,
    ingestResult: DiscoveryIngestResult,
    runStatus: "ok" | string,
  ): Promise<void> {
    const summary = JSON.stringify({
      queries_run: record.queryResults.length,
      jobs_seen_total: record.totalJobsSeen,
      jobs_title_matched: record.totalTitleMatched,
      jobs_title_dropped: record.totalTitleDropped,
      new: ingestResult.new,
      duplicates: ingestResult.duplicates,
      errors: ingestResult.errors,
    });

    const keys = [
      {
        key: "discovery.google_jobs.last_run_at",
        value: record.completedAt,
        category: "discovery",
        module: "job_search_os",
        description: "Timestamp of last Google Jobs browser discovery run",
      },
      {
        key: "discovery.google_jobs.last_run_status",
        value: runStatus,
        category: "discovery",
        module: "job_search_os",
        description: "Status of last Google Jobs browser discovery run",
      },
      {
        key: "discovery.google_jobs.last_run_summary",
        value: summary,
        category: "discovery",
        module: "job_search_os",
        description: "Ingestion counts from last Google Jobs browser discovery run",
      },
    ];

    // Fire all 3 upserts in parallel — non-fatal if they fail.
    // Endpoint: PUT /api/v1/platform/state/{key} — key is path param, not body field.
    await Promise.allSettled(
      keys.map(({ key, ...body }) =>
        this.http
          .put(`/api/v1/platform/state/${encodeURIComponent(key)}`, body)
          .catch((err: unknown) => {
            logger.warn("discovery_state_write_failed", {
              key,
              error: String(err),
            });
          }),
      ),
    );
  }

  /**
   * Send a Telegram run summary notification via job-search-os.
   * Non-fatal — if this fails the run is still considered complete.
   *
   * Format:
   *   🔍 Discovery run complete
   *   • Queries: 5 | Seen: 47 | Matched: 12
   *   • New: 8 | Dupes: 4 | Errors: 0
   */
  async notifyRunComplete(
    record: DiscoveryRunRecord,
    ingestResult: DiscoveryIngestResult,
  ): Promise<void> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;

    const text =
      `🔍 <b>Discovery run complete</b> [${record.runId}]\n` +
      `• Queries: ${record.queryResults.length} | Seen: ${record.totalJobsSeen} | Matched: ${record.totalTitleMatched}\n` +
      `• New: ${ingestResult.new} | Dupes: ${ingestResult.duplicates} | Errors: ${ingestResult.errors}`;

    await axios
      .post(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          chat_id: chatId,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        },
        { timeout: 10_000 },
      )
      .catch((err: unknown) => {
        logger.warn("discovery_telegram_notify_failed", { error: String(err) });
      });
  }
}
