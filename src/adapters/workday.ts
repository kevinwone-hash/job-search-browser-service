/**
 * Workday ATS adapter.
 *
 * Handles Workday job application forms at:
 *   [employer].myworkdayjobs.com/[tenant]/job/[location]/[title]/[id]
 *   [employer].myworkdayjobs.com/[tenant]/job/[id]/apply (direct apply URL)
 *   Also handles custom-domain Workday deployments (e.g. careers.company.com)
 *   detected by DOM indicators.
 *
 * Step sequence:
 *   navigate → fill_personal_info → upload_resume → fill_questions
 *   → review_checkpoint (pause for Kevin's review and approval)
 *
 * Workday-specific characteristics vs. Greenhouse/Lever:
 *   - Multi-page wizard: sections separated by "Next" button navigation
 *   - Client-rendered React SPA: DOM is fully dynamic, must wait for renders
 *   - Account creation modal: must detect and dismiss on load
 *   - Resume upload triggers auto-parse that may overwrite fields
 *   - Work authorization questions are REQUIRED and must be answered
 *   - data-automation-id attributes are the stable selector surface
 *   - Employer customization is high — V1 pauses at review_checkpoint
 *     so Kevin can complete any sections that couldn't be auto-filled
 *
 * V1 design principle: navigate all discoverable sections, fill what is
 * reliably automatable (personal info, resume upload, work auth, EEO),
 * screenshot everything, and pause at the Review & Submit section.
 * Kevin reviews and submits manually. This is better than falling to the
 * full exception flow because Kevin starts from a partially-filled form.
 *
 * Decision 8 (vision evaluator): wired into autoSubmit path. V1 implementation
 * uses URL/body text confirmation detection (same pattern as Lever). Full Claude
 * Haiku vision evaluation is the V2 upgrade path — add ANTHROPIC_API_KEY to
 * config and replace _evaluateConfirmation() body.
 */

import axios from "axios";
import path from "path";
import type { Page } from "playwright-core";
import type { ATSAdapter, AdapterResult, RunContext } from "../types.js";
import { logger } from "../logger.js";

// ── Workday section names (from section heading detection) ─────────────────
type WorkdaySection =
  | "my_information"
  | "my_experience"
  | "application_questions"
  | "voluntary_disclosures"  // EEO / self-identify
  | "review"
  | "unknown";

// ── Stable Workday selector constants ──────────────────────────────────────
const WD = {
  // Navigation
  nextBtn: [
    "[data-automation-id='bottom-navigation-next-button']",
    "[data-automation-id='nextButton']",
    "button[aria-label='Next']",
  ],
  saveBtn: [
    "[data-automation-id='bottom-navigation-save-button']",
  ],
  submitBtn: [
    "[data-automation-id='bottom-navigation-next-button'][aria-label*='Submit']",
    "button[data-automation-id='submitButton']",
    "button[aria-label='Submit']",
    "button[aria-label='Apply']",
  ],

  // Page load indicators
  appShell: "[data-automation-id='appContainer'], [data-automation-id='wd-popup'], .wd-popup",
  formContainer: "[data-automation-id='formContainer']",
  sectionHeading: "h2[data-automation-id='sectionTitle'], h2.css-app-header, [data-automation-id='pageTitle']",

  // Account/sign-in modal
  signInModal: "div[data-automation-id='signinPopup'], [aria-label*='Sign In'], [aria-labelledby*='signIn']",
  createAccountModal: "[data-automation-id='createAccount']",
  continueAsGuestBtn: [
    "[data-automation-id='continueAsGuestButton']",
    "button[aria-label*='Continue']",
    "button[aria-label*='without']",
    "button[aria-label*='guest']",
  ],
  dismissModalBtn: [
    "[data-automation-id='closeButton']",
    "button[aria-label='Close']",
    "button[title='Close']",
  ],

  // My Information — personal fields
  firstName: [
    "[data-automation-id='legalName--firstName']",
    "[data-automation-id='firstName']",
    "input[aria-label*='First Name']",
    "input[placeholder*='First Name']",
  ],
  lastName: [
    "[data-automation-id='legalName--lastName']",
    "[data-automation-id='lastName']",
    "input[aria-label*='Last Name']",
    "input[placeholder*='Last Name']",
  ],
  email: [
    "[data-automation-id='email']",
    "input[type='email']",
    "input[aria-label*='Email']",
  ],
  phone: [
    "[data-automation-id='phone-number']",
    "[data-automation-id='phone']",
    "input[aria-label*='Phone']",
    "input[type='tel']",
  ],
  linkedIn: [
    "[data-automation-id='linkedin']",
    "input[aria-label*='LinkedIn']",
    "input[placeholder*='LinkedIn']",
  ],
  address: [
    "[data-automation-id='addressSection--addressLine1']",
    "input[aria-label*='Address Line 1']",
  ],
  city: [
    "[data-automation-id='addressSection--city']",
    "input[aria-label*='City']",
  ],
  state: [
    "[data-automation-id='addressSection--stateSubdivisionCode']",
    "[aria-label*='State']",
  ],
  postalCode: [
    "[data-automation-id='addressSection--postalCode']",
    "input[aria-label*='Postal Code']",
    "input[aria-label*='ZIP']",
  ],
  country: [
    "[data-automation-id='addressSection--countryISOCode']",
    "[aria-label*='Country']",
  ],

  // Resume upload
  fileUploadInput: [
    "input[data-automation-id='file-upload-input-ref']",
    "input[type='file'][accept*='pdf']",
    "input[type='file'][accept*='doc']",
    "input[type='file']",
  ],
  fileDropZone: "[data-automation-id='file-upload-drop-zone']",

  // Work authorization
  workAuthSection: [
    "[data-automation-id*='workAuthorization']",
    "[data-automation-id*='legallyAuthorized']",
  ],
} as const;

