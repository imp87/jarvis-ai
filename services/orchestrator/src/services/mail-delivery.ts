import type { CallRepository, EmailRepository, ImapDeliveryEventRow, ImapFallbackRoute, ImapMessageRoute } from "@jarvis/db";
import type { Logger } from "@jarvis/shared";
import type { CallService } from "./calls.js";
import type { NotificationService } from "./notify.js";

export interface MailDeliveryDecision {
  route: ImapMessageRoute;
  summary: string;
  replyDraft: string | null;
  replyMode: "none" | "draft" | "ask";
  draftId?: string | undefined;
  fallbackChannel: ImapFallbackRoute;
  callRetryCount: number;
  callRetryDelayMinutes: number;
}

export interface MailDeliveryDependencies {
  emails: EmailRepository;
  calls: CallService;
  callLogs: CallRepository;
  notifications: NotificationService;
  logger: Logger;
  ownerPhoneNumber?: string | undefined;
}

/**
 * Delivers the decision made for an incoming mail. Phone escalations are stored
 * separately from call logs so a missed call can be retried after a restart and
 * eventually fall back to a chat message without another LLM decision.
 */
export class MailDeliveryService {
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: MailDeliveryDependencies) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.reconcile(), 15_000);
    void this.reconcile();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async deliver(input: {
    accountId: string;
    messageId: string;
    userId: string;
    accountName: string;
    decision: MailDeliveryDecision;
  }): Promise<void> {
    if (input.decision.route === "none") return;
    const text = formatMailNotification(input.accountName, input.decision);
    if (input.decision.route === "telegram" || input.decision.route === "discord") {
      await this.deps.notifications.send(input.userId, input.decision.route, text);
      return;
    }

    if (!this.deps.ownerPhoneNumber) {
      await this.sendFallback(input.userId, input.decision.fallbackChannel, text, "phone number is not configured");
      return;
    }

    const event = await this.deps.emails.createDeliveryEvent({
      accountId: input.accountId,
      messageId: input.messageId,
      userId: input.userId,
      summary: input.decision.summary,
      replyDraft: input.decision.replyDraft,
      fallbackChannel: input.decision.fallbackChannel,
      callContext:
        `Master, wichtige E-Mail in ${input.accountName}: ${input.decision.summary}.` +
        "\n\n[JARVIS_CONTEXT]\n" +
        (input.decision.draftId
          ? `Ein Antwortentwurf mit der ID ${input.decision.draftId} liegt bereit. Wenn Master ihn freigibt, versende genau diesen Entwurf über den IMAP-MCP.`
          : "Wenn Master antworten möchte, suche die Mail im IMAP-MCP und erstelle zuerst einen Antwortentwurf. Nach einer klaren Freigabe darfst du ihn versenden."),
      callsAttempted: 0,
      maxCallAttempts: 1 + input.decision.callRetryCount,
      retryDelayMinutes: input.decision.callRetryDelayMinutes,
    });
    await this.attemptCall(event);
  }

  /** Called by the voice pipeline callback whenever a tracked call changes state. */
  async onCallStatus(callId: string, status: "dialing" | "in_progress" | "completed" | "failed"): Promise<void> {
    const event = await this.deps.emails.getDeliveryEventByCall(callId);
    if (!event || event.state === "delivered" || event.state === "fallback_sent") return;
    if (status === "in_progress" || status === "completed") {
      await this.deps.emails.updateDeliveryEvent(event.id, { state: "delivered", retryAt: null });
      return;
    }
    if (status === "failed") await this.handleFailedCall(event);
  }

  private async reconcile(): Promise<void> {
    const waiting = await this.deps.emails.listAwaitingDeliveryEvents();
    for (const event of waiting) {
      if (!event.callId) continue;
      const call = await this.deps.callLogs.get(event.callId);
      if (call?.status === "in_progress" || call?.status === "completed") {
        await this.deps.emails.updateDeliveryEvent(event.id, { state: "delivered", retryAt: null });
      } else if (call?.status === "failed" || call?.status === "blocked") {
        await this.handleFailedCall(event);
      }
    }
    const due = await this.deps.emails.listDueDeliveryEvents();
    for (const event of due) await this.attemptCall(event);
  }

  private async attemptCall(event: ImapDeliveryEventRow): Promise<void> {
    if (!this.deps.ownerPhoneNumber) {
      await this.fallback(event, "phone number is not configured");
      return;
    }
    const outcome = await this.deps.calls.requestCall({
      toNumber: this.deps.ownerPhoneNumber,
      reason: `Important incoming email: ${event.summary.slice(0, 200)}`,
      context: event.callContext,
      urgent: false,
    });
    if (!outcome.placed) {
      const attempted = { ...event, callsAttempted: event.callsAttempted + 1 };
      await this.deps.emails.updateDeliveryEvent(event.id, { callsAttempted: attempted.callsAttempted });
      await this.handleFailedCall(attempted, outcome.reason);
      return;
    }
    await this.deps.emails.updateDeliveryEvent(event.id, {
      callId: outcome.call.id,
      callsAttempted: event.callsAttempted + 1,
      state: "awaiting_call",
      retryAt: null,
    });
  }

  private async handleFailedCall(event: ImapDeliveryEventRow, reason?: string): Promise<void> {
    const attempts = event.callsAttempted;
    if (attempts < event.maxCallAttempts) {
      const retryAt = new Date(Date.now() + event.retryDelayMinutes * 60_000);
      await this.deps.emails.updateDeliveryEvent(event.id, { state: "retry_scheduled", retryAt });
      this.deps.logger.info({ eventId: event.id, retryAt, attempts, reason }, "mail call retry scheduled");
      return;
    }
    await this.fallback(event, reason ?? "call was not answered");
  }

  private async fallback(event: ImapDeliveryEventRow, reason: string): Promise<void> {
    await this.sendFallback(event.userId, event.fallbackChannel, formatMailNotification("E-Mail", {
      summary: event.summary,
      replyDraft: event.replyDraft,
      replyMode: event.replyDraft ? "draft" : "none",
    }), reason);
    await this.deps.emails.updateDeliveryEvent(event.id, { state: "fallback_sent", retryAt: null });
  }

  private async sendFallback(userId: string, channel: ImapFallbackRoute, text: string, reason: string): Promise<void> {
    if (channel === "none") {
      this.deps.logger.info({ userId, reason }, "mail call fallback intentionally suppressed");
      return;
    }
    await this.deps.notifications.send(userId, channel, `${text}\n\nAnruf nicht zugestellt: ${reason}.`);
  }
}

export function formatMailNotification(accountName: string, decision: Pick<MailDeliveryDecision, "summary" | "replyDraft" | "replyMode" | "draftId">): string {
  let text = `E-Mail (${accountName}): ${decision.summary}`;
  if (decision.replyMode === "draft" && decision.replyDraft) {
    text += `\n\nAntwortentwurf${decision.draftId ? ` (${decision.draftId})` : ""}:\n${decision.replyDraft}`;
    text += decision.draftId ? `\n\nZum Versenden: „Sende Entwurf ${decision.draftId}“.` : "";
  }
  if (decision.replyMode === "ask") text += "\n\nSoll ich eine Antwort vorbereiten? Sag mir einfach, was Jarvis antworten soll.";
  return text;
}
