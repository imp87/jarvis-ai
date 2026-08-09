/**
 * What every server action returns.
 *
 * `warning` is its own outcome because the most common result of attaching an
 * MCP server — registered, but the connection was refused — is neither. Folding
 * it into `success` painted a failed handshake green; folding it into `error`
 * would suggest nothing was saved, when in fact the row is there.
 *
 * Import-free: the client components read this type.
 */
export type ActionStatus = "success" | "warning" | "error";

export interface ActionResult {
  status: ActionStatus;
  message: string;
  /** Field-level problems, keyed by form path — fed straight into the form. */
  fieldErrors?: Record<string, string>;
}

export const ok = (message: string): ActionResult => ({ status: "success", message });
export const warn = (message: string): ActionResult => ({ status: "warning", message });
