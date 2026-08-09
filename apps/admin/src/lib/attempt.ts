import "server-only";
import { ZodError } from "zod";
import { ApiError } from "./api";
import type { ActionResult } from "./action-result";

/**
 * Turns a thrown error into something the operator can act on.
 *
 * An unhandled throw in a server action reaches production as "an error
 * occurred in the Server Components render" with no detail — precisely useless
 * when the actual message is "command not found: npx".
 */
export async function attempt(
  successMessage: string,
  fn: () => Promise<string | void>,
  /** Pass the submitted form to keep its values on screen when this fails. */
  echo?: FormData,
): Promise<ActionResult> {
  try {
    const detail = await fn();
    return { success: detail || successMessage };
  } catch (err) {
    const values = echoValues(echo);
    const base = values ? { values } : {};

    if (err instanceof ZodError) {
      return {
        ...base,
        error: "Check the highlighted fields.",
        details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      };
    }
    if (err instanceof ApiError) {
      return { ...base, error: err.message, ...(err.details ? { details: err.details } : {}) };
    }
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Credentials are never echoed. Re-rendering them would write a plaintext API
 * key into the page source for the sake of saving one paste — the rest of the
 * form is worth restoring, a secret is not.
 */
const SECRET_FIELDS = new Set(["credential", "secrets", "password"]);

function echoValues(formData: FormData | undefined): Record<string, string> | undefined {
  if (!formData) return undefined;
  const values: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value === "string" && !SECRET_FIELDS.has(key)) values[key] = value;
  }
  return Object.keys(values).length > 0 ? values : undefined;
}
