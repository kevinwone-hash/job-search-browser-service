/**
 * Client for the FastAPI job-search-os workflow API.
 *
 * All browser service → FastAPI communication goes through this module.
 * Keeps the adapter and runner free of HTTP concerns.
 */

import axios, { AxiosInstance } from "axios";
import { config } from "./config.js";
import { logger } from "./logger.js";
import type { StepName, StepStatus, WorkflowState } from "./types.js";

export class WorkflowClient {
  private readonly http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      baseURL: config.jobSearchApiUrl,
      headers: {
        "X-API-Key": config.jobSearchApiKey,
        "Content-Type": "application/json",
      },
      timeout: 15_000,
    });
  }

  /** Fetch current workflow state for a job. */
  async getWorkflow(jobKey: string): Promise<WorkflowState> {
    const res = await this.http.get<WorkflowState>(`/api/v1/jobs/${jobKey}/workflow`);
    return res.data;
  }

  /**
   * Report a step transition.
   * Called by the runner at each step start, completion, or failure.
   */
  async reportStep(
    jobKey: string,
    stepName: StepName,
    status: StepStatus,
    options: {
      screenshotUrl?: string;
      errorMessage?: string;
      metadata?: Record<string, unknown>;
    } = {}
  ): Promise<WorkflowState> {
    logger.info("workflow_step_report", {
      job_key: jobKey,
      step: stepName,
      status,
    });

    const res = await this.http.post<WorkflowState>(
      `/api/v1/jobs/${jobKey}/workflow/step`,
      {
        step_name: stepName,
        status,
        screenshot_url: options.screenshotUrl ?? null,
        error_message: options.errorMessage ?? null,
        metadata: options.metadata ?? null,
      }
    );
    return res.data;
  }

  /**
   * Report a terminal workflow failure.
   * Called when the session encounters an unrecoverable error.
   */
  async reportFailure(
    jobKey: string,
    error: string,
    stepName?: StepName,
    screenshotUrl?: string
  ): Promise<void> {
    logger.error("workflow_failed", { job_key: jobKey, error, step: stepName });
    try {
      await this.http.post(`/api/v1/jobs/${jobKey}/workflow/fail`, {
        error,
        step_name: stepName ?? null,
        screenshot_url: screenshotUrl ?? null,
      });
    } catch (err) {
      // Don't throw — we're already in an error path
      logger.error("workflow_fail_report_error", { job_key: jobKey, err });
    }
  }

  /**
   * Update the browser_session_id on the workflow.
   * Called immediately after the Browserbase session is created so the
   * session is linkable from the FastAPI side before the form run begins.
   */
  async updateBrowserSession(jobKey: string, browserSessionId: string): Promise<void> {
    // The workflow API doesn't have a dedicated PATCH endpoint for this yet.
    // We embed it in the first step's metadata as the canonical record.
    logger.info("browser_session_created", {
      job_key: jobKey,
      browser_session_id: browserSessionId,
    });
  }
}