export class WorkdayAdapter implements ATSAdapter {
  readonly platform = "workday";

  canHandle(atsUrl: string): boolean {
    return (
      atsUrl.includes("myworkdayjobs.com") ||
      atsUrl.includes("workday.com/en-US/") ||
      atsUrl.includes(".wd1.myworkdayjobs.com") ||
      atsUrl.includes(".wd3.myworkdayjobs.com") ||
      atsUrl.includes(".wd5.myworkdayjobs.com")
    );
  }

  async run(page: Page, ctx: RunContext): Promise<AdapterResult> {
    // ── Step 1: Navigate ────────────────────────────────────────────────────
    await ctx.onStepStart("navigate");
    try {
      // Navigate to the direct application URL — Workday apply links end in /apply
      // or go through an intermediary job-posting page. Both are handled.
      await page.goto(ctx.atsUrl, { waitUntil: "domcontentloaded" });

      // Workday SPA needs time to hydrate after initial DOM load
      await this._waitForWorkdayApp(page);

      // Dismiss any account/sign-in modal that appears on load
      await this._dismissAccountModal(page);

      const screenshot = await this._screenshot(page);
      await ctx.onStepComplete("navigate", screenshot);
    } catch (err) {
      const msg = toMessage(err);
      const screenshot = await this._screenshot(page).catch(() => undefined);
      await ctx.onStepFail("navigate", msg, screenshot);
      throw err;
    }

    // ── Step 2: Fill personal info ──────────────────────────────────────────
    // Workday "My Information" section: name, email, phone, address, LinkedIn.
    // Strategy: upload resume first in this section if the upload widget is here,
    // then fill/correct personal fields (resume parse may pre-populate them).
    await ctx.onStepStart("fill_personal_info");
    try {
      // Detect which section we're on and navigate to My Information if needed
      const section = await this._detectCurrentSection(page);
      logger.info("workday_section_detected", {
        job_key: ctx.jobKey,
        section,
      });

      // Fill whatever personal info fields are present in the current section
      await this._fillPersonalInfoFields(page, ctx);
      const screenshot = await this._screenshot(page);
      await ctx.onStepComplete("fill_personal_info", screenshot);
    } catch (err) {
      const msg = toMessage(err);
      const screenshot = await this._screenshot(page).catch(() => undefined);
      await ctx.onStepFail("fill_personal_info", msg, screenshot);
      throw err;
    }

    // ── Step 3: Upload resume ───────────────────────────────────────────────
    // In Workday, resume upload may be on the first page (My Information) or
    // the second page (My Experience). We attempt upload here; if the upload
    // widget isn't found on the current page we navigate to the next section
    // and try again.
    await ctx.onStepStart("upload_resume");
    try {
      const uploaded = await this._uploadResume(page, ctx);
      if (!uploaded) {
        // Navigate to next section and try again
        logger.info("workday_resume_upload_not_found_attempting_next_section", {
          job_key: ctx.jobKey,
        });
        await this._clickNext(page);
        await this._waitForNextSection(page);
        await this._uploadResume(page, ctx);
      }

      // After upload, Workday may parse the resume and overwrite fields.
      // Wait for the parse to settle, then re-fill any fields that were cleared.
      await page.waitForTimeout(4000);
      await this._fillPersonalInfoFields(page, ctx);

      const screenshot = await this._screenshot(page);
      await ctx.onStepComplete("upload_resume", screenshot);
    } catch (err) {
      const msg = toMessage(err);
      const screenshot = await this._screenshot(page).catch(() => undefined);
      await ctx.onStepFail("upload_resume", msg, screenshot);
      // Don't throw — resume upload failure is non-fatal for V1.
      // Kevin will see the failure screenshot and can upload manually at review_checkpoint.
      logger.warn("workday_resume_upload_failed_continuing", {
        job_key: ctx.jobKey,
        error: msg,
      });
    }

    // ── Step 4: Navigate through sections and fill questions ────────────────
    // Iterate through remaining Workday wizard sections, filling what we can:
    //   - Work authorization (required — MUST answer)
    //   - EEO / demographic questions (decline to self-identify)
    //   - Custom screening questions (skip — Kevin answers at review_checkpoint)
    // Stop when we reach the "Review" section.
    await ctx.onStepStart("fill_questions");
    try {
      await this._navigateThroughSections(page, ctx);
      const screenshot = await this._screenshot(page);
      await ctx.onStepComplete("fill_questions", screenshot);
    } catch (err) {
      const msg = toMessage(err);
      const screenshot = await this._screenshot(page).catch(() => undefined);
      await ctx.onStepFail("fill_questions", msg, screenshot);
      // Don't throw — we'll pause at review_checkpoint with whatever was filled.
      logger.warn("workday_section_navigation_failed_pausing_at_checkpoint", {
        job_key: ctx.jobKey,
        error: msg,
      });
    }

    // ── Step 5: Review checkpoint ───────────────────────────────────────────
    // We are now on or near the Review & Submit page. Pause for Kevin to:
    //   - Review all filled fields
    //   - Complete any sections that weren't auto-filled
    //   - Submit the form manually (or via autoSubmit if set)
    if (ctx.autoSubmit) {
      await ctx.onStepStart("submit");
      try {
        const result = await this._submitAndVerify(page, ctx);
        return result;
      } catch (err) {
        const msg = toMessage(err);
        const screenshot = await this._screenshot(page).catch(() => undefined);
        await ctx.onStepFail("submit", msg, screenshot);
        // Fall through to review_checkpoint — don't lose the filled form
        logger.warn("workday_autosubmit_failed_pausing_at_checkpoint", {
          job_key: ctx.jobKey,
          error: msg,
        });
      }
    }

    // Pause at review_checkpoint — standard HITL gate
    await ctx.onStepStart("review_checkpoint");
    const reviewScreenshot = await this._screenshot(page);
    const formData = await this._captureFormData(page);
    await ctx.onReviewCheckpoint(reviewScreenshot, formData);

    return { submitted: false, awaitingApproval: true };
  }

