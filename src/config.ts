/**
 * Environment configuration — validated at startup via Zod.
 * Fail fast if required vars are missing rather than hitting runtime errors mid-session.
 */

import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const configSchema = z.object({
  // Browserbase
  browserbaseApiKey: z.string().min(1, "BROWSERBASE_API_KEY is required"),
  browserbaseProjectId: z.string().min(1, "BROWSERBASE_PROJECT_ID is required"),

  // FastAPI job-search-os
  jobSearchApiUrl: z
    .string()
    .url()
    .default("https://job-search-os-production.up.railway.app"),
  jobSearchApiKey: z.string().min(1, "JOB_SEARCH_API_KEY is required"),

  // Service
  port: z.coerce.number().default(3001),
  nodeEnv: z.enum(["development", "production", "test"]).default("production"),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),

  // Applicant personal info (used by ATS form filler)
  applicantFirstName: z.string().default("Kevin"),
  applicantLastName: z.string().default("Watson"),
  applicantEmail: z.string().email().default("kevinwone@gmail.com"),
  applicantPhone: z.string().default(""),
  applicantLinkedinUrl: z.string().default(""),
  applicantLocationCity: z.string().default("Atlanta"),
  applicantLocationState: z.string().default("GA"),
  applicantLocationCountry: z.string().default("United States"),

  // Resume URL (must be publicly accessible for Browserbase to upload)
  resumeUrl: z.string().default(""),
});

function loadConfig() {
  const result = configSchema.safeParse({
    browserbaseApiKey: process.env.BROWSERBASE_API_KEY,
    browserbaseProjectId: process.env.BROWSERBASE_PROJECT_ID,
    jobSearchApiUrl: process.env.JOB_SEARCH_API_URL,
    jobSearchApiKey: process.env.JOB_SEARCH_API_KEY,
    port: process.env.PORT,
    nodeEnv: process.env.NODE_ENV,
    logLevel: process.env.LOG_LEVEL,
    applicantFirstName: process.env.APPLICANT_FIRST_NAME,
    applicantLastName: process.env.APPLICANT_LAST_NAME,
    applicantEmail: process.env.APPLICANT_EMAIL,
    applicantPhone: process.env.APPLICANT_PHONE,
    applicantLinkedinUrl: process.env.APPLICANT_LINKEDIN_URL,
    applicantLocationCity: process.env.APPLICANT_LOCATION_CITY,
    applicantLocationState: process.env.APPLICANT_LOCATION_STATE,
    applicantLocationCountry: process.env.APPLICANT_LOCATION_COUNTRY,
    resumeUrl: process.env.RESUME_URL,
  });

  if (!result.success) {
    const errors = result.error.errors.map((e) => `  ${e.path.join(".")}: ${e.message}`).join("\n");
    throw new Error(`Configuration error — check environment variables:\n${errors}`);
  }

  return result.data;
}

export const config = loadConfig();

export type Config = typeof config;
