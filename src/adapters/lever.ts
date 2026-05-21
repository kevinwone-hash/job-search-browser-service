/**
 * Lever ATS adapter.
 *
 * Handles Lever job application forms at:
 *   jobs.lever.co/[company]/[id]        — job posting page
 *   jobs.lever.co/[company]/[id]/apply  — application form (navigated to automatically)
 *
 * Step sequence:
 *   navigate → fill_personal_info → upload_resume → fill_questions
 *   → review_checkpoint (pause for Kevin's approval) → submit → confirm
 *
 * Lever form structure notes:
 *   - Application form is at /apply suffix on the job URL.
 *   - Standard fields use input[name="name"], input[name="email"], etc.
 *   - Resume upload is input[type="file"] within a .resume-upload or similar wrapper.
 *   - Custom/additional questions are in .application-additional-cards sections.
 *   - Demographic questions should be answered with "Decline to specify" equivalents.
 */

import axios from "axios";
import path from "path";
import type { Page } from "playwright-core";
import type { ATSAdapter, AdapterResult, RunContext } from "../types.js";
import { logger } from "../logger.js";

export class LeverAdapter implements ATSAdapter {
  readonly platform = "lever";

  canHandle(atsUrl: string): boolean {
    return (
      atsUrl.includes("jobs.lever.co") ||
      atsUrl.includes("lever.co/")
    );
  }