  // ── Private: Workday-specific navigation ──────────────────────────────────

  /**
   * Wait for the Workday React SPA to finish initial hydration.
   * The app shell indicates the JS bundle has loaded and rendered.
   */
  private async _waitForWorkdayApp(page: Page): Promise<void> {
    // Wait for either the app container or a form container to appear
    await page.waitForSelector(
      [WD.appShell, WD.formContainer, "[data-automation-id]"].join(", "),
      { timeout: 30_000 }
    );
    // Additional settle time for React to fully render interactive elements
    await page.waitForTimeout(2000);
  }

  /**
   * Detect and dismiss account creation or sign-in modal that Workday
   * sometimes presents before showing the application form.
   */
  private async _dismissAccountModal(page: Page): Promise<void> {
    // Check for sign-in/create-account modal
    const modal = await page.$(
      "div[data-automation-id='signinPopup'], [aria-label*='Sign In to Workday'], " +
      "[role='dialog'][aria-label*='account'], [data-automation-id='wd-popup-content']"
    );

    if (!modal) return;

    logger.info("workday_account_modal_detected_attempting_dismiss");

    // Try "Continue without signing in" / "Apply as Guest" variants first
    for (const sel of WD.continueAsGuestBtn) {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click();
        await page.waitForTimeout(1500);
        logger.info("workday_account_modal_dismissed_via_guest_button");
        return;
      }
    }

