import { pino, type Logger } from "pino";

const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "apiKey",
  "api_key",
  "token",
  "accessToken",
  "refreshToken",
  "password",
  "secret",
  "credentials",
  "*.apiKey",
  "*.token",
  "*.password",
  "*.secret",
];

export function createLogger(name: string): Logger {
  return pino({
    name,
    level: process.env["LOG_LEVEL"] ?? "info",
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    ...(process.env["NODE_ENV"] !== "production"
      ? { transport: { target: "pino/file", options: { destination: 1 } } }
      : {}),
  });
}

export type { Logger };