  async run(page: Page, ctx: RunContext): Promise<AdapterResult> {
    // ── Step 1: Navigate ──────────────────────────────────────────────────
    await ctx.onStepStart("navigate");
    try {
      // Lever application form is at /apply suffix
      const applyUrl = ctx.atsUrl.replace(/\/?$/, "") + (ctx.atsUrl.includes("/apply") ? "" : "/apply");
      await page.goto(applyUrl, { waitUntil: "domcontentloaded" });

      // Wait for the application form to be present
      await page.waitForSelector(
        "form.application-form, .posting-apply-form, form[data-qa='application-form'], .application-form",
        { timeout: 20_000 }
      );
      const screenshot = await this._screenshot(page);
      await ctx.onStepComplete("navigate", screenshot);
    } catch (err) {
      const msg = toMessage(err);
      const screenshot = await this._screenshot(page).catch(() => undefined);
      await ctx.onStepFail("navigate", msg, screenshot);
      throw err;
    }

    // ── Step 2: Fill personal info ────────────────────────────────────────
    await ctx.onStepStart("fill_personal_info");
    try {
      await this._fillPersonalInfo(page, ctx);
      const screenshot = await this._screenshot(page);
      await ctx.onStepComplete("fill_personal_info", screenshot);
    } catch (err) {
      const msg = toMessage(err);
      const screenshot = await this._screenshot(page).catch(() => undefined);
      await ctx.onStepFail("fill_personal_info", msg, screenshot);
      throw err;
    }

    // ── Step 3: Upload resume ─────────────────────────────────────────────
    await ctx.onStepStart("upload_resume");
    try {
      await this._uploadResume(page, ctx);
      const screenshot = await this._screenshot(page);
      await ctx.onStepComplete("upload_resume", screenshot);
    } catch (err) {
      const msg = toMessage(err);
      const screenshot = await this._screenshot(page).catch(() => undefined);
      await ctx.onStepFail("upload_resume", msg, screenshot);
      throw err;
    }

    // ── Step 4: Fill custom questions ─────────────────────────────────────
    await ctx.onStepStart("fill_questions");
    try {
      await this._fillCustomQuestions(page, ctx);
      const screenshot = await this._screenshot(page);
      await ctx.onStepComplete("fill_questions", screenshot);
    } catch (err) {
      const msg = toMessage(err);
      const screenshot = await this._screenshot(page).catch(() => undefined);
      await ctx.onStepFail("fill_questions", msg, screenshot);
      throw err;
    }

    // ── Step 5: Submit or pause at review checkpoint ──────────────────────
    if (ctx.autoSubmit) {
      // Auto-submit: click submit, wait for confirmation, screenshot it
      await ctx.onStepStart("submit");
      try {
        const { confirmationUrl, confirmationScreenshot } = await this._submitForm(page, ctx);
        await ctx.onStepComplete("submit", await this._screenshot(page));
        return {
          submitted: true,
          confirmationUrl,
          confirmationScreenshotUrl: confirmationScreenshot,
        };
      } catch (err) {
        const msg = toMessage(err);
        const screenshot = await this._screenshot(page).catch(() => undefined);
        await ctx.onStepFail("submit", msg, screenshot);
        throw err;
      }
    }

    // Pause at review checkpoint — Kevin approves before submission
    await ctx.onStepStart("review_checkpoint");
    const reviewScreenshot = await this._screenshot(page);
    const formData = await this._captureFormData(page);
    await ctx.onReviewCheckpoint(reviewScreenshot, formData);

    return { submitted: false, awaitingApproval: true };
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private async _fillPersonalInfo(page: Page, ctx: RunContext): Promise<void> {
    const { applicant } = ctx;

    // Lever uses a single "Full name" field OR separate first/last fields.
    // Try full name first, then fall back to separate fields.
    const fullNameFilled = await this._fillField(page, [
      "input[name='name']",
      "input[placeholder*='Full name']",
      "input[placeholder*='Name']",
      "#name",
    ], `${applicant.firstName} ${applicant.lastName}`, { optional: true });

    if (!fullNameFilled) {
      // Separate first / last name fields
      await this._fillField(page, [
        "input[name='first_name']",
        "input[placeholder*='First name']",
        "#first_name",
      ], applicant.firstName, { optional: true });

      await this._fillField(page, [
        "input[name='last_name']",
        "input[placeholder*='Last name']",
        "#last_name",
      ], applicant.lastName, { optional: true });
    }

    // Email
    await this._fillField(page, [
      "input[name='email']",
      "input[type='email']",
      "input[placeholder*='Email']",
      "#email",
    ], applicant.email);

    // Phone (optional)
    await this._fillField(page, [
      "input[name='phone']",
      "input[type='tel']",
      "input[placeholder*='Phone']",
      "#phone",
    ], applicant.phone, { optional: true });

    // Current company / org (optional — leave blank, Kevin is consulting)
    // Skip org field intentionally

    // LinkedIn URL (optional)
    if (applicant.linkedinUrl) {
      await this._fillField(page, [
        "input[name='urls[LinkedIn]']",
        "input[name='linkedin']",
        "input[placeholder*='LinkedIn']",
        "input[data-qa*='linkedin']",
      ], applicant.linkedinUrl, { optional: true });
    }

    // Location (optional — Lever often doesn't ask for this in the form)
    await this._fillField(page, [
      "input[name='location']",
      "input[placeholder*='Location']",
      "input[placeholder*='City']",
    ], `${applicant.locationCity}, ${applicant.locationState}`, { optional: true });
  }

  private async _uploadResume(page: Page, ctx: RunContext): Promise<void> {
    if (!ctx.applicant.resumeUrl) {
      logger.warn("no_resume_url_configured", { job_key: ctx.jobKey });
      return;
    }

    // Lever resume upload: file input inside a resume upload section.
    // The input is typically hidden — expose it before setting files.
    const resumeInputSelectors = [
      "input[type='file'][name*='resume']",
      "input[type='file'][data-qa*='resume']",
      ".resume-upload input[type='file']",
      "input[type='file']",
    ];

    let inputHandle = null;
    for (const sel of resumeInputSelectors) {
      inputHandle = await page.$(sel);
      if (inputHandle) break;
    }

    if (!inputHandle) {
      logger.warn("resume_input_not_found", { job_key: ctx.jobKey });
      return;
    }

    // Make visible if hidden
    await page.evaluate((el) => {
      (el as HTMLElement).style.display = "block";
      (el as HTMLElement).style.visibility = "visible";
      (el as HTMLElement).style.opacity = "1";
    }, inputHandle);

    // Download resume buffer and set on the input
    const resumeResponse = await axios.get<Buffer>(ctx.applicant.resumeUrl, {
      responseType: "arraybuffer",
    });
    const fileName =
      path.basename(new URL(ctx.applicant.resumeUrl).pathname) || "resume.docx";
    const mimeType = ctx.applicant.resumeUrl.endsWith(".docx")
      ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      : "application/pdf";

    await inputHandle.setInputFiles({
      name: fileName,
      mimeType,
      buffer: Buffer.from(resumeResponse.data),
    });

    // Wait for upload confirmation UI
    await page.waitForTimeout(2000);
  }

  private async _fillCustomQuestions(page: Page, ctx: RunContext): Promise<void> {
    // Handle Lever's "Additional information" / custom question cards.
    // Lever custom questions are in .application-additional-cards or similar.

    // EEO / demographic select fields — choose "Decline to specify" equivalents
    const selectFields = await page.$$("select");
    for (const select of selectFields) {
      const name = (await select.getAttribute("name") ?? "").toLowerCase();
      const id = (await select.getAttribute("id") ?? "").toLowerCase();
      const combined = name + id;

      const isDemographic =
        combined.includes("gender") ||
        combined.includes("race") ||
        combined.includes("ethnicity") ||
        combined.includes("veteran") ||
        combined.includes("disability") ||
        combined.includes("eeo") ||
        combined.includes("eeoc");

      if (isDemographic) {
        const options = await select.$$("option");
        for (const opt of options) {
          const text = (await opt.textContent() ?? "").toLowerCase();
          if (
            text.includes("decline") ||
            text.includes("prefer not") ||
            text.includes("i don't wish") ||
            text.includes("no answer") ||
            text.includes("choose not")
          ) {
            const value = await opt.getAttribute("value");
            if (value) await select.selectOption(value);
            break;
          }
        }
      }
    }

    // Required textarea / text fields — leave blank for Kevin to fill at review_checkpoint.
    // A future enhancement: send required questions to Claude for suggested answers.
    logger.info("custom_questions_processed", { job_key: ctx.jobKey });
  }

  private async _captureFormData(page: Page): Promise<Record<string, unknown>> {
    return page.evaluate(() => {
      const data: Record<string, string> = {};
      const inputs = document.querySelectorAll<HTMLInputElement>(
        "input:not([type='hidden']):not([type='file']), textarea, select"
      );
      inputs.forEach((el) => {
        const name = el.name || el.id || el.getAttribute("placeholder") || "unknown";
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

  /**
   * Fill a field identified by one of the given selectors.
   * Returns true if a field was found and filled, false otherwise.
   */
  private async _fillField(
    page: Page,
    selectors: string[],
    value: string,
    options: { optional?: boolean } = {}
  ): Promise<boolean> {
    if (!value && options.optional) return false;

    for (const sel of selectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          await el.click({ clickCount: 3 }); // select all existing text
          await el.type(value, { delay: 30 });
          return true;
        }
      } catch {
        continue;
      }
    }

    if (!options.optional) {
      throw new Error(
        `Required field not found. Tried selectors: ${selectors.join(", ")}`
      );
    }
    return false;
  }

  private async _submitForm(
    page: Page,
    _ctx: RunContext,
  ): Promise<{ confirmationUrl: string; confirmationScreenshot: string }> {
    // Find and click the Lever submit button
    const submitSelectors = [
      "button[type='submit']",
      "button.postings-btn[type='submit']",
      "button[data-qa='btn-submit']",
      "input[type='submit']",
    ];

    let clicked = false;
    for (const sel of submitSelectors) {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click();
        clicked = true;
        break;
      }
    }

    if (!clicked) {
      throw new Error("Submit button not found on Lever form");
    }

    // Wait for confirmation page — Lever redirects to a thank-you page
    // or shows a success message after submission
    await page.waitForFunction(
      () => {
        const url = window.location.href;
        const body = document.body.innerText.toLowerCase();
        return (
          url.includes("confirmation") ||
          url.includes("thank") ||
          body.includes("application has been submitted") ||
          body.includes("thanks for applying") ||
          body.includes("thank you for applying") ||
          body.includes("successfully submitted") ||
          body.includes("we've received your application")
        );
      },
      { timeout: 30_000 },
    ).catch(() => {
      // If the check times out, we still take a screenshot — form may have submitted
      logger.warn("lever_confirmation_check_timed_out");
    });

    // Brief pause to let the page fully render
    await page.waitForTimeout(2000);

    const confirmationUrl = page.url();
    const confirmationScreenshot = await this._screenshot(page);

    logger.info("lever_form_submitted", { confirmation_url: confirmationUrl });

    return { confirmationUrl, confirmationScreenshot };
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
