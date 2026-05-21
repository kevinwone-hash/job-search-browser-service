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
      // Mark the submit and confirm steps as complete
      await workflowClient.reportStep(jobKey, "submit", "completed");
      if (result.confirmationUrl) {
        await workflowClient.reportStep(jobKey, "confirm", "completed", {
          screenshotUrl: result.confirmationScreenshotUrl,
          metadata: { confirmation_url: result.confirmationUrl },
        });
      }
    } else if (result.awaitingApproval) {
      logger.info("session_paused_awaiting_approval", { job_key: jobKey });
      // Already reported via onReviewCheckpoint — nothing more to do here.
      // Session stays open in Browserbase until Kevin approves and
      // a second runSession call is made with auto_submit=true.
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
  } finally {
    activeSessions.delete(jobKey);
    if (session) {
      await session.close();
    }
    logger.info("session_complete", { job_key: jobKey });
  }
}
