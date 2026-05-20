/**
 * Greenhouse ATS adapter.
 *
 * Handles the standard Greenhouse job application form at:
 *   boards.greenhouse.io/[company]/jobs/[id]
 *
 * Step sequence:
 *   navigate → fill_personal_info → upload_resume → fill_questions
 *   → review_checkpoint (pause for Kevin's approval) → submit → confirm
 *
 * Greenhouse form structure is consistent across employers but has
 * optional custom question sections — the adapter handles both required
 * fields and optional extras gracefully.
 *
 * Design notes:
 *   - Each step wraps its work in try/catch and calls ctx.onStepFail
 *     before re-throwing, so the runner captures the step-level failure.
 *   - Screenshot URLs are base64 data URIs for now (no external storage yet).
 *     Task 40 / cloud storage migration will replace these with R2 URLs.
 *   - The adapter does NOT submit — it pauses at review_checkpoint so
 *     Kevin can verify the form before submission.
 */

import axios from "axios";
import path from "path";
import type { Page } from "playwright-core";
import type { ATSAdapter, AdapterResult, RunContext } from "../types.js";
import { logger } from "../logger.js";

export class GreenhouseAdapter implements ATSAdapter {
  readonly platform = "greenhouse";

  canHandle(atsUrl: string): boolean {
    return (
      atsUrl.includes("boards.greenhouse.io") ||
      atsUrl.includes("greenhouse.io/application")
    );
  }

  async run(page: Page, ctx: RunContext): Promise<AdapterResult> {
    // ── Step 1: Navigate ──────────────────────────────────────────────────
    await ctx.onStepStart("navigate");
    try {
      await page.goto(ctx.atsUrl, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#application_form, form[data-role='application']", {
        timeout: 20_000,
      });
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

    // ── Step 4: Fill custom questions ────────────────────────────────────
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

    // ── Step 5: Review checkpoint ─────────────────────────────────────────
    // Capture the fully filled form and pause. Kevin reviews and approves
    // before the form is submitted.
    await ctx.onStepStart("review_checkpoint");
    const reviewScreenshot = await this._screenshot(page);
    const formData = await this._captureFormData(page);

    await ctx.onReviewCheckpoint(reviewScreenshot, formData);

    // Pause here — return awaitingApproval so the runner knows not to submit.
    return { submitted: false, awaitingApproval: true };
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private async _fillPersonalInfo(page: Page, ctx: RunContext): Promise<void> {
    const { applicant } = ctx;

    // First name
    await this._fillField(page, [
      "#first_name",
      "input[name='job_application[first_name]']",
    ], applicant.firstName);

    // Last name
    await this._fillField(page, [
      "#last_name",
      "input[name='job_application[last_name]']",
    ], applicant.lastName);

    // Email
    await this._fillField(page, [
      "#email",
      "input[name='job_application[email]']",
    ], applicant.email);

    // Phone (optional — skip if field not present)
    await this._fillField(page, [
      "#phone",
      "input[name='job_application[phone]']",
    ], applicant.phone, { optional: true });

    // Location — Greenhouse may show an autocomplete
    const locationSelectors = [
      "#job_application_location",
      "input[name='job_application[location]']",
      "input[placeholder*='City']",
      "input[placeholder*='Location']",
    ];
    const locationValue = `${applicant.locationCity}, ${applicant.locationState}`;
    await this._fillField(page, locationSelectors, locationValue, { optional: true });

    // LinkedIn URL (optional)
    if (applicant.linkedinUrl) {
      await this._fillField(page, [
        "input[name*='linkedin']",
        "input[placeholder*='LinkedIn']",
      ], applicant.linkedinUrl, { optional: true });
    }
  }

  private async _uploadResume(page: Page, ctx: RunContext): Promise<void> {
    if (!ctx.applicant.resumeUrl) {
      logger.warn("no_resume_url_configured", { job_key: ctx.jobKey });
      return;
    }

    // Greenhouse resume upload is typically a file input that may be hidden.
    // We expose it and set the file via URL download + Playwright's setInputFiles.
    const resumeInputSelectors = [
      "input[type='file'][name*='resume']",
      "input[type='file'][id*='resume']",
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

    // Make the file input visible if hidden (Greenhouse often hides it)
    await page.evaluate((el) => {
      (el as HTMLElement).style.display = "block";
      (el as HTMLElement).style.visibility = "visible";
      (el as HTMLElement).style.opacity = "1";
    }, inputHandle);

    // Download the resume and pass as a buffer to setInputFiles
    const resumeResponse = await axios.get<Buffer>(ctx.applicant.resumeUrl, {
      responseType: "arraybuffer",
    });
    const fileName = path.basename(new URL(ctx.applicant.resumeUrl).pathname) || "resume.pdf";
    const mimeType = ctx.applicant.resumeUrl.endsWith(".docx")
      ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      : "application/pdf";

    await inputHandle.setInputFiles({
      name: fileName,
      mimeType,
      buffer: Buffer.from(resumeResponse.data),
    });

    // Wait briefly for upload confirmation UI
    await page.waitForTimeout(2000);
  }

  private async _fillCustomQuestions(page: Page, ctx: RunContext): Promise<void> {
    // Greenhouse custom questions are inside div.field elements.
    // We handle the most common question patterns:
    //   - Text inputs (short answer)
    //   - Textareas (long answer)
    //   - Select dropdowns (yes/no, demographic questions)
    //   - Checkboxes (consent, EEOC)

    // Demographic / EEOC questions — answer with "Decline to self-identify"
    // or the equivalent "prefer not to say" option where available.
    const selectFields = await page.$$("select[name*='job_application']");
    for (const select of selectFields) {
      const name = await select.getAttribute("name") ?? "";
      const isDemographic =
        name.includes("gender") ||
        name.includes("race") ||
        name.includes("veteran") ||
        name.includes("disability") ||
        name.includes("eeoc");

      if (isDemographic) {
        // Prefer "Decline to self-identify" or similar option
        const options = await select.$$("option");
        for (const opt of options) {
          const text = (await opt.textContent() ?? "").toLowerCase();
          if (
            text.includes("decline") ||
            text.includes("prefer not") ||
            text.includes("i don't wish") ||
            text.includes("no answer")
          ) {
            const value = await opt.getAttribute("value");
            if (value) {
              await select.selectOption(value);
            }
            break;
          }
        }
      }
    }

    // Required text fields that aren't personal info — leave blank for now.
    // Kevin can fill these at the review_checkpoint.
    // A future improvement: extract required questions and send them to Claude
    // for suggested answers based on the JD extraction.
    logger.info("custom_questions_processed", { job_key: ctx.jobKey });
  }

  private async _captureFormData(page: Page): Promise<Record<string, unknown>> {
    // Capture all current form field values for review_checkpoint display
    return page.evaluate(() => {
      const data: Record<string, string> = {};
      const inputs = document.querySelectorAll<HTMLInputElement>(
        "input:not([type='hidden']):not([type='file']), textarea, select"
      );
      inputs.forEach((el) => {
        const name = el.name || el.id || el.placeholder || "unknown";
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

  private async _fillField(
    page: Page,
    selectors: string[],
    value: string,
    options: { optional?: boolean } = {}
  ): Promise<void> {
    if (!value && options.optional) return;

    let filled = false;
    for (const sel of selectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          await el.click({ clickCount: 3 }); // select all
          await el.type(value, { delay: 30 });
          filled = true;
          break;
        }
      } catch {
        continue;
      }
    }

    if (!filled && !options.optional) {
      throw new Error(
        `Required field not found. Tried selectors: ${selectors.join(", ")}`
      );
    }
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
