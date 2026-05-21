/**
 * Main session runner.
 *
 * Orchestrates the full browser automation lifecycle for a single job application:
 *   1. Fetch workflow state from FastAPI API
 *   2. Create Browserbase session
 *   3. Select the right ATS adapter
 *   4. Run the adapter (form filling, step reporting)
 *   5. Handle review checkpoint (pause) or completion
 *   6. Clean up session
 *
 * The runner is orchestration-engine-agnostic — it doesn't know or care whether
 * it was triggered by Make.com, Temporal, or a direct HTTP call.
 */

import axios from "axios";
import { createBrowserSession } from "./browser-session.js";
import { WorkflowClient } from "./workflow-client.js";
import { adapterRegistry } from "./adapters/registry.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import type { ApplicantProfile, RunContext, StepName } from "./types.js";

const workflowClient = new WorkflowClient();

/** Active sessions — keyed by job_key. Prevents duplicate runs. */
const activeSessions = new Set<string>();

export function isSessionActive(jobKey: string): boolean {
  return activeSessions.has(jobKey);
}

/**
 * Run a browser automation session for the given job.
 *
 * This function is async and resolves when the session is complete or
 * paused at review_checkpoint. It does NOT block the HTTP response — the
 * caller should fire it without awaiting and return 202 immediately.
 */
