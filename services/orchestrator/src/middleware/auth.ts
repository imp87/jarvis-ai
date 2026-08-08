import type { NextFunction, Request, Response } from "express";
import { safeEqual, UnauthorizedError } from "@jarvis/shared";

/**
 * Service-to-service auth. Every internal caller — channel adapters, the email
 * monitor, the voice pipeline — presents the shared token.
 *
 * This is deliberately the floor, not the ceiling: the PC daemon gets its own
 * per-daemon token (see the daemon protocol), and mTLS is the intended
 * hardening step. What matters today is that nothing is reachable unauthenticated.
 */
export function requireServiceToken(expectedToken: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const header = req.header("authorization") ?? "";
    const [scheme, value] = header.split(" ");
    if (scheme?.toLowerCase() !== "bearer" || !value) {
      next(new UnauthorizedError("missing bearer token"));
      return;
    }
    if (!safeEqual(value, expectedToken)) {
      next(new UnauthorizedError("invalid token"));
      return;
    }
    next();
  };
}

/** Wraps an async handler so a rejected promise reaches the error middleware. */
export function asyncHandler<T extends Request>(
  handler: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: T, res: Response, next: NextFunction): void => {
    handler(req, res, next).catch(next);
  };
}
