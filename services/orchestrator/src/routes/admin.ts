import { Router } from "express";
import { z } from "zod";
import { callRequestSchema, channelNameSchema } from "@jarvis/shared";
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