export async function runSession(
  jobKey: string,
  workflowId: string,
  atsUrlOverride?: string,
  resumeUrlOverride?: string,
  autoSubmit: boolean = false,
): Promise<void> {
  if (activeSessions.has(jobKey)) {
    logger.warn("session_already_active", { job_key: jobKey });
    return;
  }

  activeSessions.add(jobKey);
  logger.info("session_starting", { job_key: jobKey, workflow_id: workflowId });

  let session = null;
  let currentStep: StepName | undefined;

  try {
    // 1. Fetch workflow state
    const workflow = await workflowClient.getWorkflow(jobKey);
    const atsUrl = atsUrlOverride ?? workflow.ats_url;

    if (!atsUrl) {
      throw new Error("No ATS URL available on workflow — cannot start session");
    }

    if (!["pending", "ready_for_browser"].includes(workflow.status)) {
      throw new Error(
        `Workflow is not in a startable state: ${workflow.status}`
      );
    }

    // 2. Select adapter
    const adapter = adapterRegistry.find(atsUrl);
    if (!adapter) {
      throw new Error(`No adapter found for ATS URL: ${atsUrl}`);
    }

    logger.info("adapter_selected", {
      job_key: jobKey,
      platform: adapter.platform,
      ats_url: atsUrl,
    });

    // 3. Create Browserbase session
    session = await createBrowserSession();
    await workflowClient.updateBrowserSession(jobKey, session.sessionId);

    // 4. Build run context with step callbacks
    const applicant: ApplicantProfile = {
      firstName: config.applicantFirstName,
      lastName: config.applicantLastName,
      email: config.applicantEmail,
      phone: config.applicantPhone,
      linkedinUrl: config.applicantLinkedinUrl,
      locationCity: config.applicantLocationCity,
      locationState: config.applicantLocationState,
      locationCountry: config.applicantLocationCountry,
      // Use per-job tailored resume if provided; fall back to master resume from config
      resumeUrl: resumeUrlOverride ?? config.resumeUrl,
    };

    logger.info("resume_url_resolved", {
      job_key: jobKey,
      source: resumeUrlOverride ? "per_job_override" : "config_env_var",
      url: applicant.resumeUrl ? applicant.resumeUrl.slice(0, 60) + "…" : "(none)",
    });

    const ctx: RunContext = {
      jobKey,
      workflowId,
      atsUrl,
      applicant,
      autoSubmit,

      onStepStart: async (step: StepName) => {
        currentStep = step;
        logger.info("step_start", { job_key: jobKey, step });
        await workflowClient.reportStep(jobKey, step, "running", {
          metadata: {
            browser_session_id: session!.sessionId,
            adapter: adapter.platform,
          },
        });
      },

      onStepComplete: async (step: StepName, screenshotUrl?: string) => {
        logger.info("step_complete", { job_key: jobKey, step });
        await workflowClient.reportStep(jobKey, step, "completed", {
          screenshotUrl,
        });
      },

      onStepFail: async (step: StepName, error: string, screenshotUrl?: string) => {
        logger.error("step_fail", { job_key: jobKey, step, error });
        await workflowClient.reportStep(jobKey, step, "failed", {
          screenshotUrl,
          errorMessage: error,
        });
      },

      onReviewCheckpoint: async (
        screenshotUrl: string,
        formData: Record<string, unknown>
      ) => {
        logger.info("review_checkpoint_reached", { job_key: jobKey });
        // The workflow step API auto-transitions to 'awaiting_approval'
        // when step_name='review_checkpoint' and status='completed'.
        await workflowClient.reportStep(jobKey, "review_checkpoint", "completed", {
          screenshotUrl,
          metadata: { captured_form_data: formData },
        });
      },
    };

    // 5. Run the adapter
    const result = await adapter.run(session.page, ctx);

    if (result.submitted) {
      logger.info("session_submitted", {
        job_key: jobKey,
        confirmation_url: result.confirmationUrl,
      });
      await workflowClient.reportStep(jobKey, "submit", "completed");
      await workflowClient.reportStep(jobKey, "confirm", "completed", {
        screenshotUrl: result.confirmationScreenshotUrl,
        metadata: { confirmation_url: result.confirmationUrl ?? null },
      });

      // Update job status to "applied" so it leaves the /review Applied section
      await _markJobApplied(jobKey).catch((e: unknown) => {
        logger.warn("job_status_update_failed", { job_key: jobKey, error: String(e) });
      });

      // Send Telegram confirmation with screenshot
      await _notifySubmitted(
        jobKey,
        result.confirmationScreenshotUrl,
        result.confirmationUrl,
      );
    } else if (result.awaitingApproval) {
      logger.info("session_paused_awaiting_approval", { job_key: jobKey });
      // review_checkpoint already reported via onReviewCheckpoint callback.
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("session_error", { job_key: jobKey, error: message });

    // Capture a screenshot if the session is still alive
    let screenshotUrl: string | undefined;
    if (session) {
      try {
        screenshotUrl = `data:image/png;base64,${await session.screenshot()}`;
      } catch {
        // ignore screenshot error
      }
    }

    await workflowClient.reportFailure(jobKey, message, currentStep, screenshotUrl);

    // Notify failure — include ATS URL and resume link so Kevin can apply manually
    await _notifyFailed(jobKey, message);
  } finally {
    activeSessions.delete(jobKey);
    if (session) {
      await session.close();
    }
    logger.info("session_complete", { job_key: jobKey });
  }
}

// ── Telegram notification helpers ──────────────────────────────────────────

async function _notifySubmitted(
  jobKey: string,
  screenshotDataUri?: string,
  confirmationUrl?: string,
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const base = `https://api.telegram.org/bot${token}`;

  // If we have a screenshot, send it as a photo with caption
  if (screenshotDataUri && screenshotDataUri.startsWith("data:image/png;base64,")) {
    try {
      const b64 = screenshotDataUri.replace("data:image/png;base64,", "");
      const buf = Buffer.from(b64, "base64");
      // Native FormData + Blob available in Node 20+
      const form = new globalThis.FormData();
      form.set("chat_id", chatId);
      form.set("caption", `✅ <b>Application submitted</b>\n\nJob: ${jobKey.slice(0, 16)}…${confirmationUrl ? `\n\n<a href="${confirmationUrl}">View confirmation →</a>` : ""}`);
      form.set("parse_mode", "HTML");
      form.set("photo", new globalThis.Blob([buf], { type: "image/png" }), "confirmation.png");
      await axios.post(`${base}/sendPhoto`, form, { timeout: 15_000 });
      return;
    } catch (err) {
      logger.warn("telegram_photo_send_failed", { error: String(err) });
      // Fall through to text message
    }
  }

  // Fallback: text only
  await axios.post(`${base}/sendMessage`, {
    chat_id: chatId,
    text: `✅ <b>Application submitted</b>\n\nJob: <code>${jobKey.slice(0, 16)}…</code>${confirmationUrl ? `\n\n<a href="${confirmationUrl}">View confirmation →</a>` : ""}`,
    parse_mode: "HTML",
    disable_web_page_preview: false,
  }, { timeout: 10_000 }).catch((e: unknown) => {
    logger.warn("telegram_text_send_failed", { error: String(e) });
  });
}

async function _markJobApplied(jobKey: string): Promise<void> {
  const apiUrl = config.jobSearchApiUrl;
  const apiKey = config.jobSearchApiKey;
  await axios.post(
    `${apiUrl}/api/v1/jobs/${jobKey}/status`,
    { status: "applied", note: "Auto-submitted by browser service" },
    {
      headers: { "x-api-key": apiKey, "content-type": "application/json" },
      timeout: 10_000,
    },
  );
  logger.info("job_status_marked_applied", { job_key: jobKey });
}

async function _notifyFailed(
  jobKey: string,
  errorMessage: string,
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  // Fetch workflow to get ATS URL for manual fallback
  let atsUrl = "";
  try {
    const workflow = await workflowClient.getWorkflow(jobKey);
    atsUrl = workflow.ats_url ?? "";
  } catch {
    // ignore
  }

  const manualLink = atsUrl ? `\n\n<a href="${atsUrl}">Apply manually →</a>` : "";
  const message =
    `⚠️ <b>Auto-apply failed</b>\n\n` +
    `Job: <code>${jobKey.slice(0, 16)}…</code>\n` +
    `Error: ${errorMessage.slice(0, 200)}` +
    manualLink +
    `\n\nYour tailored resume is in R2. Check /review to download it.`;

  await axios.post(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      chat_id: chatId,
      text: message,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    },
    { timeout: 10_000 },
  ).catch((e: unknown) => {
    logger.warn("telegram_failure_notify_failed", { error: String(e) });
  });
}
