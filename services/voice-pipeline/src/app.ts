import { randomUUID } from "node:crypto";
import express, { type Express } from "express";
import { z } from "zod";
import { maskPhoneNumber, safeEqual, tryNormalisePhoneNumber, type Logger } from "@jarvis/shared";
import type { Env } from "./config.js";
import type { OrchestratorClient } from "./orchestrator.js";
import type { PendingCall } from "./transports/audiosocket.js";
import type { CallOriginator } from "./originate.js";

/** Matches what the orchestrator's CallService already sends. */
const outboundCallSchema = z.object({
  callId: z.string(),
  toNumber: z.string(),
  context: z.string(),
  reason: z.string(),
  /**
   * Who will pick up. Only the orchestrator knows the owner's own number, so it
   * decides; the pipeline just carries it through to the session.
   *
   * Defaults to `owner` because that is what every call was before third-party
   * calling existed, and because the owner persona is the safe one to reach by
   * accident — it addresses the far end as Master, which is merely odd for a
   * stranger, whereas the reverse would strip the persona from a real reminder
   * call to the owner.
   */
  counterpart: z.enum(["owner", "third_party"]).default("owner"),
});

export function createApp(deps: {
  env: Env;
  logger: Logger;
  orchestrator: OrchestratorClient;
  media: { expect(call: PendingCall): void };
  originator: CallOriginator;
  /** Context for the next outbound call, keyed by the id the orchestrator gave. */
  pendingContext: Map<string, string>;
  /** Whether the callee is the owner or a stranger. Decides the persona. */
  pendingCounterpart: Map<string, "owner" | "third_party">;
}): Express {
  const { env, logger, orchestrator, media, originator, pendingContext, pendingCounterpart } = deps;
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  /**
   * Called by the dialplan before answering an inbound call. Returns a call id
   * for an authorised number, the literal "denied" otherwise.
   *
   * Plain text on purpose: Asterisk's CURL() gives the dialplan a bare string,
   * and parsing JSON there would be far more fragile than comparing one word.
   */
  app.get("/v1/inbound", async (req, res) => {
    const token = String(req.query["token"] ?? "");
    if (!safeEqual(token, env.SERVICE_TOKEN)) {
      logger.warn({ ip: req.ip }, "inbound authorisation with a bad token");
      return res.type("text/plain").send("denied");
    }

    const raw = String(req.query["caller"] ?? "");
    const number = tryNormalisePhoneNumber(raw);
    if (!number) {
      logger.warn({ raw: raw.slice(0, 8) }, "inbound call with unusable caller ID");
      return res.type("text/plain").send("denied");
    }

    try {
      const caller = await orchestrator.authoriseCaller(number);
      if (!caller) {
        logger.warn({ caller: maskPhoneNumber(number) }, "inbound call from an unlisted number");
        return res.type("text/plain").send("denied");
      }

      const callId = randomUUID();
      media.expect({
        callId,
        direction: "inbound",
        remoteNumber: number,
        channelUserId: number,
        createdAt: Date.now(),
      });
      logger.info(
        { callId, caller: maskPhoneNumber(number), user: caller.displayName },
        "inbound call authorised",
      );
      return res.type("text/plain").send(callId);
    } catch (err) {
      logger.error({ err: String(err) }, "inbound authorisation failed");
      // Empty response makes the dialplan play congestion rather than connect.
      return res.type("text/plain").send("");
    }
  });

  /**
   * Outbound calls, triggered by the orchestrator. Quiet hours and the call
   * budget were already applied there — this endpoint only dials.
   */
  app.post("/v1/calls", async (req, res) => {
    const header = req.header("authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!safeEqual(presented, env.SERVICE_TOKEN)) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const parsed = outboundCallSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid request", details: parsed.error.issues });
    }

    const number = tryNormalisePhoneNumber(parsed.data.toNumber);
    if (!number) {
      return res.status(400).json({ error: `unusable number: ${parsed.data.toNumber}` });
    }

    const callId = randomUUID();
    media.expect({
      callId,
      direction: "outbound",
      remoteNumber: number,
      channelUserId: number,
      createdAt: Date.now(),
    });
    // The agent opens with why it is calling instead of a generic greeting.
    pendingContext.set(callId, parsed.data.context);
    // Told to us by the orchestrator, which is the only side that knows the
    // owner's own number. Defaults to `owner`: the persona that addresses the
    // far end as Master must never be reached by accident.
    pendingCounterpart.set(callId, parsed.data.counterpart);

    try {
      await originator.originate({ callId, toNumber: number.replace(/^\+/, "00") });
      logger.info(
        { callId, to: maskPhoneNumber(number), reason: parsed.data.reason },
        "outbound call queued",
      );
      // 202: the call file is queued, the phone has not rung yet.
      return res.status(202).json({ providerCallId: callId });
    } catch (err) {
      pendingContext.delete(callId);
      pendingCounterpart.delete(callId);
      logger.error({ err: String(err) }, "failed to queue outbound call");
      return res.status(502).json({ error: "could not place the call" });
    }
  });

  return app;
}
