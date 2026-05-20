/**
 * Shared types for the browser service.
 *
 * These mirror the FastAPI workflow API schema closely — keep in sync with
 * app/routers/workflow.py in job-search-os.
 */

// ── Workflow API types ─────────────────────────────────────────────────────

export type WorkflowStatus =
  | "pending"
  | "tailoring_resume"
  | "ready_for_browser"
  | "browser_running"
  | "awaiting_approval"
  | "submitted"
  | "failed"
  | "held"
  | "cancelled";

export type StepName =
  | "navigate"
  | "fill_personal_info"
  | "upload_resume"
  | "fill_questions"
  | "review_checkpoint"
  | "submit"
  | "confirm";

export type StepStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface WorkflowStep {
  id: string;
  step_name: StepName;
  status: StepStatus;
  screenshot_url: string | null;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface WorkflowState {
  workflow_id: string;
  job_key: string;
  status: WorkflowStatus;
  ats_platform: string | null;
  ats_url: string | null;
  browser_provider: string | null;
  browser_session_id: string | null;
  review_screenshot_url: string | null;
  review_form_data: Record<string, unknown> | null;
  submitted_at: string | null;
  confirmation_url: string | null;
  last_error: string | null;
  retry_count: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
  steps: WorkflowStep[];
}

// ── ATS Adapter interface ──────────────────────────────────────────────────

/**
 * ApplicantProfile is the structured personal data the adapter uses to fill
 * ATS form fields. Sourced from environment config.
 */
export interface ApplicantProfile {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  linkedinUrl: string;
  locationCity: string;
  locationState: string;
  locationCountry: string;
  resumeUrl: string;
}

/**
 * RunContext is passed to every adapter run. Contains everything the adapter
 * needs to navigate a form: the ATS URL, the applicant profile, and callbacks
 * to report step progress back to the FastAPI workflow API.
 */
export interface RunContext {
  jobKey: string;
  workflowId: string;
  atsUrl: string;
  applicant: ApplicantProfile;
  onStepStart: (step: StepName) => Promise<void>;
  onStepComplete: (step: StepName, screenshotUrl?: string) => Promise<void>;
  onStepFail: (step: StepName, error: string, screenshotUrl?: string) => Promise<void>;
  onReviewCheckpoint: (screenshotUrl: string, formData: Record<string, unknown>) => Promise<void>;
}

/**
 * AdapterResult is returned by adapter.run() after the session completes or
 * reaches the review checkpoint.
 */
export interface AdapterResult {
  /** True if the form was fully submitted (not just paused at review_checkpoint). */
  submitted: boolean;
  /** URL of the final confirmation page, if submitted. */
  confirmationUrl?: string;
  /** Screenshot URL of the confirmation page, if submitted. */
  confirmationScreenshotUrl?: string;
  /** True if paused at review_checkpoint awaiting human approval. */
  awaitingApproval?: boolean;
}

/**
 * Every ATS adapter must implement this interface.
 * PLATFORM PRIMITIVE: the adapter contract makes adapters interchangeable —
 * add Lever, Workday, etc. without touching the runner.
 */
export interface ATSAdapter {
  /** Canonical platform name, e.g. 'greenhouse', 'lever', 'workday' */
  readonly platform: string;

  /**
   * Returns true if this adapter can handle the given ATS URL.
   * Used by the adapter registry to select the right adapter.
   */
  canHandle(atsUrl: string): boolean;

  /**
   * Execute the full form automation sequence using the provided Playwright page.
   * The adapter calls ctx.onStep* callbacks at each step.
   */
  run(page: import("playwright-core").Page, ctx: RunContext): Promise<AdapterResult>;
}

// ── HTTP API types ─────────────────────────────────────────────────────────

export interface RunRequest {
  job_key: string;
  workflow_id: string;
  ats_url?: string;
  /** If true, skip the review_checkpoint and proceed directly to submit. */
  auto_submit?: boolean;
}

export interface RunResponse {
  job_key: string;
  workflow_id: string;
  status: "started" | "already_running" | "error";
  message: string;
}
