import type pg from "pg";

/**
 * Drives which channels are tried, and in which order.
 *
 * `fatal` is deliberately narrow: it means an external commitment exists and
 * the local record of it does not — an appointment sitting in a stranger's
 * calendar that the owner does not know about. Nobody but the owner can resolve
 * that, and not knowing means missing it, so it is the one severity allowed to
 * wake them. Everything the owner can act on tomorrow is `warning` at most.
 */
export type NotificationSeverity = "info" | "warning" | "fatal";

export type NotificationStatus = "pending" | "delivered" | "exhausted";

export interface NotificationRow {
  id: string;
  userId: string;
  event: string;
  severity: NotificationSeverity;
  body: string;
  context: Record<string, unknown>;
  idempotencyKey: string;
  status: NotificationStatus;
  deliveredVia: string | null;
  deliveredAt: Date | null;
  createdAt: Date;
}

export interface NotificationAttemptRow {
  channel: string;
  delivered: boolean;
  reason: string | null;
  attemptedAt: Date;
}

/**
 * The notification outbox.
 *
 * Rows are written before delivery is attempted, never after it fails: a chain
 * of channels each carrying a 30-second timeout runs for minutes, and a crash
 * inside it must not be able to erase the fact that something needed saying.
 */
export class NotificationRepository {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Records an incident, or returns the existing row for the same key.
   *
   * The key is what makes a retrying producer safe. The task runner re-runs
   * failed work, and without this one failed booking would dial once per
   * attempt — turning a single problem into the storm the call budget exists
   * to prevent.
   */
  async enqueue(input: {
    userId: string;
    event: string;
    severity: NotificationSeverity;
    body: string;
    context?: Record<string, unknown>;
    idempotencyKey: string;
  }): Promise<{ notification: NotificationRow; created: boolean }> {
    const { rows } = await this.pool.query(
      `INSERT INTO notifications (user_id, event, severity, body, context, idempotency_key)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING ${COLUMNS}`,
      [
        input.userId,
        input.event,
        input.severity,
        input.body,
        JSON.stringify(input.context ?? {}),
        input.idempotencyKey,
      ],
    );

    const inserted = rows[0] as Record<string, unknown> | undefined;
    if (inserted) return { notification: toRow(inserted), created: true };

    // `DO NOTHING` returns no row on conflict, so the existing one is read back
    // rather than reported as a failure — a duplicate is the mechanism working.
    const existing = await this.pool.query(
      `SELECT ${COLUMNS} FROM notifications WHERE idempotency_key = $1`,
      [input.idempotencyKey],
    );
    return { notification: toRow(existing.rows[0] as Record<string, unknown>), created: false };
  }

  /**
   * Records one channel attempt.
   *
   * Failures are kept alongside successes rather than replaced by them: that
   * Telegram was unreachable at 02:00 is what explains the phone call at 02:01,
   * and it is the only way to tell a silently dropped channel from one that was
   * never tried.
   */
  async recordAttempt(
    notificationId: string,
    attempt: { channel: string; delivered: boolean; reason?: string | undefined },
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO notification_attempts (notification_id, channel, delivered, reason)
       VALUES ($1, $2, $3, $4)`,
      [notificationId, attempt.channel, attempt.delivered, attempt.reason ?? null],
    );
  }

  /** Marks the incident closed by the channel that finally worked. */
  async markDelivered(notificationId: string, channel: string): Promise<void> {
    await this.pool.query(
      `UPDATE notifications
          SET status = 'delivered', delivered_via = $2, delivered_at = now(), updated_at = now()
        WHERE id = $1`,
      [notificationId, channel],
    );
  }

  /**
   * Marks an incident as having run out of channels.
   *
   * Kept distinct from `pending` so the admin UI can separate "not tried yet"
   * from "we tried everything and could not reach you" — the second is the one
   * that needs a human to go looking.
   */
  async markExhausted(notificationId: string): Promise<void> {
    await this.pool.query(
      `UPDATE notifications SET status = 'exhausted', updated_at = now() WHERE id = $1`,
      [notificationId],
    );
  }

  /** Incidents that never reached the owner, newest first. */
  async listUndelivered(limit = 50): Promise<NotificationRow[]> {
    const { rows } = await this.pool.query(
      `SELECT ${COLUMNS} FROM notifications
        WHERE status <> 'delivered'
        ORDER BY created_at DESC
        LIMIT $1`,
      [limit],
    );
    return rows.map((row) => toRow(row as Record<string, unknown>));
  }

  async attemptsFor(notificationId: string): Promise<NotificationAttemptRow[]> {
    const { rows } = await this.pool.query(
      `SELECT channel, delivered, reason, attempted_at
         FROM notification_attempts
        WHERE notification_id = $1
        ORDER BY attempted_at`,
      [notificationId],
    );
    return rows.map((row) => {
      const r = row as Record<string, unknown>;
      return {
        channel: r["channel"] as string,
        delivered: r["delivered"] as boolean,
        reason: (r["reason"] as string | null) ?? null,
        attemptedAt: r["attempted_at"] as Date,
      };
    });
  }
}

const COLUMNS = `id, user_id, event, severity, body, context, idempotency_key,
                 status, delivered_via, delivered_at, created_at`;

function toRow(r: Record<string, unknown>): NotificationRow {
  return {
    id: r["id"] as string,
    userId: r["user_id"] as string,
    event: r["event"] as string,
    severity: r["severity"] as NotificationSeverity,
    body: r["body"] as string,
    context: (r["context"] as Record<string, unknown> | null) ?? {},
    idempotencyKey: r["idempotency_key"] as string,
    status: r["status"] as NotificationStatus,
    deliveredVia: (r["delivered_via"] as string | null) ?? null,
    deliveredAt: (r["delivered_at"] as Date | null) ?? null,
    createdAt: r["created_at"] as Date,
  };
}
