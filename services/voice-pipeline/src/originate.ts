import { writeFile, rename, mkdir, chmod } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "@jarvis/shared";

export interface OriginateOptions {
  /** Asterisk's outgoing spool, shared with the pipeline as a volume. */
  spoolDir: string;
  /** Staging directory on the same filesystem, so the move into spool is atomic. */
  stagingDir: string;
  endpoint?: string;
  callerId?: string | undefined;
  /** Seconds to let it ring before giving up. */
  waitTime?: number;
}

/**
 * Places an outbound call by dropping a call file for Asterisk.
 *
 * Chosen over AMI or ARI because it needs no second protocol, no credentials
 * and no connection to keep alive — the pipeline writes a file, Asterisk dials.
 * The trade-off is honest: failures surface as "the call never connected"
 * rather than as an error response, so the caller must not assume success.
 */
export class CallOriginator {
  constructor(
    private readonly options: OriginateOptions,
    private readonly logger: Logger,
  ) {}

  async originate(input: { callId: string; toNumber: string }): Promise<void> {
    const endpoint = this.options.endpoint ?? "fritzbox";
    const lines = [
      `Channel: PJSIP/${input.toNumber}@${endpoint}`,
      ...(this.options.callerId ? [`CallerID: <${this.options.callerId}>`] : []),
      // Retries are the notification policy's job, not Asterisk's — it has no
      // idea about quiet hours or the call budget.
      "MaxRetries: 0",
      `WaitTime: ${this.options.waitTime ?? 45}`,
      "Context: jarvis-outbound",
      "Extension: s",
      "Priority: 1",
      `Setvar: JARVIS_CALL_ID=${input.callId}`,
      "",
    ].join("\n");

    await mkdir(this.options.stagingDir, { recursive: true });
    const staged = path.join(this.options.stagingDir, `${input.callId}.call`);
    const target = path.join(this.options.spoolDir, `${input.callId}.call`);

    await writeFile(staged, lines, "utf8");
    // Asterisk runs as its own user and calls utime() on the file it picks up.
    // Without this it logs "Operation not permitted" on every single call.
    await chmod(staged, 0o666);
    // Asterisk polls the spool directory and will happily read a half-written
    // file. Writing elsewhere and renaming makes it appear complete or not at all.
    await rename(staged, target);

    this.logger.info({ callId: input.callId, endpoint }, "call file queued");
  }
}
