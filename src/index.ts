/**
 * AI Operations OS — Browser Service
 *
 * Express HTTP server exposing the browser automation trigger endpoint.
 * All form automation runs asynchronously — HTTP responds immediately (202)
 * and the session runs in the background.
 *
 * Routes:
 *   GET  /health            → health check (public)
 *   POST /run               → trigger a browser session for a job (ATS form fill)
 *   GET  /sessions          → list currently active sessions
 *   GET  /adapters          → list registered ATS adapters
 *   POST /discovery/run     → trigger a Google Jobs discovery run (Decision 44)
 *   GET  /discovery/status  → check if a discovery run is currently active (public)
 */

import express, { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { runSession, isSessionActive } from "./runner.js";
import { adapterRegistry } from "./adapters/registry.js";
import { runDiscovery } from "./discovery/google-jobs-runner.js";
import type { RunResponse } from "./types.js";
import type { DiscoveryRunResponse } from "./discovery/types.js";

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

// ── Google Jobs discovery (Decision 44) ───────────────────────────────────
//
// Decision 46: max 2 runs/day/domain — enforced by APScheduler on job-search-os.
// The activeDiscoveryRun guard here prevents stacked concurrent runs if the
// scheduler fires twice (e.g., Railway restart + scheduled fire).
//
// APScheduler is DISABLED until a manual end-to-end validation run confirms
// the full pipeline: /discovery/run → Browserbase → /ingest/discovery → /review.

let activeDiscoveryRun = false;

app.get("/discovery/status", (_req: Request, res: Response) => {
  res.json({ active: activeDiscoveryRun });
});

const DiscoveryRunRequestSchema = z.object({
  // Optional diagnostic override — runs only these queries instead of DISCOVERY_QUERIES.
  // Use for single-query extraction diagnostics without touching the production query set.
  diagnostic_queries: z.array(z.string().min(1)).optional(),
});

app.post("/discovery/run", requireApiKey, (req: Request, res: Response) => {
  if (activeDiscoveryRun) {
    const response: DiscoveryRunResponse = {
      runId: "",
      status: "already_running",
      message: "A discovery run is already in progress — try again after it completes",
    };
    res.status(409).json(response);
    return;
  }

  const parsed = DiscoveryRunRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(422).json({ error: "Invalid request", details: parsed.error.errors });
    return;
  }

  const runId = `dr_${Date.now().toString(36)}`;
  const { diagnostic_queries } = parsed.data;
  activeDiscoveryRun = true;

  // Fire async — do not await. Mirrors the /run pattern for ATS sessions.
  runDiscovery(runId, diagnostic_queries)
    .catch((err: unknown) => {
      logger.error("unhandled_discovery_error", {
        run_id: runId,
        error: err instanceof Error ? err.message : String(err),
      });
    })
    .finally(() => {
      activeDiscoveryRun = false;
      logger.info("discovery_run_flag_cleared", { run_id: runId });
    });

  logger.info("discovery_run_triggered", {
    run_id: runId,
    diagnostic: !!diagnostic_queries,
    query_count: diagnostic_queries?.length ?? "production",
  });

  const response: DiscoveryRunResponse = {
    runId,
    status: "started",
    message: diagnostic_queries
      ? `Diagnostic run started (${diagnostic_queries.length} quer${diagnostic_queries.length === 1 ? "y" : "ies"}). Monitor via GET /discovery/status and Railway logs.`
      : "Discovery run started. Monitor via GET /discovery/status and platform_state keys.",
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
