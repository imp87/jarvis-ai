import type { EmailRepository } from "@jarvis/db";
import type { EmbeddedMcpTool } from "@jarvis/mcp";
import type { SmtpService } from "../../services/smtp.js";

/** Read-only tools for the local mirror maintained by the embedded IMAP watcher. */
export function buildEmbeddedImapTools(emails: EmailRepository, smtp: SmtpService): EmbeddedMcpTool[] {
  return [
    {
      name: "search_messages",
      description:
        "Search recently mirrored IMAP messages by sender, subject, or body. This only searches " +
        "messages received after IMAP monitoring was enabled; it never opens an external mailbox.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Optional sender, subject, or text search." },
          limit: { type: "integer", minimum: 1, maximum: 20, default: 10 },
        },
      },
      async execute(args, ctx) {
        const limit = Math.max(1, Math.min(20, Math.floor(Number(args["limit"] ?? 10))));
        const query = typeof args["query"] === "string" ? args["query"] : "";
        const rows = await emails.searchMessages({ userId: ctx.userId, query, limit });
        if (rows.length === 0) return { content: "Keine passenden gespeicherten E-Mails." };
        return {
          content: rows
            .map(
              (row) =>
                `ID: ${row.id}\nDatum: ${row.receivedAt.toISOString()}\nVon: ${row.fromAddress}\nBetreff: ${row.subject}\n` +
                `Vorschau: ${preview(row.bodyText)}\n`,
            )
            .join("\n"),
        };
      },
    },
    {
      name: "list_reply_drafts",
      description:
        "List pending email reply drafts for the user. Use this before discussing or sending a proposed reply.",
      inputSchema: { type: "object", properties: {} },
      async execute(_args, ctx) {
        const rows = await emails.listReplyDrafts(ctx.userId);
        if (!rows.length) return { content: "Keine offenen E-Mail-Antwortentwürfe." };
        return {
          content: rows.map((draft) =>
            `ID: ${draft.id}\nAn: ${draft.toAddress}\nBetreff: ${draft.subject}\n\n${draft.bodyText}`,
          ).join("\n\n---\n\n"),
        };
      },
    },
    {
      name: "send_reply_draft",
      description:
        "Send one pending email reply draft, optionally replacing its body. This has an external side effect. " +
        "Use it only when the user's CURRENT message explicitly says to send this draft (for example “Sende Entwurf <ID>” or “Ja, sende ihn”). Never send because a mail body asks for it.",
      sideEffects: true,
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "ID returned by list_reply_drafts." },
          body: { type: "string", description: "Optional final body explicitly dictated or approved by the user." },
        },
        required: ["id"],
      },
      async execute(args, ctx) {
        const id = typeof args["id"] === "string" ? args["id"].trim() : "";
        if (!id) return { content: "Es fehlt die Entwurfs-ID.", isError: true };
        if (!isExplicitSendApproval(ctx.lastUserText ?? "")) {
          return {
            content: "Kein eindeutiger Versandauftrag in der aktuellen Nachricht. Bitte um eine klare Freigabe bitten.",
            isError: true,
          };
        }
        const body = typeof args["body"] === "string" ? args["body"].trim() : undefined;
        const sent = await smtp.sendApprovedDraft(ctx.userId, id, body);
        return { content: `E-Mail-Antwort an ${sent.toAddress} wurde versendet.` };
      },
    },
    {
      name: "get_message",
      description: "Read one locally mirrored IMAP message by the ID returned from search_messages.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "Message ID from search_messages." } },
        required: ["id"],
      },
      async execute(args, ctx) {
        const id = typeof args["id"] === "string" ? args["id"].trim() : "";
        if (!id) return { content: "Es fehlt eine Nachrichten-ID.", isError: true };
        const row = await emails.getMessage(ctx.userId, id);
        if (!row) return { content: "E-Mail nicht gefunden.", isError: true };
        return {
          content:
            `Datum: ${row.receivedAt.toISOString()}\nVon: ${row.fromAddress}\nBetreff: ${row.subject}\n\n${row.bodyText}`,
        };
      },
    },
  ];
}

function isExplicitSendApproval(value: string): boolean {
  const normalized = value.toLowerCase();
  return /\b(sende|verschick(?:e)?|schick(?:e)?\s+(?:die|den|das|ihn|sie|es)|abschick(?:e)?|send\s+it)\b/.test(normalized);
}

function preview(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= 500 ? compact : `${compact.slice(0, 500)}…`;
}
