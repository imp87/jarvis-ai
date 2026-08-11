/**
 * Wall-clock arithmetic against IANA zones, with no dependency.
 *
 * Node ships the zone database with Intl, which is enough for the two things
 * this system actually needs: turning "11.08.2026, 07:45 in Europe/Berlin" into
 * the instant it denotes, and telling a model what time it is locally. Both
 * exist so that nothing upstream — least of all an LLM — has to do timezone
 * arithmetic itself.
 */

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
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

export function isUsableTimeZone(timeZone: string): boolean {
  if (!timeZone.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    // Exchange and older Outlook emit Windows zone names such as "W. Europe
    // Standard Time", which Intl rejects. Callers fall back rather than fail.
    return false;
  }
}

/** How far ahead of UTC the zone is at this instant, in milliseconds. */
export function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = partsFormatter(timeZone).formatToParts(new Date(instant));
  const read = (type: string): number => {
    const value = parts.find((part) => part.type === type)?.value;
    return value === undefined ? 0 : Number(value);
  };
  // Some ICU builds render midnight as hour 24 under hour12: false.
  const hour = read("hour") % 24;
  const asUtc = Date.UTC(read("year"), read("month") - 1, read("day"), hour, read("minute"), read("second"));
  return asUtc - instant;
}

/**
 * Converts a wall-clock time in an IANA zone to the instant it denotes.
 *
 * Format a guess in the target zone, measure how far the result drifted from
 * the wall time we wanted, and correct by that offset. The second pass matters
 * only around DST transitions, where the first guess can land on the wrong side
 * of the jump and therefore report the wrong offset.
 */
export function wallTimeToUtc(
  [year, month, day, hour, minute, second]: readonly [number, number, number, number, number, number],
  timeZone: string,
  fallbackTimeZone = "UTC",
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

/** The local calendar date in a zone, as [year, month, day]. */
export function dateInZone(date: Date, timeZone: string): [number, number, number] {
  const key = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  const [year, month, day] = key.split("-").map(Number);
  return [year ?? 1970, month ?? 1, day ?? 1];
}

/**
 * "Tuesday 2026-08-11 08:23:45 Europe/Berlin (UTC+02:00)".
 *
 * Written for a model to read. The weekday is there because "tomorrow at
 * 07:45" needs to know which day today is, and the offset is there so that any
 * UTC timestamp elsewhere in the context can be related to it without guessing.
 */
export function describeNow(date: Date, timeZone: string): string {
  const zone = isUsableTimeZone(timeZone) ? timeZone : "UTC";
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long" }).format(date);
  const parts = partsFormatter(zone).formatToParts(date);
  const read = (type: string): string => parts.find((part) => part.type === type)?.value ?? "00";
  const hour = String(Number(read("hour")) % 24).padStart(2, "0");
  const local = `${read("year")}-${read("month")}-${read("day")} ${hour}:${read("minute")}:${read("second")}`;
  return `${weekday} ${local} ${zone} (UTC${formatOffset(zoneOffsetMs(date.getTime(), zone))})`;
}

function formatOffset(offsetMs: number): string {
  const sign = offsetMs < 0 ? "-" : "+";
  const total = Math.abs(Math.round(offsetMs / 60_000));
  const hours = String(Math.floor(total / 60)).padStart(2, "0");
  const minutes = String(total % 60).padStart(2, "0");
  return `${sign}${hours}:${minutes}`;
}
