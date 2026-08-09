import { z } from "zod";

/**
 * Mirrors the rest of the stack: configuration is environment variables,
 * validated once, and a missing secret fails loudly rather than turning into a
 * confusing 401 later.
 *
 * Unlike the services this cannot validate at import time in every context —
 * Next evaluates modules during the build, where these are legitimately absent.
 * `serverEnv()` is therefore called per request and memoised.
 */
const schema = z.object({
  ORCHESTRATOR_URL: z.string().url(),
  SERVICE_TOKEN: z.string().min(32, "SERVICE_TOKEN must be at least 32 characters"),
  ADMIN_PASSWORD: z.string().min(12, "ADMIN_PASSWORD must be at least 12 characters"),
  ADMIN_SESSION_HOURS: z.coerce.number().int().positive().max(720).default(12),
});

export type ServerEnv = z.infer<typeof schema>;

let cached: ServerEnv | undefined;

export function serverEnv(): ServerEnv {
  if (cached) return cached;

  const source: Record<string, string | undefined> = {
    ORCHESTRATOR_URL: process.env["ORCHESTRATOR_URL"],
    SERVICE_TOKEN: process.env["SERVICE_TOKEN"],
    ADMIN_PASSWORD: process.env["ADMIN_PASSWORD"],
    ADMIN_SESSION_HOURS: process.env["ADMIN_SESSION_HOURS"],
  };
  // Compose substitutes unset variables to an empty string, which would defeat
  // every default and produce a misleading "required" error.
  for (const key of Object.keys(source)) {
    if (source[key]?.trim() === "") delete source[key];
  }

  const result = schema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = result.data;
  return cached;
}
