/**
 * Just enough RFC 5545 to read VEVENTs back out of a calendar-data payload.
 *
 * Deliberately not a general iCalendar implementation. The server is asked to
 * expand recurrences (RFC 4791 `<expand>`), so what arrives here is normally a
 * flat list of concrete instances with UTC timestamps — which removes RRULE,
 * EXDATE and RECURRENCE-ID arithmetic, by far the largest and most error-prone
 * part of the format. The TZID handling below exists for the servers that
 * decline to expand and hand back the master events instead.
 */

export interface CalendarEvent {
  uid: string;
  summary: string;
  description: string | null;
  location: string | null;
  start: Date;
  end: Date;
  /** DTSTART was a DATE, not a DATE-TIME: render as a day, not a time. */
  allDay: boolean;
  status: string | null;
  /** True when the server returned a master event with an RRULE unexpanded. */
  recurring: boolean;
}

interface RawProperty {
  name: string;
  params: Record<string, string>;
  value: string;
}

/**
 * @param fallbackTimeZone Zone for floating times — values with neither a `Z`
 *   suffix nor a TZID. RFC 5545 says these mean "local time wherever the event
 *   is read", which for a personal assistant is the owner's zone.
 */
export function parseVEvents(ics: string, fallbackTimeZone: string): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  let current: RawProperty[] | undefined;

  for (const line of unfold(ics)) {
    const upper = line.toUpperCase();
    if (upper === "BEGIN:VEVENT") {
      current = [];
      continue;
    }
    if (upper === "END:VEVENT") {
      if (current) {
        const event = buildEvent(current, fallbackTimeZone);
        if (event) events.push(event);
      }
      current = undefined;
      continue;
    }
    if (!current) continue;
    // A VALARM nested inside the VEVENT carries its own TRIGGER and DESCRIPTION.
    // Those must not overwrite the event's, so skip the whole sub-component.
    if (upper.startsWith("BEGIN:")) {
      current.push({ name: "__NESTED__", params: {}, value: upper.slice(6) });
      continue;
    }
    if (upper.startsWith("END:")) {
      const index = current.findIndex((p) => p.name === "__NESTED__" && p.value === upper.slice(4));
      if (index >= 0) current.splice(index, 1);
      continue;
    }
    if (current.some((p) => p.name === "__NESTED__")) continue;
    const property = parseProperty(line);
    if (property) current.push(property);
  }

  return events;
}

/** Physical lines joined into logical ones: a leading space or tab continues. */
export function unfold(ics: string): string[] {
  const lines: string[] = [];
  for (const raw of ics.split(/\r\n|\n|\r/)) {
    if ((raw.startsWith(" ") || raw.startsWith("\t")) && lines.length > 0) {
      lines[lines.length - 1] += raw.slice(1);
      continue;
    }
    lines.push(raw);
  }
  return lines.filter((line) => line.trim().length > 0);
}

function buildEvent(properties: RawProperty[], fallbackTimeZone: string): CalendarEvent | undefined {
  const find = (name: string): RawProperty | undefined =>
    properties.find((property) => property.name === name);

  const dtStart = find("DTSTART");
  if (!dtStart) return undefined;
  const start = parseIcalDate(dtStart, fallbackTimeZone);
  if (!start) return undefined;

  const dtEnd = find("DTEND");
  const duration = find("DURATION");
  let end = dtEnd ? parseIcalDate(dtEnd, fallbackTimeZone)?.date : undefined;
  if (!end && duration) {
    const ms = parseIcalDuration(duration.value);
    if (ms !== undefined) end = new Date(start.date.getTime() + ms);
  }
  if (!end) {
    // RFC 5545: a DATE start with no end lasts one day; a DATE-TIME start with
    // no end is an instant.
    end = start.allDay ? new Date(start.date.getTime() + 86_400_000) : start.date;
  }

  return {
    uid: find("UID")?.value ?? "",
    summary: unescapeText(find("SUMMARY")?.value ?? "") || "(ohne Titel)",
    description: nullableText(find("DESCRIPTION")?.value),
    location: nullableText(find("LOCATION")?.value),
    start: start.date,
    end,
    allDay: start.allDay,
    status: find("STATUS")?.value?.toUpperCase() ?? null,
    recurring: Boolean(find("RRULE")),
  };
}

function nullableText(value: string | undefined): string | null {
  const text = unescapeText(value ?? "").trim();
  return text.length > 0 ? text : null;
}

