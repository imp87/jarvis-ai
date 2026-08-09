"use client";

import { notifications } from "@mantine/notifications";
import type { ZodTypeAny } from "zod";
import type { ActionResult } from "./action-result";

/**
 * Mantine's `validate` takes a function returning errors keyed by field path,
 * which is exactly what a Zod issue list flattens to. Writing the four lines
 * beats adding a resolver package for them.
 */
export function zodValidate<T extends ZodTypeAny>(schema: T) {
  return (values: unknown): Record<string, string> => {
    const result = schema.safeParse(values);
    if (result.success) return {};
    const errors: Record<string, string> = {};
    for (const issue of result.error.issues) {
      const path = issue.path.join(".");
      if (path && !errors[path]) errors[path] = issue.message;
    }
    return errors;
  };
}

const COLOURS = { success: "teal", warning: "yellow", error: "red" } as const;

/** One place deciding how an outcome looks, so a warning never reads as success. */
export function notifyResult(result: ActionResult): void {
  notifications.show({
    color: COLOURS[result.status],
    title:
      result.status === "success" ? "Done" : result.status === "warning" ? "Saved with a problem" : "Failed",
    message: result.message,
    // A failure is worth reading twice; a success is not worth a click.
    autoClose: result.status === "success" ? 4000 : false,
    withCloseButton: true,
  });
}
