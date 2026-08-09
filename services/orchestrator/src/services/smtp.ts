import nodemailer from "nodemailer";
import type { EmailRepository, ImapReplyDraftRow } from "@jarvis/db";
import { decryptSecret, type Logger } from "@jarvis/shared";

/** Sends only a persisted, owner-approved draft. It never asks the model to compose or address mail. */
export class SmtpService {
  constructor(
    private readonly emails: EmailRepository,
    private readonly masterKey: Buffer,
    private readonly logger: Logger,
  ) {}

  async sendApprovedDraft(userId: string, draftId: string, replacementBody?: string): Promise<ImapReplyDraftRow> {
    const draft = await this.emails.getReplyDraft(userId, draftId);
    if (!draft) throw new Error("Reply draft not found");
    if (draft.status !== "pending") throw new Error(`Reply draft is already ${draft.status}`);
    if (replacementBody?.trim()) {
      await this.emails.updateReplyDraftBody(draft.id, replacementBody.trim());
      draft.bodyText = replacementBody.trim();
    }

    const account = await this.emails.getAccount(draft.accountId);
    if (!account?.smtpHost) throw new Error("SMTP is not configured for this mail account");
    const username = account.smtpUsername ?? account.username;
    const password = decryptSecret(account.smtpPasswordEnc ?? account.passwordEnc, this.masterKey);
    const from = account.smtpFrom ?? username;
    const transport = nodemailer.createTransport({
      host: account.smtpHost,
      port: account.smtpPort,
      secure: account.smtpSecure,
      requireTLS: !account.smtpSecure,
      auth: { user: username, pass: password },
    });
    await transport.sendMail({
      from,
      to: draft.toAddress,
      subject: draft.subject,
      text: draft.bodyText,
      ...(draft.inReplyTo ? { inReplyTo: draft.inReplyTo, references: draft.inReplyTo } : {}),
    });
    await this.emails.markReplyDraftSent(draft.id);
    this.logger.info({ account: account.name, draftId: draft.id, to: maskAddress(draft.toAddress) }, "approved email reply sent");
    return { ...draft, status: "sent", sentAt: new Date() };
  }
}

function maskAddress(value: string): string {
  const at = value.lastIndexOf("@");
  if (at < 2) return "***";
  return `${value.slice(0, 2)}***${value.slice(at)}`;
}
