/**
 * AI Operations OS — Browser Service
 *
 * Express HTTP server exposing the browser automation trigger endpoint.
 * All form automation runs asynchronously — HTTP responds immediately (202)
 * and the session runs in the background.
 *
 * Routes:
 *   GET  /health       → health check (public)
 *   POST /run          → trigger a browser session for a job
 *   GET  /sessions     → list currently active sessions
 *   GET  /adapters     → list registered ATS adapters
 */

import express, { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { runSession, isSessionActive } from "./runner.js";
import { adapterRegistry } from "./adapters/registry.js";
import type { RunResponse } from "./types.js";

const app = express();
app.use(express.json());

// ── API key authentication ─────────────────────────────────────────────────

function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const key = req.headers["x-api-key"];
  if (!key || key !== config.jobSearchApiKey) {
    res.status(401).json({ error: "Invalid or missing API key" });
    return;
  }
  next();
}

// ── Health check (public) ──────────────────────────────────────────────────

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "browser-service",
    environment: config.nodeEnv,
    adapters: adapterRegistry.list(),
  });
});

// ── List adapters (public) ─────────────────────────────────────────────────

app.get("/adapters", (_req: Request, res: Response) => {
  res.json({ adapters: adapterRegistry.list() });
});

// ── List active sessions (authenticated) ──────────────────────────────────

app.get("/sessions", requireApiKey, (_req: Request, res: Response) => {
  // activeSessions is internal to runner — expose via a status check
  res.json({ message: "Use GET /health for service status" });
});

// ── Trigger a browser session (authenticated) ──────────────────────────────

const RunRequestSchema = z.object({
  job_key: z.string().min(1),
  workflow_id: z.string().min(1),
  ats_url: z.string().url().optional(),
  resume_url: z.string().url().optional(),
  // Per-job tailored resume URL — overrides RESUME_URL env var for this session.
  // Should be a public R2 URL pointing to the tailored DOCX for this job.
  auto_submit: z.boolean().default(false),
});

app.post("/run", requireApiKey, (req: Request, res: Response) => {
  const parsed = RunRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({
      error: "Invalid request",
      details: parsed.error.errors,
    });
    return;
  }

  const { job_key, workflow_id, ats_url, resume_url, auto_submit } = parsed.data;

  // Guard: prevent duplicate sessions
  if (isSessionActive(job_key)) {
    const response: RunResponse = {
      job_key,
      workflow_id,
      status: "already_running",
      message: `A session is already active for job ${job_key}`,
    };
    res.status(409).json(response);
    return;
  }

  // Fire the session asynchronously — do not await
  runSession(job_key, workflow_id, ats_url, resume_url, auto_submit).catch((err: unknown) => {
    logger.error("unhandled_session_error", {
      job_key,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  logger.info("session_triggered", { job_key, workflow_id });

  const response: RunResponse = {
    job_key,
    workflow_id,
    status: "started",
    message: "Browser session started. Monitor progress via the workflow API.",
  };
  res.status(202).json(response);
});

// ── Error handler ──────────────────────────────────────────────────────────

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : "Internal server error";
  logger.error("unhandled_error", { error: message });
  res.status(500).json({ error: message });
});

// ── Start server ───────────────────────────────────────────────────────────

app.listen(config.port, () => {
  logger.info("browser_service_started", {
    port: config.port,
    environment: config.nodeEnv,
    adapters: adapterRegistry.list(),
  });
});

export default app;
