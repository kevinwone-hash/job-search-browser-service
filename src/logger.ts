/**
 * Structured logger using winston.
 * All log output is JSON in production for Railway log aggregation.
 */

import winston from "winston";
import { config } from "./config.js";

export const logger = winston.createLogger({
  level: config.logLevel,
  format:
    config.nodeEnv === "production"
      ? winston.format.combine(winston.format.timestamp(), winston.format.json())
      : winston.format.combine(
          winston.format.timestamp(),
          winston.format.colorize(),
          winston.format.printf(({ timestamp, level, message, ...meta }) => {
            const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
            return `${timestamp} ${level}: ${message}${metaStr}`;
          })
        ),
  transports: [new winston.transports.Console()],
});
