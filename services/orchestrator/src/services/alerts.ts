import {
  type NotificationRepository,
  type NotificationRow,
  type NotificationSeverity,
} from "@jarvis/db";
import type { ChannelName, Logger } from "@jarvis/shared";
import type { CallService } from "./calls.js";
import type { NotificationService } from "./notify.js";

/**
 * The system reporting on itself.
 *
 * Every other outbound message in this codebase is something the agent decided
 * to say. These are not: they are produced by the orchestrator when one of its
 * own steps failed, with wording fixed in code.
 *
 * That distinction is the whole point. If the LLM provider is down, the budget
 * is spent, or the model refuses, then the model *is* the failure — asking it
 * to compose the report means the report fails with it. Nothing here builds a
 * prompt, and the model has no route to this class of message at all.
 */

export interface AlertInput {
  userId: string;
  /** Stable slug, e.g. `calendar_write_failed`. Chooses the wording. */
  event: string;
  severity: NotificationSeverity;
  /** Already-rendered text. Fixed phrasing from the call site, never generated. */
  body: string;
  context?: Record<string, unknown>;
  /**
   * One incident, one notification, however often the producer retries. Build
   * it from what identifies the incident — not from a timestamp, which would
   * make every retry unique and defeat the purpose.
   */
  idempotencyKey: string;
}

export interface AlertOutcome {
  notification: NotificationRow;
  delivered: boolean;
  /** The channel that worked, if any. */
  via?: string;
}

/**
 * Which channels a severity is allowed to use, cheapest first.
 *
 * Order matters twice over. Cheap-to-expensive keeps a routine failure from
 * ringing a phone. And a chain must never lead with the subsystem that is
 * likely to be the broken one — reporting a failed call by placing a call is
 * how an outage reports itself into silence.
 *
 * Mail is absent because there is no generic outbound mail path yet; `smtp.ts`
 * can only send a reply to a mirrored message. Adding it here before it exists
 * would be a channel that silently drops everything, which is exactly the bug
 * this file's logging was hardened against.
 */
const CHANNELS_BY_SEVERITY: Record<NotificationSeverity, readonly ChannelName[]> = {
  info: ["telegram"],
  warning: ["telegram"],
  // The phone is the last resort, not the first. It is reached only when the
  // cheap channels could not deliver — and only for the one severity that
  // justifies waking someone.
  fatal: ["telegram", "voice_call"],
};

export class AlertService {
  constructor(
    private readonly notifications: NotificationRepository,
    private readonly delivery: NotificationService,
    private readonly calls: CallService,
    private readonly logger: Logger,
    private readonly ownerPhoneNumber: string | undefined,
  ) {}

  /**
   * Records an incident and tries to deliver it.
   *
   * The record is written first and independently of delivery: a chain of
   * 30-second timeouts runs for minutes, and a restart inside it must not erase
   * the fact that something needed saying. Delivery then becomes retryable
   * state rather than a single shot.
   */
  async raise(input: AlertInput): Promise<AlertOutcome> {
    const { notification, created } = await this.notifications.enqueue({
      userId: input.userId,
      event: input.event,
      severity: input.severity,
      body: input.body,
      ...(input.context ? { context: input.context } : {}),
      idempotencyKey: input.idempotencyKey,
    });

    if (!created) {
      // The producer retried. The incident is already recorded and possibly
      // already delivered; re-sending would turn one problem into a stream.
      this.logger.info(
        { notificationId: notification.id, event: input.event, status: notification.status },
        "alert already recorded for this incident; not sending again",
      );
      return {
        notification,
        delivered: notification.status === "delivered",
        ...(notification.deliveredVia ? { via: notification.deliveredVia } : {}),
      };
    }

    for (const channel of CHANNELS_BY_SEVERITY[input.severity]) {
      const attempt = await this.deliverVia(channel, notification);
      await this.notifications.recordAttempt(notification.id, {
        channel,
        delivered: attempt.delivered,
        reason: attempt.reason,
      });
      if (attempt.delivered) {
        await this.notifications.markDelivered(notification.id, channel);
        this.logger.info(
          { notificationId: notification.id, event: input.event, channel },
          "alert delivered",
        );
        return { notification, delivered: true, via: channel };
      }
    }

    await this.notifications.markExhausted(notification.id);
    // Nothing reached the owner. The row survives, so the admin UI can show it
    // and a later retry can pick it up — this is the one failure mode that
    // needs a human to come looking.
    this.logger.error(
      { notificationId: notification.id, event: input.event, severity: input.severity },
      "alert could not be delivered on any channel",
    );
    return { notification, delivered: false };
  }

  private async deliverVia(
    channel: ChannelName,
    notification: NotificationRow,
  ): Promise<{ delivered: boolean; reason?: string | undefined }> {
    if (channel !== "voice_call") {
      const result = await this.delivery.send(notification.userId, channel, notification.body);
      return { delivered: result.delivered, reason: result.reason };
    }

    if (!this.ownerPhoneNumber) {
      return { delivered: false, reason: "no OWNER_PHONE_NUMBER configured" };
    }
    // Placed as a `system_alert`, which draws on its own small allowance and
    // passes quiet hours. Not `urgent`: that flag belongs to operator-triggered
    // calls, and reusing it here would blur a distinction the policy relies on.
    const outcome = await this.calls.requestCall(
      {
        toNumber: this.ownerPhoneNumber,
        reason: `Systemmeldung: ${notification.event}`,
        context: notification.body,
        urgent: false,
      },
      "system_alert",
    );
    // A policy block is a distinct outcome from a failed dial, and the reason
    // is kept verbatim so "budget exhausted" and "voice pipeline down" stay
    // apart in the audit trail.
    return outcome.placed
      ? { delivered: true }
      : { delivered: false, reason: outcome.reason };
  }
}
