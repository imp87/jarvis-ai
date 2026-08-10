import type { EmbeddedMcpTool } from "@jarvis/mcp";
import type { CalDavService, CalendarEventView } from "../../services/caldav.js";
import { wallTimeToUtc } from "../../services/caldav/ical.js";

/**
 * Calendar reading as an embedded MCP server.
 *
 * Read-only on purpose for now: creating and moving appointments is a side
 * effect on someone else's day, and it deserves the same explicit-approval
 * treatment that sending mail gets rather than being bolted on with the reads.
 *
 * Both tools speak in calendar names and dates only. Event UIDs and account
 * ids never appear in the output — an assistant that reads an identifier out
 * loud on the phone is unusable, which the mail draft tools learned the hard
 * way.
 */
export function buildEmbeddedCalendarTools(caldav: CalDavService): EmbeddedMcpTool[] {
  return [
    {
      name: "list_calendars",
      description:
        "List the calendars Jarvis can read, with the account each belongs to. Use it when the user " +
        "asks which calendars exist, or to find the exact name to pass to list_events.",
      inputSchema: { type: "object", properties: {} },
      async execute(_args, ctx) {
        const accounts = await caldav.listCalendars(ctx.userId);
        if (accounts.length === 0) {
          return { content: "Es ist kein Kalenderkonto eingerichtet. Konten legt der Nutzer im Admin-UI an." };
        }
        const lines: string[] = [];
        for (const { account, calendars } of accounts) {
          const status = caldav.statusFor(account.id);
          if (calendars.length === 0) {
            lines.push(
              `${account.name}: keine Kalender gefunden` +
                (status.error ? ` (${status.error})` : "") + ".",
            );
            continue;
          }
          const usable = calendars.filter((calendar) => calendar.enabled && calendar.supportsEvents);
          if (usable.length === 0) {
            lines.push(`${account.name}: keine Kalender mit Terminen (nur Aufgabenlisten).`);
            continue;
          }
          lines.push(
            `${account.name} (Zeitzone ${account.timezone}):\n` +
              usable
                .map((calendar) => `  - ${calendar.displayName}${calendar.readOnly ? " (nur lesen)" : ""}`)
                .join("\n"),
          );
        }
        return { content: lines.join("\n\n") };
      },
    },
    {
      name: "list_events",
      description:
        "Read appointments from the user's calendars for a date range. This is the only way to know " +
        "what is actually scheduled — never answer from memory or guess.\n\n" +
        "Defaults to today. Use `days` for a span ('this week' is days=7) and `from` for a day other " +
        "than today. Report what is returned, in the user's words, without reading out any identifiers.",
      inputSchema: {
        type: "object",
        properties: {
          from: {
            type: "string",
            description: "First day, as YYYY-MM-DD in the user's timezone. Defaults to today.",
          },
          days: {
            type: "integer",
            minimum: 1,
            maximum: 62,
            description: "How many days to cover, starting at `from`. Defaults to 1 (that day only).",
          },
          calendar: {
            type: "string",
            description: "Optional calendar name filter, as shown by list_calendars.",
          },
        },
      },
      async execute(args, ctx) {
        const timezone = await caldav.timezoneFor(ctx.userId);
        const days = clampDays(args["days"]);
        const fromArg = typeof args["from"] === "string" ? args["from"].trim() : "";
        const startDay = fromArg ? parseDay(fromArg) : todayIn(timezone);
        if (!startDay) {
          return { content: "`from` muss ein Datum im Format JJJJ-MM-TT sein.", isError: true };
        }

        const from = startOfDay(startDay, timezone);
        const to = startOfDay(addDays(startDay, days), timezone);
        const calendarFilter = typeof args["calendar"] === "string" ? args["calendar"] : undefined;
        const result = await caldav.listEvents(ctx.userId, from, to, calendarFilter);

        const header = describeRange(startDay, days);
        const sections: string[] = [];

        if (result.events.length === 0) {
          sections.push(`${header}: keine Termine.`);
        } else {
          sections.push(`${header}:`);
          sections.push(renderEvents(result.events, timezone));
        }
        if (result.unresolvedRecurring.length > 0) {
          sections.push(
            "Wiederkehrende Termine, die der Server nicht aufgelöst hat (Datum daher unklar):\n" +
              result.unresolvedRecurring
                .map((view) => `  - ${view.event.summary} (${view.calendarName})`)
                .join("\n"),
          );
        }
        if (result.warnings.length > 0) {
          sections.push(`Hinweise:\n${result.warnings.map((warning) => `  - ${warning}`).join("\n")}`);
        }
        // A partial answer that looks complete is worse than a stated gap.
        const isError = result.events.length === 0 && result.warnings.length > 0;
        return { content: sections.join("\n\n"), ...(isError ? { isError: true } : {}) };
      },
    },
  ];
}

