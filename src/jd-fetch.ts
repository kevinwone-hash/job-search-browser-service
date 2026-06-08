/**
 * JD Fetch — Playwright-rendered job description extraction.
 *
 * Handles React SPAs (Workday, etc.) that return empty shells to httpx.
 * Called by POST /jd/fetch in index.ts when the FastAPI extraction pipeline
 * exhausts its httpx attempt.
 *
 * Design:
 * - Opens a full Browserbase session (same infra as ATS adapters)
 * - Navigates to the URL, waits for network idle
 * - Extracts visible text from main content area
 * - No screenshots (not needed for text extraction — keeps cost down)
 * - Hard 30s timeout to bound Browserbase slot usage
 * - Generic: not Workday-only; handles any rendered page
 */

import type { Page } from "playwright-core";
import { createBrowserSession } from "./browser-session.js";
import { logger } from "./logger.js";

const MAX_TEXT_LENGTH = 8000;
const NAV_TIMEOUT_MS = 30_000;
const NETWORK_IDLE_TIMEOUT_MS = 10_000;

export interface JdFetchResult {
  ok: boolean;
  url: string;
  text?: string;
  text_length?: number;
  error?: string;
  method: "playwright_render";
}

/**
 * Render a job posting URL with Playwright and return its visible text.
 *
 * Returns JdFetchResult — never throws.
 */
export async function fetchJdRendered(url: string): Promise<JdFetchResult> {
  logger.info("jd_fetch_start", { url: url.slice(0, 80) });

  const session = await createBrowserSession();
  try {
    const page = session.page;
    page.setDefaultTimeout(NAV_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

    // Navigate and wait for network to settle
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });

    // Give SPA frameworks time to render their components
    try {
      await page.waitForLoadState("networkidle", { timeout: NETWORK_IDLE_TIMEOUT_MS });
    } catch {
      // networkidle timeout is non-fatal — proceed with whatever rendered
      logger.info("jd_fetch_networkidle_timeout", { url: url.slice(0, 80) });
    }

    const text = await extractText(page);

    if (!text || text.length < 100) {
      logger.warn("jd_fetch_insufficient_content", {
        url: url.slice(0, 80),
        text_length: text?.length ?? 0,
      });
      return {
        ok: false,
        url,
        error: "Rendered page returned insufficient text content",
        method: "playwright_render",
      };
    }

    const capped = text.slice(0, MAX_TEXT_LENGTH);
    logger.info("jd_fetch_success", { url: url.slice(0, 80), text_length: capped.length });
    return {
      ok: true,
      url,
      text: capped,
      text_length: capped.length,
      method: "playwright_render",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("jd_fetch_error", { url: url.slice(0, 80), error: message });
    return {
      ok: false,
      url,
      error: message,
      method: "playwright_render",
    };
  } finally {
    await session.close();
  }
}

/**
 * Extract meaningful text from the rendered page.
 *
 * Strategy:
 * 1. Remove noise elements (nav, header, footer, scripts)
 * 2. Prefer <main> content area
 * 3. Fall back to full body
 * 4. Collapse whitespace
 */
async function extractText(page: Page): Promise<string> {
  return page.evaluate(() => {
    // Remove noise elements that rarely contain JD content
    const noiseSelectors = [
      "script", "style", "noscript", "header", "footer",
      "nav", "aside", "iframe", "svg",
    ];
    noiseSelectors.forEach((sel) => {
      document.querySelectorAll(sel).forEach((el) => el.remove());
    });

    // Prefer main content area
    const root =
      document.querySelector("main") ||
      document.querySelector("[role='main']") ||
      document.querySelector(".job-description") ||
      document.querySelector("[class*='jobDescription']") ||
      document.querySelector("[data-automation-id='jobPostingDescription']") || // Workday
      document.body;

    if (!root) return "";

    const raw = (root as HTMLElement).innerText || "";

    // Collapse runs of whitespace / blank lines
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  });
}