    // Try generic close/dismiss
    for (const sel of WD.dismissModalBtn) {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click();
        await page.waitForTimeout(1500);
        logger.info("workday_account_modal_dismissed_via_close_button");
        return;
      }
    }

    // Press Escape as last resort
    await page.keyboard.press("Escape");
    await page.waitForTimeout(1000);
    logger.warn("workday_account_modal_escape_fallback_attempted");
  }

  /**
   * Detect the current Workday wizard section from visible heading text.
   */
  private async _detectCurrentSection(page: Page): Promise<WorkdaySection> {
    try {
      const headingEl = await page.$(WD.sectionHeading);
      if (!headingEl) return "unknown";

      const text = (await headingEl.textContent() ?? "").toLowerCase();

      if (text.includes("my information") || text.includes("personal info")) {
        return "my_information";
      }
      if (text.includes("my experience") || text.includes("experience")) {
        return "my_experience";
      }
      if (text.includes("application") || text.includes("questions") || text.includes("screening")) {
        return "application_questions";
      }
      if (
        text.includes("voluntary") ||
        text.includes("self identify") ||
        text.includes("self-identify") ||
        text.includes("eeo") ||
        text.includes("equal opportunity")
      ) {
        return "voluntary_disclosures";
      }
      if (text.includes("review") || text.includes("submit")) {
        return "review";
      }
    } catch {
      // ignore — return unknown
    }
    return "unknown";
  }

  /**
   * Click the "Next" button to advance to the next wizard section.
   */
  private async _clickNext(page: Page): Promise<void> {
    for (const sel of WD.nextBtn) {
      const btn = await page.$(sel);
      if (btn) {
        const isDisabled = await btn.getAttribute("disabled");
        if (isDisabled) {
          logger.warn("workday_next_button_disabled_may_have_validation_errors");
        }
        await btn.click();
        return;
      }
    }

    // Fallback: look for any visible button with Next-like text
    const clicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      const next = btns.find((b) => {
        const text = (b.textContent ?? "").trim().toLowerCase();
        return (text === "next" || text === "continue" || text === "save and continue") &&
          !b.disabled;
      });
      if (next) { next.click(); return true; }
      return false;
    });

    if (!clicked) {
      throw new Error("Next button not found — cannot advance Workday wizard");
    }
  }

  /**
   * Wait for the next Workday section to finish rendering after clicking Next.
   */
  private async _waitForNextSection(page: Page): Promise<void> {
    // Wait for a brief period then wait for network quiet
    await page.waitForTimeout(1500);
    // Wait for any loading spinner to disappear
    try {
      await page.waitForSelector(
        "[data-automation-id='spinner'], .wd-spinner",
        { state: "hidden", timeout: 10_000 }
      );
    } catch {
      // No spinner present — that's fine
    }
    await page.waitForTimeout(1000);
  }

  /**
   * Navigate through all remaining Workday wizard sections, filling what
   * can be reliably automated: work authorization, EEO, and advancing
   * through unknown sections. Stops when Review section is reached.
   */
  private async _navigateThroughSections(page: Page, ctx: RunContext): Promise<void> {
    const MAX_SECTIONS = 10; // Safety limit — prevents infinite loops
    let sectionCount = 0;

    while (sectionCount < MAX_SECTIONS) {
      sectionCount++;
      const section = await this._detectCurrentSection(page);
      logger.info("workday_section_processing", {
        job_key: ctx.jobKey,
        section,
        count: sectionCount,
      });

      // We've reached Review — stop navigating
      if (section === "review") {
        logger.info("workday_reached_review_section", { job_key: ctx.jobKey });
        return;
      }

      // Section-specific handling
      if (section === "my_information") {
        await this._fillPersonalInfoFields(page, ctx);
      }

      if (section === "application_questions") {
        await this._handleApplicationQuestions(page, ctx);
      }

      if (section === "voluntary_disclosures") {
        await this._handleEEOSection(page, ctx);
      }

      // For unknown or experience sections: advance — Kevin completes at review_checkpoint
      logger.info("workday_section_screenshot_captured", {
        job_key: ctx.jobKey,
        section,
      });

      // Attempt to advance to next section
      try {
        await this._clickNext(page);
        await this._waitForNextSection(page);
      } catch (err) {
        // Next click failed — we may have a validation error or reached the end
        logger.warn("workday_next_failed_checking_for_review", {
          job_key: ctx.jobKey,
          error: toMessage(err),
        });

        // Check if we're now on review despite the error
        const currentSection = await this._detectCurrentSection(page);
        if (currentSection === "review") return;

        // Check for validation errors on the page
        const hasErrors = await this._checkForValidationErrors(page);
        if (hasErrors) {
          logger.warn("workday_validation_errors_detected_pausing", {
            job_key: ctx.jobKey,
          });
          // Stop navigating — Kevin will see errors at review_checkpoint
          return;
        }

        // Unknown next-failure — stop and let review_checkpoint handle it
        return;
      }
    }

    logger.warn("workday_section_navigation_max_reached", { job_key: ctx.jobKey });
  }

  // ── Private: Field filling ─────────────────────────────────────────────────

  /**
   * Fill personal information fields present in the current section.
   * Safe to call multiple times — fields not present are skipped gracefully.
   */
  private async _fillPersonalInfoFields(page: Page, ctx: RunContext): Promise<void> {
    const { applicant } = ctx;

    await this._fillField(page, WD.firstName, applicant.firstName, { optional: true });
    await this._fillField(page, WD.lastName, applicant.lastName, { optional: true });
    await this._fillField(page, WD.email as unknown as string[], applicant.email, { optional: true });
    await this._fillField(page, WD.phone as unknown as string[], applicant.phone, { optional: true });

    if (applicant.linkedinUrl) {
      await this._fillField(page, WD.linkedIn as unknown as string[], applicant.linkedinUrl, { optional: true });
    }

    // Address fields — optional and often not shown
    await this._fillField(page, WD.city as unknown as string[], applicant.locationCity, { optional: true });

    logger.info("workday_personal_info_filled", { job_key: ctx.jobKey });
  }

  /**
   * Handle Application Questions section:
   * - Work authorization (legally authorized = YES, sponsorship = NO)
   * - Any other radio/checkbox questions we can safely answer
   * - Leave open-text questions blank for Kevin
   */
  private async _handleApplicationQuestions(page: Page, ctx: RunContext): Promise<void> {
    // Work authorization: "Are you legally authorized to work in [country]?"
    await this._fillWorkAuthorization(page, ctx);

    // Handle any yes/no radio questions that indicate willingness to relocate, etc.
    // Strategy: leave ambiguous questions alone — Kevin answers at review_checkpoint.

    logger.info("workday_application_questions_handled", { job_key: ctx.jobKey });
  }

  /**
   * Answer work authorization questions.
   * "Legally authorized to work" → YES
   * "Require sponsorship" → NO
   * These are required fields and must be answered for the form to advance.
   */
  private async _fillWorkAuthorization(page: Page, ctx: RunContext): Promise<void> {
    // Workday work auth is typically rendered as two fieldsets with radio buttons.
    // We detect the question text and select the appropriate radio.

    const radioGroups = await page.$$("fieldset, [role='radiogroup']");

    for (const group of radioGroups) {
      const label = (await group.textContent() ?? "").toLowerCase();

      const isLegalAuth =
        label.includes("legally authorized") ||
        label.includes("legal authorization") ||
        label.includes("authorized to work");

      const isSponsorship =
        label.includes("sponsorship") ||
        label.includes("visa") ||
        label.includes("work authorization sponsor");

      if (isLegalAuth) {
        // Select YES — legally authorized
        await this._selectRadioInGroup(group, ["yes", "y"]);
        logger.info("workday_work_auth_answered_yes", { job_key: ctx.jobKey });
      } else if (isSponsorship) {
        // Select NO — does not require sponsorship
        await this._selectRadioInGroup(group, ["no", "n"]);
        logger.info("workday_sponsorship_answered_no", { job_key: ctx.jobKey });
      }
    }
  }

  /**
   * Select a radio button within a fieldset/radiogroup by matching label text.
   */
  private async _selectRadioInGroup(
    groupEl: Awaited<ReturnType<Page["$"]>>,
    targetLabels: string[]
  ): Promise<void> {
    if (!groupEl) return;

    const radios = await groupEl.$$("input[type='radio'], [role='radio']");
    for (const radio of radios) {
      // Get the label for this radio — may be via aria-label, adjacent label, or parent text
      const radioId = await radio.getAttribute("id");
      let labelText = await radio.getAttribute("aria-label") ?? "";

      if (!labelText && radioId) {
        // Look for associated <label> element
        const label = await groupEl.$(`label[for='${radioId}']`);
        if (label) {
          labelText = await label.textContent() ?? "";
        }
      }

      if (!labelText) {
        // Try parent element text
        labelText = await radio.evaluate((el) => {
          const parent = el.parentElement;
          return parent?.textContent ?? "";
        });
      }

      const normalized = labelText.trim().toLowerCase();
      if (targetLabels.some((t) => normalized.startsWith(t) || normalized === t)) {
        await radio.click();
        return;
      }
    }
  }

  /**
   * Handle EEO / Voluntary Self-Identification section.
   * Select "Decline to self-identify" / "I do not wish to answer" equivalents
   * for all demographic questions.
   */
  private async _handleEEOSection(page: Page, ctx: RunContext): Promise<void> {
    // Handle select dropdowns
    const selects = await page.$$("select");
    for (const select of selects) {
      const options = await select.$$("option");
      for (const opt of options) {
        const text = (await opt.textContent() ?? "").toLowerCase();
        if (
          text.includes("decline") ||
          text.includes("prefer not") ||
          text.includes("do not wish") ||
          text.includes("choose not") ||
          text.includes("no answer") ||
          text.includes("i don't wish")
        ) {
          const val = await opt.getAttribute("value");
          if (val) {
            await select.selectOption(val);
            break;
          }
        }
      }
    }

    // Handle Workday-style custom dropdown components (not native <select>)
    // These use [data-automation-id="selectWidget"] with an expandable list.
    const wdDropdowns = await page.$$("[data-automation-id='selectWidget']");
    for (const dropdown of wdDropdowns) {
      try {
        // Open the dropdown
        await dropdown.click();
        await page.waitForTimeout(500);

        // Look for a "decline" option in the expanded list
        const listItems = await page.$$("[data-automation-id='promptOption'], [role='option']");
        for (const item of listItems) {
          const text = (await item.textContent() ?? "").toLowerCase();
          if (
            text.includes("decline") ||
            text.includes("prefer not") ||
            text.includes("do not wish") ||
            text.includes("choose not")
          ) {
            await item.click();
            await page.waitForTimeout(300);
            break;
          }
        }
      } catch {
        // Ignore individual dropdown failures — best-effort
      }
    }

    logger.info("workday_eeo_section_handled", { job_key: ctx.jobKey });
  }

  // ── Private: Resume upload ─────────────────────────────────────────────────

  /**
   * Upload the resume to the Workday file upload component.
   * Returns true if upload was attempted, false if no upload widget found.
   *
   * Workday V1 uses a hidden file input approach. If that fails, we log a
   * warning — Kevin can upload manually at review_checkpoint.
   */
  private async _uploadResume(page: Page, ctx: RunContext): Promise<boolean> {
    if (!ctx.applicant.resumeUrl) {
      logger.warn("workday_no_resume_url", { job_key: ctx.jobKey });
      return false;
    }

    // Find file input — may be hidden behind a drag-drop zone
    let inputHandle = null;
    for (const sel of WD.fileUploadInput) {
      inputHandle = await page.$(sel);
      if (inputHandle) break;
    }

    if (!inputHandle) {
      // Try looking inside the drop zone
      const dropZone = await page.$(WD.fileDropZone);
      if (dropZone) {
        inputHandle = await dropZone.$("input[type='file']");
      }
    }

    if (!inputHandle) {
      logger.warn("workday_file_input_not_found", { job_key: ctx.jobKey });
      return false;
    }

    // Make input accessible — Workday often hides it behind a styled overlay
    await page.evaluate((el) => {
      const input = el as HTMLInputElement;
      input.style.display = "block";
      input.style.visibility = "visible";
      input.style.opacity = "1";
      input.style.position = "static";
      input.style.width = "auto";
      input.style.height = "auto";
    }, inputHandle);

    // Download resume buffer from R2
    const resumeResponse = await axios.get<Buffer>(ctx.applicant.resumeUrl, {
      responseType: "arraybuffer",
      timeout: 30_000,
    });

    const fileName =
      path.basename(new URL(ctx.applicant.resumeUrl).pathname) || "resume.docx";
    const mimeType = ctx.applicant.resumeUrl.endsWith(".pdf")
      ? "application/pdf"
      : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

    await inputHandle.setInputFiles({
      name: fileName,
      mimeType,
      buffer: Buffer.from(resumeResponse.data),
    });

    // Wait for Workday to process the upload and any resume-parse triggered by it
    await page.waitForTimeout(3000);

    logger.info("workday_resume_uploaded", {
      job_key: ctx.jobKey,
      file: fileName,
    });

    return true;
  }

  // ── Private: Submit with verification (Decision 8) ────────────────────────

  /**
   * Submit the Workday form and verify the result.
   * Decision 8: visual confirmation evaluation.
   *
   * V1 implementation: URL/body-text confirmation detection (same approach as Lever).
   * V2 upgrade path: replace confirmation check with Claude Haiku vision evaluation.
   */
  private async _submitAndVerify(
    page: Page,
    ctx: RunContext
  ): Promise<AdapterResult> {
    // Find the submit button (may be labeled "Submit Application" or "Apply")
    let submitClicked = false;
    for (const sel of WD.submitBtn) {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click();
        submitClicked = true;
        logger.info("workday_submit_clicked", { job_key: ctx.jobKey });
        break;
      }
    }

    if (!submitClicked) {
      // Final fallback — text-based button search
      submitClicked = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const submit = btns.find((b) => {
          const text = (b.textContent ?? "").trim().toLowerCase();
          return (
            text.includes("submit") ||
            text.includes("apply") ||
            text.includes("send application")
          ) && !b.disabled;
        });
        if (submit) { submit.click(); return true; }
        return false;
      });
    }

    if (!submitClicked) {
      throw new Error("Submit button not found on Workday Review page");
    }

    // Wait for confirmation — Workday redirects to a thank-you page
    await page.waitForFunction(
      () => {
        const url = window.location.href;
        const body = document.body.innerText.toLowerCase();
        return (
          url.includes("confirmation") ||
          url.includes("thank") ||
          url.includes("submitted") ||
          body.includes("application has been submitted") ||
          body.includes("thank you for applying") ||
          body.includes("thanks for applying") ||
          body.includes("successfully submitted") ||
          body.includes("application received") ||
          body.includes("your application has been received")
        );
      },
      { timeout: 45_000 }  // Workday can be slow to confirm
    ).catch(() => {
      // Timeout — may have submitted or may have been blocked. Screenshot will tell.
      logger.warn("workday_confirmation_wait_timed_out", { job_key: ctx.jobKey });
    });

    await page.waitForTimeout(2000);

    const confirmationUrl = page.url();
    const confirmationScreenshot = await this._screenshot(page);

    // Decision 8 V1: visual check via page text
    // V2: replace with Claude Haiku vision API call
    const confirmed = await this._evaluateConfirmation(page);

    if (!confirmed) {
      throw new Error(
        "Workday submission confirmation not detected — possible bot-detection or validation failure. " +
        "See confirmation screenshot for details."
      );
    }

    logger.info("workday_submission_confirmed", {
      job_key: ctx.jobKey,
      confirmation_url: confirmationUrl,
    });

    return {
      submitted: true,
      confirmationUrl,
      confirmationScreenshotUrl: confirmationScreenshot,
    };
  }

  /**
   * Evaluate whether the current page shows a genuine submission confirmation.
   *
   * Decision 8 V1: text-based heuristic.
   * V2 upgrade: call Claude Haiku vision API with the page screenshot.
   * Conservative bias: only returns true on unambiguous confirmation signals.
   */
  private async _evaluateConfirmation(page: Page): Promise<boolean> {
    return page.evaluate(() => {
      const body = document.body.innerText.toLowerCase();
      const url = window.location.href.toLowerCase();

      const positiveSignals = [
        body.includes("application has been submitted"),
        body.includes("thank you for applying"),
        body.includes("thanks for applying"),
        body.includes("successfully submitted"),
        body.includes("application received"),
        body.includes("your application has been received"),
        body.includes("we've received your application"),
        body.includes("we have received your application"),
        url.includes("confirmation"),
        url.includes("thank-you"),
        url.includes("submitted"),
      ];

      // Require at least one unambiguous positive signal
      return positiveSignals.some(Boolean);
    });
  }

  /**
   * Check whether the current page has visible validation errors
   * that would prevent advancing to the next section.
   */
  private async _checkForValidationErrors(page: Page): Promise<boolean> {
    return page.evaluate(() => {
      const errors = document.querySelectorAll(
        "[data-automation-id='errorMessage'], .error-message, " +
        "[role='alert']:not([aria-hidden='true']), .wd-errorText"
      );
      return errors.length > 0;
    });
  }

  // ── Private: Shared utilities ──────────────────────────────────────────────

  private async _fillField(
    page: Page,
    selectors: readonly string[] | string[],
    value: string,
    options: { optional?: boolean } = {}
  ): Promise<boolean> {
    if (!value && options.optional) return false;

    for (const sel of selectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          // Workday fields may need to be triggered to activate React event handlers
          await el.click({ clickCount: 3 });
          await el.fill(value);
          // Trigger input/change events for React state update
          await el.dispatchEvent("input");
          await el.dispatchEvent("change");
          return true;
        }
      } catch {
        continue;
      }
    }

    if (!options.optional) {
      throw new Error(
        `Required field not found. Tried selectors: ${[...selectors].join(", ")}`
      );
    }
    return false;
  }

  private async _captureFormData(page: Page): Promise<Record<string, unknown>> {
    return page.evaluate(() => {
      const data: Record<string, string> = {};
      const inputs = document.querySelectorAll<HTMLInputElement>(
        "input:not([type='hidden']):not([type='file']), textarea, select"
      );
      inputs.forEach((el) => {
        const name =
          el.getAttribute("data-automation-id") ||
          el.name ||
          el.id ||
          el.getAttribute("aria-label") ||
          el.getAttribute("placeholder") ||
          "unknown";
        if (el instanceof HTMLSelectElement) {
          data[name] = el.options[el.selectedIndex]?.text ?? "";
        } else if (el instanceof HTMLInputElement && el.type === "checkbox") {
          data[name] = el.checked ? "checked" : "unchecked";
        } else {
          data[name] = (el as HTMLInputElement | HTMLTextAreaElement).value;
        }
      });
      return data;
    });
  }

  private async _screenshot(page: Page): Promise<string> {
    try {
      const buf = await page.screenshot({ type: "png", fullPage: false });
      return `data:image/png;base64,${buf.toString("base64")}`;
    } catch {
      return "";
    }
  }
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
