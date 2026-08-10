import { Router } from "express";
import { z } from "zod";
import { AppError, NotFoundError, encryptSecret } from "@jarvis/shared";
import type { CalDavAccountRow, CalDavCalendarRow } from "@jarvis/db";
import type { Container } from "../container.js";
import type { CalDavAccountStatus } from "../services/caldav.js";
import { asyncHandler } from "../middleware/auth.js";

const accountName = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[\w .-]+$/, "letters, digits, spaces, . _ and - only");

const baseUrl = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((value) => /^https?:\/\//i.test(value), "must start with http:// or https://");

// Validated here rather than at use time so a typo is rejected while the user
// is still looking at the form, not silently swallowed at query time.
const timezone = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, "must be an IANA timezone such as Europe/Berlin");

const createAccountSchema = z.object({
  userId: z.string().uuid(),
  name: accountName,
  baseUrl,
  username: z.string().trim().min(1).max(500),
  password: z.string().min(1).max(4_000),
  timezone: timezone.optional(),
});

const updateAccountSchema = z.object({
  name: accountName.optional(),
  baseUrl: baseUrl.optional(),
  username: z.string().trim().min(1).max(500).optional(),
  /** Omit to retain it. Passwords are intentionally never readable. */
  password: z.string().min(1).max(4_000).optional(),
  timezone: timezone.optional(),
  enabled: z.boolean().optional(),
});

/** CalDAV account registry — credentials are write-only AES-GCM envelopes. */
export function caldavRoutes(container: Container): Router {
  const router = Router();
  const { repos, caldav, masterKey, config } = container;

  router.get(
    "/v1/caldav/accounts",
    asyncHandler(async (_req, res) => {
      const accounts = await repos.calendars.listAccounts();
      const payload = await Promise.all(
        accounts.map(async (account) =>
          publicAccount(
            account,
            caldav.statusFor(account.id),
            await repos.calendars.listCalendars(account.id),
          ),
        ),
      );
      res.json({ accounts: payload });
    }),
  );

  router.post(
    "/v1/caldav/accounts",
    asyncHandler(async (req, res) => {
      const input = createAccountSchema.parse(req.body);
      const account = await repos.calendars
        .createAccount({
          userId: input.userId,
          name: input.name,
          baseUrl: input.baseUrl,
          username: input.username,
          passwordEnc: encryptSecret(input.password, masterKey),
          timezone: input.timezone ?? config.env.QUIET_HOURS_TIMEZONE,
        })
        .catch((err: unknown) => {
          if ((err as { code?: string }).code === "23505") {
            throw new AppError("A CalDAV account with this name already exists for this user", 409, "name_taken");
          }
          throw err;
        });
      // Discovery runs inline so the response can report a bad URL or password
      // straight away rather than leaving a broken account looking healthy.
      const status = await caldav.reconcileAccount(account.id);
      res.status(201).json(
        publicAccount(account, status, await repos.calendars.listCalendars(account.id)),
      );
    }),
  );

  router.patch(
    "/v1/caldav/accounts/:id",
    asyncHandler(async (req, res) => {
      const id = z.string().uuid().parse(req.params["id"]);
      const input = updateAccountSchema.parse(req.body);
      const account = await repos.calendars.updateAccount(id, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
        ...(input.username !== undefined ? { username: input.username } : {}),
        ...(input.password !== undefined ? { passwordEnc: encryptSecret(input.password, masterKey) } : {}),
        ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      });
      if (!account) throw new NotFoundError("CalDAV account not found");
      const status = await caldav.reconcileAccount(id);
      res.json(publicAccount(account, status, await repos.calendars.listCalendars(id)));
    }),
  );

  /** Re-runs discovery without changing anything — the "it moved" button. */
  router.post(
    "/v1/caldav/accounts/:id/refresh",
    asyncHandler(async (req, res) => {
      const id = z.string().uuid().parse(req.params["id"]);
      const account = await repos.calendars.getAccount(id);
      if (!account) throw new NotFoundError("CalDAV account not found");
      const status = await caldav.reconcileAccount(id);
      res.json(publicAccount(account, status, await repos.calendars.listCalendars(id)));
    }),
  );

  router.patch(
    "/v1/caldav/calendars/:id",
    asyncHandler(async (req, res) => {
      const id = z.string().uuid().parse(req.params["id"]);
      const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
      const calendar = await repos.calendars.setCalendarEnabled(id, enabled);
      if (!calendar) throw new NotFoundError("Calendar not found");
      res.json(publicCalendar(calendar));
    }),
  );

  router.delete(
    "/v1/caldav/accounts/:id",
    asyncHandler(async (req, res) => {
      const id = z.string().uuid().parse(req.params["id"]);
      caldav.removeAccount(id);
      if (!(await repos.calendars.deleteAccount(id))) throw new NotFoundError("CalDAV account not found");
      res.status(204).end();
    }),
  );

  return router;
}

function publicAccount(
  account: CalDavAccountRow,
  status: CalDavAccountStatus,
  calendars: CalDavCalendarRow[],
): Record<string, unknown> {
  return {
    id: account.id,
    userId: account.userId,
    name: account.name,
    baseUrl: account.baseUrl,
    username: account.username,
    timezone: account.timezone,
    enabled: account.enabled,
    hasPassword: Boolean(account.passwordEnc),
    state: status.state,
    lastError: status.error ?? null,
    lastCheckedAt: status.lastCheckedAt?.toISOString() ?? null,
    calendars: calendars.map(publicCalendar),
  };
}

function publicCalendar(calendar: CalDavCalendarRow): Record<string, unknown> {
  return {
    id: calendar.id,
    displayName: calendar.displayName,
    url: calendar.url,
    color: calendar.color,
    readOnly: calendar.readOnly,
    supportsEvents: calendar.supportsEvents,
    enabled: calendar.enabled,
  };
}
