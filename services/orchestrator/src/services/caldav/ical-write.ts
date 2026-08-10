import { randomUUID } from "node:crypto";

/**
 * Generating the VEVENTs Jarvis writes back.
 *
 * Timed events are always written in UTC rather than with a TZID. A TZID
 * property is only valid alongside a matching VTIMEZONE component, and hand
 * rolling those (with their DST rules) to express an instant that UTC already
 * expresses exactly would be effort spent on a worse representation. The
 * limitation this accepts is recurrence: a repeating event genuinely needs a
 * local anchor, and creating those is not supported here.
 */

export interface EventDraft {
  uid: string;
  summary: string;
  description?: string | null;
  location?: string | null;
  /** Inclusive start. For an all-day event, the first day. */
  start: Date;
  /** Exclusive end. For an all-day event, the day after the last one. */
  end: Date;
  allDay: boolean;
  /** Preserved across an update so the sequence keeps climbing, per RFC 5545. */
  sequence?: number;
}

export function newEventUid(): string {
  return `${randomUUID()}@jarvis`;
}

export function buildCalendarObject(draft: EventDraft): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Jarvis//CalDAV//DE",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${escapeText(draft.uid)}`,
    `DTSTAMP:${utcStamp(new Date())}`,
    draft.allDay ? `DTSTART;VALUE=DATE:${dateStamp(draft.start)}` : `DTSTART:${utcStamp(draft.start)}`,
    draft.allDay ? `DTEND;VALUE=DATE:${dateStamp(draft.end)}` : `DTEND:${utcStamp(draft.end)}`,
    `SUMMARY:${escapeText(draft.summary)}`,
  ];
  if (draft.location) lines.push(`LOCATION:${escapeText(draft.location)}`);
  if (draft.description) lines.push(`DESCRIPTION:${escapeText(draft.description)}`);
  if (draft.sequence !== undefined && draft.sequence > 0) lines.push(`SEQUENCE:${draft.sequence}`);
  lines.push("END:VEVENT", "END:VCALENDAR");

  // RFC 5545 wants CRLF and no line over 75 octets.
  return `${lines.flatMap(foldLine).join("\r\n")}\r\n`;
}

export function utcStamp(date: Date): string {
  return `${date.toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`;
}

/** The calendar date an all-day boundary denotes, read at UTC as it was built. */
export function dateStamp(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

export function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\n|\r/g, "\\n");
}

/**
 * Folds one logical line into 75-octet physical lines.
 *
 * The limit is octets, not characters, so folding is done on the UTF-8 buffer —
 * and never in the middle of a multi-byte sequence, which would corrupt an
 * umlaut in a German appointment title.
 */
export function foldLine(line: string): string[] {
  const buffer = Buffer.from(line, "utf8");
  if (buffer.byteLength <= 75) return [line];

  const parts: string[] = [];
  let offset = 0;
  let limit = 75;
  while (offset < buffer.byteLength) {
    let take = Math.min(limit, buffer.byteLength - offset);
    // Back off until the slice ends on a character boundary: a continuation
    // byte is 0b10xxxxxx, so retreat while the next byte is one.
    while (take > 1 && offset + take < buffer.byteLength && (buffer[offset + take]! & 0xc0) === 0x80) {
      take -= 1;
    }
    const chunk = buffer.subarray(offset, offset + take).toString("utf8");
    parts.push(offset === 0 ? chunk : ` ${chunk}`);
    offset += take;
    // Continuation lines spend one octet on the leading space.
    limit = 74;
  }
  return parts;
}
