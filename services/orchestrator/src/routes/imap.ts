import { Router } from "express";
import { z } from "zod";
import { AppError, NotFoundError, encryptSecret } from "@jarvis/shared";
import type { ImapAccountRow } from "@jarvis/db";
import type { Container } from "../container.js";
import { asyncHandler } from "../middleware/auth.js";

const notifyChannel = z.enum(["telegram", "discord"]);
const messageRoute = z.enum(["none", "telegram", "discord", "call"]);
const fallbackRoute = z.enum(["none", "telegram", "discord"]);
const deliveryPolicy = z.object({
  low: messageRoute.default("none"),
  normal: messageRoute.default("telegram"),
  urgent: messageRoute.default("call"),
  callFallback: fallbackRoute.default("telegram"),
  callRetryCount: z.coerce.number().int().min(0).max(4).default(1),
  callRetryDelayMinutes: z.coerce.number().int().min(1).max(1440).default(20),
  replyMode: z.enum(["none", "draft", "ask"]).default("draft"),
  instructions: z.string().trim().max(2000).default(""),
});
const accountName = z.string().trim().min(1).max(80).regex(/^[\w .-]+$/, "letters, digits, spaces, . _ and - only");
const createAccountSchema = z.object({
  userId: z.string().uuid(),
  name: accountName,
  host: z.string().trim().min(1).max(255),
  port: z.coerce.number().int().min(1).max(65_535).default(993),
  secure: z.boolean().default(true),
  username: z.string().trim().min(1).max(500),
  password: z.string().min(1).max(4_000),
  mailbox: z.string().trim().min(1).max(500).default("INBOX"),
  notifyChannel: notifyChannel.default("telegram"),
  deliveryPolicy: deliveryPolicy.default({}),
  maxBodyChars: z.coerce.number().int().min(500).max(100_000).default(12_000),
});

const updateAccountSchema = z.object({
  name: accountName.optional(),
  host: z.string().trim().min(1).max(255).optional(),
  port: z.coerce.number().int().min(1).max(65_535).optional(),
  secure: z.boolean().optional(),
  username: z.string().trim().min(1).max(500).optional(),
  /** Omit to retain it. Passwords are intentionally never readable. */
  password: z.string().min(1).max(4_000).optional(),
  mailbox: z.string().trim().min(1).max(500).optional(),
  notifyChannel: notifyChannel.optional(),
  deliveryPolicy: deliveryPolicy.optional(),
  maxBodyChars: z.coerce.number().int().min(500).max(100_000).optional(),
  enabled: z.boolean().optional(),
});

/** IMAP account registry — credentials are write-only AES-GCM envelopes. */
export function imapRoutes(container: Container): Router {
  const router = Router();
  const { repos, imap, masterKey } = container;

  router.get(
    "/v1/imap/accounts",
    asyncHandler(async (_req, res) => {
      const accounts = await repos.emails.listAccounts();
      res.json({ accounts: accounts.map((account) => publicAccount(account, imap.statusFor(account.id))) });
    }),
  );

  router.post(
    "/v1/imap/accounts",
    asyncHandler(async (req, res) => {
      const input = createAccountSchema.parse(req.body);
      const account = await repos.emails
        .createAccount({
          userId: input.userId,
          name: input.name,
          host: input.host,
          port: input.port,
          secure: input.secure,
          username: input.username,
          passwordEnc: encryptSecret(input.password, masterKey),
          mailbox: input.mailbox,
          notifyChannel: input.notifyChannel,
          deliveryPolicy: input.deliveryPolicy,
          maxBodyChars: input.maxBodyChars,
        })
        .catch((err: unknown) => {
          if ((err as { code?: string }).code === "23505") {
            throw new AppError("An IMAP account with this name already exists for this user", 409, "name_taken");
          }
          throw err;
        });
      await imap.reconcileAccount(account.id);
      res.status(201).json(publicAccount(account, imap.statusFor(account.id)));
    }),
  );

  router.patch(
    "/v1/imap/accounts/:id",
    asyncHandler(async (req, res) => {
      const id = z.string().uuid().parse(req.params["id"]);
      const input = updateAccountSchema.parse(req.body);
      const account = await repos.emails.updateAccount(id, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.host !== undefined ? { host: input.host } : {}),
        ...(input.port !== undefined ? { port: input.port } : {}),
        ...(input.secure !== undefined ? { secure: input.secure } : {}),
        ...(input.username !== undefined ? { username: input.username } : {}),
        ...(input.password !== undefined ? { passwordEnc: encryptSecret(input.password, masterKey) } : {}),
        ...(input.mailbox !== undefined ? { mailbox: input.mailbox } : {}),
        ...(input.notifyChannel !== undefined ? { notifyChannel: input.notifyChannel } : {}),
        ...(input.deliveryPolicy !== undefined ? { deliveryPolicy: input.deliveryPolicy } : {}),
        ...(input.maxBodyChars !== undefined ? { maxBodyChars: input.maxBodyChars } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      });
      if (!account) throw new NotFoundError("IMAP account not found");
      await imap.reconcileAccount(id);
      res.json(publicAccount(account, imap.statusFor(id)));
    }),
  );

  router.delete(
    "/v1/imap/accounts/:id",
    asyncHandler(async (req, res) => {
      const id = z.string().uuid().parse(req.params["id"]);
      await imap.removeAccount(id);
      if (!(await repos.emails.deleteAccount(id))) throw new NotFoundError("IMAP account not found");
      res.status(204).end();
    }),
  );

  return router;
}

function publicAccount(
  account: ImapAccountRow,
  status: { state: string; error?: string },
): Record<string, unknown> {
  return {
    id: account.id,
    userId: account.userId,
    name: account.name,
    host: account.host,
    port: account.port,
    secure: account.secure,
    username: account.username,
    mailbox: account.mailbox,
    notifyChannel: account.notifyChannel,
    deliveryPolicy: account.deliveryPolicy,
    maxBodyChars: account.maxBodyChars,
    enabled: account.enabled,
    hasPassword: Boolean(account.passwordEnc),
    state: status.state,
    lastError: status.error ?? null,
  };
}