export function parseProperty(line: string): RawProperty | undefined {
  // The name/params section ends at the first colon that is not inside a quoted
  // parameter value — "TZID=\"GMT+1:00\"" is legal and contains one.
  let colon = -1;
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') quoted = !quoted;
    else if (char === ":" && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon === -1) return undefined;

  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const segments = splitParams(head);
  const name = (segments.shift() ?? "").trim().toUpperCase();
  if (!name) return undefined;

  const params: Record<string, string> = {};
  for (const segment of segments) {
    const eq = segment.indexOf("=");
    if (eq === -1) continue;
    const key = segment.slice(0, eq).trim().toUpperCase();
    let raw = segment.slice(eq + 1).trim();
    if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) raw = raw.slice(1, -1);
    params[key] = raw;
  }
  return { name, params, value };
}

function splitParams(head: string): string[] {
  const parts: string[] = [];
  let buffer = "";
  let quoted = false;
  for (const char of head) {
    if (char === '"') {
      quoted = !quoted;
      buffer += char;
      continue;
    }
    if (char === ";" && !quoted) {
      parts.push(buffer);
      buffer = "";
      continue;
    }
    buffer += char;
  }
  parts.push(buffer);
  return parts;
}

export function parseIcalDate(
  property: RawProperty,
  fallbackTimeZone: string,
): { date: Date; allDay: boolean } | undefined {
  const value = property.value.trim();
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    // Anchored at UTC midnight and always rendered with timeZone "UTC", so an
    // all-day event cannot drift a day either way.
    return { date: new Date(Date.UTC(Number(y), Number(m) - 1, Number(d))), allDay: true };
  }

  const dateTime = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(value);
  if (!dateTime) return undefined;
  const [, y, m, d, hh, mm, ss, zulu] = dateTime;
  const parts = [Number(y), Number(m), Number(d), Number(hh), Number(mm), Number(ss)] as const;
  if (zulu) {
    return {
      date: new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5])),
      allDay: false,
    };
  }
  const zone = property.params["TZID"] ?? fallbackTimeZone;
  return { date: wallTimeToUtc(parts, zone, fallbackTimeZone), allDay: false };
}

/** ISO 8601 durations as RFC 5545 restricts them: P[n]DT[n]H[n]M[n]S, P[n]W. */
export function parseIcalDuration(value: string): number | undefined {
  const match = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
    value.trim().toUpperCase(),
  );
  if (!match) return undefined;
  const [, sign, weeks, days, hours, minutes, seconds] = match;
  if (!weeks && !days && !hours && !minutes && !seconds) return undefined;
  const total =
    Number(weeks ?? 0) * 604_800_000 +
    Number(days ?? 0) * 86_400_000 +
    Number(hours ?? 0) * 3_600_000 +
    Number(minutes ?? 0) * 60_000 +
    Number(seconds ?? 0) * 1_000;
  return sign === "-" ? -total : total;
}

/**
 * Converts a wall-clock time in an IANA zone to the instant it denotes.
 *
 * Node ships the zone database with Intl, so this needs no dependency: format
 * a guess in the target zone, measure how far the result drifted from the wall
 * time we wanted, and correct by that offset. The second pass matters only
 * around DST transitions, where the first guess can land on the wrong side of
 * the jump and report the wrong offset.
 */
export function wallTimeToUtc(
  [year, month, day, hour, minute, second]: readonly [number, number, number, number, number, number],
  timeZone: string,
  fallbackTimeZone: string,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  const zone = isUsableTimeZone(timeZone) ? timeZone : fallbackTimeZone;
  let offset = zoneOffsetMs(naive, zone);
  let instant = naive - offset;
  const settled = zoneOffsetMs(instant, zone);
  if (settled !== offset) {
    offset = settled;
    instant = naive - offset;
  }
  return new Date(instant);
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function offsetFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** How far ahead of UTC the zone is at this instant, in milliseconds. */
function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = offsetFormatter(timeZone).formatToParts(new Date(instant));
  const read = (type: string): number => {
    const value = parts.find((part) => part.type === type)?.value;
    return value === undefined ? 0 : Number(value);
  };
  // Some ICU builds render midnight as hour 24 under hour12: false.
  const hour = read("hour") % 24;
  const asUtc = Date.UTC(read("year"), read("month") - 1, read("day"), hour, read("minute"), read("second"));
  return asUtc - instant;
}

export function isUsableTimeZone(timeZone: string): boolean {
  if (!timeZone.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    // Exchange and older Outlook servers emit Windows zone names such as
    // "W. Europe Standard Time", which Intl rejects. Falling back to the
    // account zone is better than dropping the event.
    return false;
  }
}

/** RFC 5545 text escaping: \n \, \; \\ */
export function unescapeText(value: string): string {
  return value.replace(/\\([nN,;\\])/g, (_match, char: string) =>
    char === "n" || char === "N" ? "\n" : char,
  );
}
