import { Router } from "express";
import { z } from "zod";
import { ContactExistsError } from "@jarvis/db";
import { AppError, NotFoundError, PhoneNumberError } from "@jarvis/shared";
import type { Container } from "../container.js";
import { asyncHandler } from "../middleware/auth.js";

const contactName = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[\p{L}\p{N} .,'&_-]+$/u, "letters, digits, spaces and . , ' & _ - only");

const phone = z.string().trim().min(3).max(40);

const createSchema = z.object({
  userId: z.string().uuid(),
  name: contactName,
  phone,
  note: z.string().trim().max(500).optional(),
  /**
   * Only the owner may grant this, which is why it exists on this route and not
   * on the tool. It defaults to false so the safe outcome is the default one.
   */
  allowCalls: z.boolean().default(false),
});

const updateSchema = z.object({
  name: contactName.optional(),
  phone: phone.optional(),
  note: z.string().trim().max(500).nullable().optional(),
  allowCalls: z.boolean().optional(),
});

/**
 * Contacts the agent may dial.
 *
 * The permission to call lives here rather than anywhere the agent can reach:
 * `allow_calls` is only ever set through this route, which requires the service
 * token and is driven by the admin UI. The agent's own `contact_create` tool
 * writes rows with it false and cannot change an existing one.
 */
export function contactRoutes(container: Container): Router {
  const router = Router();
  const { repos, logger } = container;

  router.get(
    "/v1/contacts",
    asyncHandler(async (req, res) => {
      const userId = z.string().uuid().parse(req.query["userId"]);
      res.json({ contacts: await repos.contacts.list(userId) });
    }),
  );

  router.post(
    "/v1/contacts",
    asyncHandler(async (req, res) => {
      const input = createSchema.parse(req.body);
      try {
        const contact = await repos.contacts.create({
          userId: input.userId,
          name: input.name,
          phone: input.phone,
          note: input.note ?? null,
          createdBy: "user",
          allowCalls: input.allowCalls,
        });
        logger.info(
          { contact: contact.name, allowCalls: contact.allowCalls },
          "contact created",
        );
        res.status(201).json({ contact });
      } catch (err) {
        throw asHttpError(err);
      }
    }),
  );

  router.patch(
    "/v1/contacts/:id",
    asyncHandler(async (req, res) => {
      const id = z.string().uuid().parse(req.params["id"]);
      const userId = z.string().uuid().parse(req.query["userId"]);
      const patch = updateSchema.parse(req.body);
      try {
        const contact = await repos.contacts.update(userId, id, {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
          ...(patch.note !== undefined ? { note: patch.note } : {}),
          ...(patch.allowCalls !== undefined ? { allowCalls: patch.allowCalls } : {}),
        });
        if (!contact) throw new NotFoundError("contact not found");
        if (patch.allowCalls !== undefined) {
          // Worth its own line in the log: this is the moment a number becomes
          // dialable, and it is the only place that can happen.
          logger.info(
            { contact: contact.name, allowCalls: contact.allowCalls },
            "contact call permission changed",
          );
        }
        res.json({ contact });
      } catch (err) {
        throw asHttpError(err);
      }
    }),
  );

  router.delete(
    "/v1/contacts/:id",
    asyncHandler(async (req, res) => {
      const id = z.string().uuid().parse(req.params["id"]);
      const userId = z.string().uuid().parse(req.query["userId"]);
      if (!(await repos.contacts.delete(userId, id))) throw new NotFoundError("contact not found");
      res.status(204).end();
    }),
  );

  return router;
}

/** Turns the repository's own failures into answers the UI can show. */
function asHttpError(err: unknown): unknown {
  if (err instanceof ContactExistsError) {
    return new AppError(
      `Es gibt bereits einen Kontakt „${err.contactName}“.`,
      409,
      "name_taken",
      [{ path: "name", message: "Dieser Name ist schon vergeben." }],
    );
  }
  if (err instanceof PhoneNumberError) {
    return new AppError(
      `Das ist keine gültige Telefonnummer: ${err.message}`,
      400,
      "bad_request",
      [{ path: "phone", message: err.message }],
    );
  }
  return err;
}
