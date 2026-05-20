/**
 * Browserbase session manager.
 *
 * Wraps @browserbasehq/sdk to create and manage cloud browser sessions.
 * Returns a playwright-core Browser so adapters work identically whether
 * running against Browserbase (production) or a local Chromium (dev/test).
 *
 * PLATFORM PRIMITIVE: this module is the canonical Browser Service Layer
 * for AI Operations OS. All browser automation routes through here.
 */

import Browserbase from "@browserbasehq/sdk";
import { chromium, Browser, BrowserContext, Page } from "playwright-core";
import { config } from "./config.js";
import { logger } from "./logger.js";

export interface BrowserSession {
  sessionId: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  /** Close the session and release the Browserbase slot. */
  close: () => Promise<void>;
  /** Take a screenshot and return it as a base64 PNG string. */
  screenshot: () => Promise<string>;
}

const bb = new Browserbase({
  apiKey: config.browserbaseApiKey,
});

/**
 * Create a new Browserbase cloud browser session.
 *
 * Returns a BrowserSession with a ready-to-use Playwright page.
 * Always call session.close() in a finally block.
 */
export async function createBrowserSession(): Promise<BrowserSession> {
  logger.info("browserbase_session_creating");

  const session = await bb.sessions.create({
    projectId: config.browserbaseProjectId,
  });

  logger.info("browserbase_session_created", { session_id: session.id });

  const browser = await chromium.connectOverCDP(
    `wss://connect.browserbase.com?apiKey=${config.browserbaseApiKey}&sessionId=${session.id}`
  );

  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());

  // Reasonable defaults for form filling
  await page.setViewportSize({ width: 1280, height: 900 });
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(60_000);

  const close = async () => {
    logger.info("browserbase_session_closing", { session_id: session.id });
    try {
      await browser.close();
    } catch {
      // ignore close errors
    }
  };

  const screenshot = async (): Promise<string> => {
    const buf = await page.screenshot({ type: "png", fullPage: false });
    return buf.toString("base64");
  };

  return {
    sessionId: session.id,
    browser,
    context,
    page,
    close,
    screenshot,
  };
}
