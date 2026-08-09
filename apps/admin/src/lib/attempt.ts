import "server-only";
import { ZodError } from "zod";
import { ApiError } from "./api";
import { ok, type ActionResult } from "./action-result";

/**
 * Turns a thrown error into something the operator can act on.
 *
 * An unhandled throw in a server action reaches production as "an error
 * occurred in the Server Components render" with no detail — precisely useless
 * when the actual message is "command not found: npx".
 *
 * The handler may return an `ActionResult` of its own when the outcome is not a
 * plain success; anything else is treated as done.
 */
export async function attempt(
  successMessage: string,
  fn: () => Promise<ActionResult | void>,
): Promise<ActionResult> {
  try {
    return (await fn()) ?? ok(successMessage);
  } catch (err) {
    if (err instanceof ZodError) {
      // Field errors go back to the exact input that caused them, so the form
      // marks the offending field instead of showing a banner about it.
      const fieldErrors: Record<string, string> = {};
      for (const issue of err.issues) {
        const path = issue.path.join(".");
        if (path && !fieldErrors[path]) fieldErrors[path] = issue.message;
      }
      return {
        status: "error",
        message: "Some fields need fixing.",
        ...(Object.keys(fieldErrors).length > 0 ? { fieldErrors } : {}),
      };
    }
    if (err instanceof ApiError) {
      const fieldErrors: Record<string, string> = {};
      for (const detail of err.details ?? []) {
        if (detail.path && !fieldErrors[detail.path]) fieldErrors[detail.path] = detail.message;
      }
      return {
        status: "error",
        message: err.message,
        ...(Object.keys(fieldErrors).length > 0 ? { fieldErrors } : {}),
      };
    }
    return { status: "error", message: err instanceof Error ? err.message : String(err) };
  }
}
