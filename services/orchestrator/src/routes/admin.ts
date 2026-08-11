import { Router } from "express";
import { z } from "zod";
import {
  BadRequestError,
  NotFoundError,
  callRequestSchema,
  channelNameSchema,
} from "@jarvis/shared";
import type { Container } from "../container.js";
import { asyncHandler } from "../middleware/auth.js";

/**
 * Identity management, memory maintenance and the manual action triggers the
 * build plan asks for ("test call", "test email check"). These are operator
 * endpoints — they sit behind the service token and are what the admin UI and
 * your own curl commands drive.
 */
export function adminRoutes(container: Container): Router {
  const router = Router();
  const { repos, memory, calls } = container;

  // --- Users and channel identities ---------------------------------------

  router.get(
    "/v1/identities",
    asyncHandler(async (_req, res) => {
      res.json({ identities: await repos.identities.listIdentities() });
    }),
  );

  /**
   * Users with everything the settings UI needs in one round trip: which
   * channels they can reach the agent on, and how each of those replies.
   */
  router.get(
    "/v1/users",
    asyncHandler(async (_req, res) => {
      const [users, identities] = await Promise.all([
        repos.identities.listUsers(),
        repos.identities.listIdentities(),
      ]);
      res.json({
        users: await Promise.all(
          users.map(async (user) => ({
            ...user,
            identities: identities.filter((i) => i.userId === user.id),
            settings: await repos.settings.listForUser(user.id),
          })),
        ),
      });
    }),
  );

  // --- Global policy -------------------------------------------------------
  //
  // Quiet hours and the call budget are decisions about someone's evening, not
  // deployment configuration. They are read from the database per call, so a
  // change here applies to the next call rather than the next restart.

  router.get(
    "/v1/settings/policy",
    asyncHandler(async (_req, res) => {
      res.json({
        policy: await container.policy.resolve(),
        environmentDefaults: container.policy.environmentDefaults(),
      });
    }),
  );

  router.put(
    "/v1/settings/policy",
    asyncHandler(async (req, res) => {
      // `null` clears an override and hands the setting back to the
      // environment; omitting a key leaves it untouched. They are different
      // intents and the schema has to keep them apart.
      const timeOfDay = z
        .string()
        .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM")
        .nullable();
      const patch = z
        .object({
          quietHoursStart: timeOfDay.optional(),
          quietHoursEnd: timeOfDay.optional(),
          quietHoursTimezone: z.string().min(1).max(64).nullable().optional(),
          maxCallsPerHour: z.coerce.number().int().min(0).max(100).nullable().optional(),
          maxCallsPerDay: z.coerce.number().int().min(0).max(500).nullable().optional(),
        })
        .parse(req.body);

      const policy = await container.policy.update(patch);
      container.logger.info({ patch }, "call policy updated");
      res.json({ policy, environmentDefaults: container.policy.environmentDefaults() });
    }),
  );

  router.post(
    "/v1/users",
    asyncHandler(async (req, res) => {
      const input = z
        .object({ displayName: z.string().min(1).max(100), isOwner: z.boolean().default(false) })
        .parse(req.body);
      const user = await repos.identities.createUser(input.displayName, input.isOwner);
      res.status(201).json(user);
    }),
  );

  router.post(
    "/v1/identities",
    asyncHandler(async (req, res) => {
      const input = z
        .object({
          userId: z.string().uuid(),
          channel: channelNameSchema,
          channelUserId: z.string().min(1),
        })
        .parse(req.body);
      await repos.identities.linkIdentity(input.userId, input.channel, input.channelUserId);
      res.status(201).json({ ok: true });
    }),
  );

  router.patch(
    "/v1/identities",
    asyncHandler(async (req, res) => {
      const input = z
        .object({
          channel: channelNameSchema,
          channelUserId: z.string().min(1),
          enabled: z.boolean(),
        })
        .parse(req.body);
      await repos.identities.setIdentityEnabled(
        input.channel,
        input.channelUserId,
        input.enabled,
      );
      res.json({ ok: true });
    }),
  );

  // --- Per-channel settings ------------------------------------------------
  //
  // Data layer for component 8's UI. The reply format lives here rather than in
  // the adapter so it is editable without a redeploy, and so every channel
  // answers the same way about it.

  router.get(
    "/v1/users/:id/settings",
    asyncHandler(async (req, res) => {
      const userId = z.string().uuid().parse(req.params["id"]);
      res.json({ settings: await repos.settings.listForUser(userId) });
    }),
  );

  router.put(
    "/v1/users/:id/settings/:channel",
    asyncHandler(async (req, res) => {
      const userId = z.string().uuid().parse(req.params["id"]);
      const channel = channelNameSchema.parse(req.params["channel"]);
      const patch = z
        .object({
          replyFormat: z.enum(["text", "voice"]).optional(),
          voiceId: z.string().max(128).nullable().optional(),
          language: z.string().min(2).max(16).optional(),
        })
        .parse(req.body);
      res.json({ settings: await repos.settings.upsert(userId, channel, patch) });
    }),
  );

  // --- Memory --------------------------------------------------------------

  router.post(
    "/v1/memory",
    asyncHandler(async (req, res) => {
      const input = z
        .object({
          userId: z.string().uuid(),
          kind: z
            .enum(["note", "call_transcript", "email_summary", "conversation", "document"])
            .default("note"),
          content: z.string().min(1).max(20_000),
          metadata: z.record(z.unknown()).optional(),
        })
        .parse(req.body);
      const id = await memory.remember({
        userId: input.userId,
        kind: input.kind,
        content: input.content,
        ...(input.metadata ? { metadata: input.metadata } : {}),
      });
      res.status(201).json({ id });
    }),
  );

  router.post(
    "/v1/memory/search",
    asyncHandler(async (req, res) => {
      const input = z
        .object({
          userId: z.string().uuid(),
          query: z.string().min(1).max(2000),
          limit: z.number().int().min(1).max(50).default(10),
          minSimilarity: z.number().min(0).max(1).default(0.35),
        })
        .parse(req.body);
      res.json({ results: await memory.search(input) });
    }),
  );

  router.delete(
    "/v1/memory/:id",
    asyncHandler(async (req, res) => {
      const id = z.string().uuid().parse(req.params["id"]);
      const userId = z.string().uuid().parse(req.query["userId"]);
      if (!(await repos.memories.delete(id, userId))) {
        res.status(404).json({ error: { code: "not_found", message: "memory not found" } });
        return;
      }
      res.status(204).end();
    }),
  );

  // --- Manual triggers -----------------------------------------------------

  router.post(
    "/v1/actions/call",
    asyncHandler(async (req, res) => {
      const input = callRequestSchema.parse(req.body);
      const outcome = await calls.requestCall(input);
      res.status(outcome.placed ? 202 : 409).json({
        placed: outcome.placed,
        callId: outcome.call.id,
        ...(outcome.placed ? {} : { reason: outcome.reason }),
      });
    }),
  );

  /**
   * How a call ends up in the log truthfully.
   *
   * Placing a call is fire-and-forget: the pipeline writes a call file and
   * Asterisk dials it later, so "placed" only ever meant "queued". Without this
   * callback a call that never connected stayed `dialing` forever — and
   * `budgetUsage` counts `dialing`, so every failure permanently consumed one of
   * the day's calls.
   */
  router.patch(
    "/v1/calls/:id/status",
    asyncHandler(async (req, res) => {
      const id = z.string().uuid().parse(req.params["id"]);
      const input = z
        .object({
          status: z.enum(["dialing", "in_progress", "completed", "failed"]),
          error: z.string().max(1000).optional(),
        })
        .parse(req.body);

      // An UPDATE against an id that does not exist touches zero rows and says
      // nothing, which is how a call-id mismatch between the two services hid
      // for as long as it did: every status report succeeded, every call stayed
      // `dialing`, and `budgetUsage` counts `dialing`.
      if (!(await repos.calls.get(id))) {
        container.logger.warn(
          { callId: id, status: input.status },
          "status reported for a call that is not in call_logs; the pipeline and the " +
            "orchestrator disagree about this call's id",
        );
      }

      await repos.calls.updateStatus(id, input.status, {
        ...(input.status === "completed" || input.status === "failed"
          ? { endedAt: new Date() }
          : {}),
      });
      await container.mailDelivery.onCallStatus(id, input.status);
      if (input.status === "completed") {
        // Never awaited: resolution reads the calendar and asks a model, and
        // the pipeline's status callback must not wait on either.
        void container.callResolution.onCallCompleted(id);
      }
      container.logger.info(
        { callId: id, status: input.status, ...(input.error ? { error: input.error } : {}) },
        "call status reported by the pipeline",
      );
      res.json({ id, status: input.status });
    }),
  );

  /**
   * A spoken turn inside a call the orchestrator itself placed.
   *
   * Separate from `/v1/messages/inbound` because the authority is different.
   * That path asks "is this speaker allowed to talk to Jarvis" and answers with
   * the identity allowlist — correct for an incoming call, and impossible to
   * satisfy here: the far end of an outbound call is a stranger by definition,
   * which is why every third-party call turned into a string of 403s.
   *
   * Here the authority comes from the call record instead. The orchestrator
   * placed this call, at the owner's request, to a number that had to pass both
   * outbound switches. Who picked up is irrelevant to whether the turn may be
   * processed — and their words are treated as untrusted throughout:
   *
   *   - the transcript goes into its own conversation, never the owner's, so a
   *     stranger's sentences are not replayed as history in later chats;
   *   - side effects are switched off, so nothing said on the phone can send
   *     mail, write the calendar or place another call;
   *   - the prompt states plainly that the speaker is not the owner.
   */
  router.post(
    "/v1/calls/:id/turn",
    asyncHandler(async (req, res) => {
      const callId = z.string().uuid().parse(req.params["id"]);
      const input = z
        .object({
          text: z.string().min(1).max(8_000),
          /** Returned by the first turn; keeps the call in one transcript. */
          conversationId: z.string().uuid().optional(),
        })
        .parse(req.body);

      const call = await repos.calls.get(callId);
      if (!call) throw new NotFoundError("call not found");
      // A finished call must not accept more turns: without this a late or
      // replayed request could run the agent long after the line closed.
      if (call.status !== "dialing" && call.status !== "in_progress") {
        throw new BadRequestError(`call is ${call.status}, not in progress`);
      }

      // The owner is found through the conversation the call was requested
      // from — that is the only link between a call row and a person.
      const owner = call.conversationId
        ? await repos.conversations.ownerOf(call.conversationId)
        : null;
      if (!owner) {
        throw new BadRequestError("this call has no owning conversation; cannot process a turn");
      }

      const transcript = input.conversationId
        ? await repos.conversations.findById(input.conversationId, owner.id)
        : await repos.conversations.create(owner.id, `Anruf an ${call.toNumber}`);
      if (!transcript) throw new NotFoundError("call transcript conversation not found");

      // What this call may agree to, read from the database on every turn
      // rather than carried along: the set has to be the frozen one.
      const mandate = await repos.mandates.findByCall(callId);
      // Why this call exists, on every turn.
      //
      // The pipeline used to carry this only when the model had written a magic
      // `[JARVIS_CONTEXT]` marker into the opening line, which it never does —
      // so the first delegated turn arrived with no idea a call was even in
      // progress, and answered a hairdresser's "Hallo?" with "Wer ist dort?"
      // on a call it had placed itself.
      // Only a real errand is stated. `call.reason` is the audit answer to "why
      // does this warrant a call" and routinely says nothing about the task —
      // briefed with it, the model filled the gap by inventing one.
      const errand = mandate?.errand?.trim();
      const briefing = [
        errand
          ? "Du telefonierst gerade. DU hast angerufen, nicht umgekehrt.\n" +
            // The opening is spoken by the pipeline before the first turn is
            // ever delegated. Without saying so, the agent introduces itself a
            // second time and the callee hears the same sentence twice.
            `Dein Eröffnungssatz wurde BEREITS GESPROCHEN, wörtlich: „${errand}"\n` +
            "Wiederhole ihn nicht und stell dich nicht noch einmal vor — das hat der Gegenüber " +
            "schon gehört. Führe das Gespräch von dort aus weiter."
          : "Du telefonierst gerade. DU hast angerufen, nicht umgekehrt. Der genaue Anlass " +
            "liegt dir nicht vor — sag das offen und erfinde KEINEN. Frag höflich nach, worum " +
            "es gehen sollte, oder kündige an, dass du dich noch einmal meldest.",
        "Frage nie, wer dran ist oder wie du helfen kannst — das weißt du. Bring den Anlass " +
          "voran und antworte knapp.",
        "",
        container.mandateService.briefingFor(
          mandate,
          container.config.env.QUIET_HOURS_TIMEZONE,
        ),
      ].join("\n");

      await repos.calls.appendTranscript(callId, {
        at: new Date().toISOString(),
        speaker: "other",
        text: input.text,
      });

      const result = await container.agent.run({
        userId: owner.id,
        ownerName: owner.displayName,
        conversationId: transcript.id,
        channel: "voice_call",
        text: `${briefing}

---

${input.text}`,
        // The far end may not cause anything outside the conversation. This is
        // the single most important line in this handler.
        allowSideEffects: false,
        counterpart: "third_party",
        // Reaches the tools through ToolContext: `end_call` needs it to know
        // whose consent its gate should be reading.
      });

      await repos.calls.appendTranscript(callId, {
        at: new Date().toISOString(),
        speaker: "agent",
        text: result.reply,
      });

      res.json({
        reply: result.reply,
        conversationId: result.conversationId,
        ...(result.endCall ? { endCall: result.endCall } : {}),
      });
    }),
  );

  router.get(
    "/v1/calls",
    asyncHandler(async (req, res) => {
      const limit = z.coerce.number().int().min(1).max(200).default(50).parse(req.query["limit"]);
      res.json({
        calls: await repos.calls.list(limit),
        budgetUsage: await repos.calls.budgetUsage(),
      });
    }),
  );

  /**
   * Dry run of the whole agent path without a channel adapter — the fastest way
   * to check tool wiring, routing and prompts end to end.
   */
  router.post(
    "/v1/actions/agent",
    asyncHandler(async (req, res) => {
      const input = z
        .object({
          userId: z.string().uuid(),
          text: z.string().min(1).max(8000),
          conversationId: z.string().uuid().optional(),
          profile: z.string().optional(),
          channel: channelNameSchema.default("api"),
        })
        .parse(req.body);

      const conversation = input.conversationId
        ? await repos.conversations.findById(input.conversationId, input.userId)
        : await repos.conversations.create(input.userId, "manual test");
      if (!conversation) {
        res.status(404).json({ error: { code: "not_found", message: "conversation not found" } });
        return;
      }

      const result = await container.agent.run({
        userId: input.userId,
        ownerName: "operator",
        conversationId: conversation.id,
        channel: input.channel,
        text: input.text,
        profile: input.profile,
      });
      res.json(result);
    }),
  );

  return router;
}