const MAX_RENDERED_EVENTS = 60;

function renderEvents(views: CalendarEventView[], timezone: string): string {
  const shown = views.slice(0, MAX_RENDERED_EVENTS);
  const multipleCalendars = new Set(views.map((view) => view.calendarName)).size > 1;
  const byDay = new Map<string, CalendarEventView[]>();
  for (const view of shown) {
    const key = dayKey(view.event.start, view.event.allDay ? "UTC" : timezone);
    const bucket = byDay.get(key);
    if (bucket) bucket.push(view);
    else byDay.set(key, [view]);
  }

  const blocks: string[] = [];
  for (const [key, dayViews] of [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const lines = dayViews.map((view) => {
      const when = view.event.allDay ? "ganztägig" : formatTimeRange(view, timezone);
      const where = view.event.location ? `, ${view.event.location}` : "";
      const which = multipleCalendars ? ` [${view.calendarName}]` : "";
      const cancelled = view.event.status === "CANCELLED" ? " (abgesagt)" : "";
      return `  - ${when}: ${view.event.summary}${where}${cancelled}${which}`;
    });
    blocks.push(`${formatDayHeading(key)}\n${lines.join("\n")}`);
  }

  if (views.length > shown.length) {
    blocks.push(`  … und ${views.length - shown.length} weitere Termine.`);
  }
  return blocks.join("\n\n");
}

function formatTimeRange(view: CalendarEventView, timezone: string): string {
  const start = formatTime(view.event.start, timezone);
  // A zero-length event is an instant, not a range.
  if (view.event.end.getTime() <= view.event.start.getTime()) return start;
  const end = formatTime(view.event.end, timezone);
  return `${start}–${end}`;
}

function formatTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("de-DE", { timeZone, hour: "2-digit", minute: "2-digit" }).format(date);
}

/**
 * "Montag, 11.08.2026" from a YYYY-MM-DD key. The key already denotes a local
 * calendar day, so the weekday is derived at UTC noon — far enough from either
 * midnight that no zone can shift it onto the neighbouring day.
 */
function formatDayHeading(key: string): string {
  const [year, month, day] = key.split("-").map(Number);
  const noon = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1, 12));
  const weekday = new Intl.DateTimeFormat("de-DE", { timeZone: "UTC", weekday: "long" }).format(noon);
  return `${weekday}, ${String(day).padStart(2, "0")}.${String(month).padStart(2, "0")}.${year}`;
}

function describeRange(startDay: DayParts, days: number): string {
  const first = formatDayHeading(dayPartsKey(startDay));
  if (days === 1) return first;
  const last = formatDayHeading(dayPartsKey(addDays(startDay, days - 1)));
  return `${first} bis ${last}`;
}

interface DayParts {
  year: number;
  month: number;
  day: number;
}

function clampDays(raw: unknown): number {
  const value = Math.floor(Number(raw ?? 1));
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(62, value));
}

function parseDay(value: string): DayParts | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return undefined;
  const [, year, month, day] = match;
  const parts = { year: Number(year), month: Number(month), day: Number(day) };
  if (parts.month < 1 || parts.month > 12 || parts.day < 1 || parts.day > 31) return undefined;
  return parts;
}

function todayIn(timeZone: string): DayParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const read = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: read("year"), month: read("month"), day: read("day") };
}

function addDays(parts: DayParts, days: number): DayParts {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function startOfDay(parts: DayParts, timeZone: string): Date {
  return wallTimeToUtc([parts.year, parts.month, parts.day, 0, 0, 0], timeZone, "UTC");
}

function dayKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function dayPartsKey(parts: DayParts): string {
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}
