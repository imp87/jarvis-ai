import type { NextFunction, Request, Response } from "express";
import { AppError, toErrorPayload, type Logger } from "@jarvis/shared";
import { ZodError } from "zod";

export function errorHandler(logger: Logger) {
  return (err: unknown, req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      next(err);
      return;
    }

    if (err instanceof ZodError) {
      res.status(400).json({
        error: {
          code: "validation_failed",
          message: "request body failed validation",
          details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
      });
      return;
    }

    const { status, body } = toErrorPayload(err);

    // Client errors are routine; server errors are not. Log accordingly, and
    // never put the raw error message in a 500 response — it can carry
    // connection strings and provider payloads.
    if (status >= 500) {
      logger.error(
        { err: err instanceof Error ? err.stack : String(err), path: req.path, method: req.method },
        "request failed",
      );
    } else if (!(err instanceof AppError)) {
      logger.warn({ err: String(err), path: req.path }, "request rejected");
    }

    res.status(status).json(body);
  };
}
