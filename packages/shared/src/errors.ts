/** Base class for errors that are safe to surface over HTTP. */
export class AppError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 400, "bad_request", details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "unauthorized") {
    super(message, 401, "unauthorized");
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "forbidden") {
    super(message, 403, "forbidden");
  }
}

export class NotFoundError extends AppError {
  constructor(message = "not found") {
    super(message, 404, "not_found");
  }
}

/** Raised when a policy (quiet hours, call budget, LLM budget) blocks an action. */
export class PolicyError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 429, "policy_blocked", details);
  }
}

export class ProviderError extends AppError {
  constructor(
    message: string,
    readonly provider: string,
    details?: unknown,
  ) {
    super(message, 502, "provider_error", details);
  }
}

export function toErrorPayload(err: unknown): {
  status: number;
  body: { error: { code: string; message: string; details?: unknown } };
} {
  if (err instanceof AppError) {
    return {
      status: err.status,
      body: { error: { code: err.code, message: err.message, details: err.details } },
    };
  }
  return {
    status: 500,
    body: { error: { code: "internal_error", message: "internal server error" } },
  };
}
