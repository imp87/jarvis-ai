import { Router } from "express";
import { z } from "zod";
import {
  ForbiddenError,
  NotFoundError,
  channelNameSchema,
  inboundMessageSchema,
} from "@jarvis/shared";
import type { Container } from "../container.js";
import { asyncHandler } from "../middleware/auth.js";

/**
 * The single ingress every channel adapter uses (component 9). The orchestrator
 * knows nothing about Telegram or Discord — it receives "message from channel X,
 * user Y" and returns a reply. Adding Slack or WhatsApp later is a new adapter,
 * not a change here.
 */
export function messageRoutes(container: Container): Router {
  const router = Router();
  const { repos, agent, logger } = container;

  router.post(
    "/v1/messages/inbound",
    asyncHandler(async (req, res) => {
      const input = inboundMessageSchema.parse(req.body);

      // Authorisation: only registered channel identities get an answer. An
      // unknown Telegram user who finds the bot falls through to 403.
      const user = await repos.identities.findUserByChannelIdentity(
        input.channel,
        input.channelUserId,
      );
      if (!user) {
        logger.warn(
          { channel: input.channel, channelUserId: input.channelUserId },
          "message from unregistered identity rejected",
        );
        throw new ForbiddenError("this channel identity is not registered");
      }

      const conversation = input.conversationId
        ? await repos.conversations.findById(input.conversationId, user.id)
        : await repos.conversations.findOrCreateActive(user.id);
      if (!conversation) throw new NotFoundError("conversation not found");

      const settings = await repos.settings.get(user.id, input.channel);

      const result = await agent.run({
        userId: user.id,
        ownerName: user.displayName,
        conversationId: conversation.id,
        channel: input.channel,
        text: input.text,
      });

      res.json({
        conversationId: result.conversationId,
        reply: result.reply,
        // The stored preference decides how the reply is rendered — deliberately
        // NOT mirrored from the incoming message. Sending a voice note does not
        // imply wanting one back; that is a setting, edited in the admin UI.
        replyFormat: settings.replyFormat,
        voiceId: settings.voiceId,
        language: settings.language,
        // Only the voice pipeline acts on this; every other adapter ignores it.
        // Null rather than absent so a client can tell "not requested" from
        // "this orchestrator is too old to say".
        endCall: result.endCall ?? null,
        diagnostics: {
          steps: result.steps,
          toolCalls: result.toolCalls,
          stoppedBecause: result.stoppedBecause,
        },
      });
    }),
  );

  /**
   * Cheap identity pre-check for adapters. A channel adapter calls this before
   * doing expensive work — downloading and transcribing a voice note — so an
   * unregistered stranger costs a database lookup rather than a transcription.
   * The authoritative gate is still the inbound handler above.
   */
  router.get(
    "/v1/identities/resolve",
    asyncHandler(async (req, res) => {
      const query = z
        .object({ channel: channelNameSchema, channelUserId: z.string().min(1) })
        .parse(req.query);
      const user = await repos.identities.findUserByChannelIdentity(
        query.channel,
        query.channelUserId,
      );
      if (!user) {
        res.status(404).json({
          error: { code: "not_registered", message: "this channel identity is not registered" },
        });
        return;
      }
      res.json({
        userId: user.id,
        displayName: user.displayName,
        settings: await repos.settings.get(user.id, query.channel),
      });
    }),
  );

  router.get(
    "/v1/conversations",
    asyncHandler(async (req, res) => {
      const userId = z.string().uuid().parse(req.query["userId"]);
      res.json({ conversations: await repos.conversations.listForUser(userId) });
    }),
  );

  router.get(
    "/v1/conversations/:id/messages",
    asyncHandler(async (req, res) => {
      const userId = z.string().uuid().parse(req.query["userId"]);
      const id = z.string().uuid().parse(req.params["id"]);
      const conversation = await repos.conversations.findById(id, userId);
      if (!conversation) throw new NotFoundError("conversation not found");
      const limit = z.coerce.number().int().min(1).max(200).default(50).parse(req.query["limit"]);
      res.json({ messages: await repos.conversations.recentMessages(id, limit) });
    }),
  );

  return router;
}
