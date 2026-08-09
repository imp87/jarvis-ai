/**
 * What every server action returns.
 *
 * Deliberately import-free: this module is pulled in by the client form
 * components, and anything it touched would be dragged into the browser bundle
 * along with it. The helper that produces these lives in `attempt.ts`, which is
 * server-only.
 */
export interface ActionResult {
  error?: string;
  success?: string;
  details?: Array<{ path: string; message: string }>;
  /**
   * What was submitted, echoed back so a rejected form can be re-rendered with
   * the operator's input still in it. React resets an uncontrolled form once its
   * action resolves, which on a typo would otherwise discard a hand-written
   * JSON schema. Secret-bearing fields are deliberately absent — see `attempt`.
   */
  values?: Record<string, string>;
}
