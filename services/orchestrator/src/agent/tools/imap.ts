import type { EmailRepository } from "@jarvis/db";
import type { EmbeddedMcpTool } from "@jarvis/mcp";

/** Read-only tools for the local mirror maintained by the embedded IMAP watcher. */
export function buildEmbeddedImapTools(emails: EmailRepository): EmbeddedMcpTool[] {
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

function preview(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= 500 ? compact : `${compact.slice(0, 500)}…`;
}
