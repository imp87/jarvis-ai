import type { CandidateSlot } from "@jarvis/db";
import { wallTimeToUtc } from "@jarvis/shared";

/**
 * The owner's free time, as a short list of concrete slots.
 *
 * This is the closed set a phone call may choose from, and everything about it
 * is deliberately conservative: it is better to offer four good times than
 * twenty, because the list is read aloud and because every entry is something
 * the owner is committing to in advance.
 */

export interface BusyPeriod {
  start: Date;
  end: Date;
}

export interface FreeSlotOptions {
  /** Earliest the first slot may start. Usually "now plus a little". */
  from: Date;
  /** Latest any slot may end. */
  to: Date;
  durationMinutes: number;
  timezone: string;
  /** Local clock bounds of an acceptable appointment. */
  earliestHour?: number;
  latestHour?: number;
  /** Ceiling on how many are offered. */
  limit?: number;
  /**
   * Ceiling per calendar day.
   *
   * Without it the list is whatever the first free morning happens to hold —
   * six slots half an hour apart, which is not a choice anyone can answer on
   * the phone. Spreading across days is what makes "hätten Sie Mittwoch
   * vormittags oder lieber Donnerstag nachmittags" possible.
   */
  maxPerDay?: number;
  /** Only these weekdays (1 = Monday … 7 = Sunday). Defaults to Mon–Sat. */
  weekdays?: readonly number[];
}

const DEFAULTS = {
  earliestHour: 9,
  latestHour: 18,
  limit: 6,
  maxPerDay: 2,
  weekdays: [1, 2, 3, 4, 5, 6] as const,
};

/**
 * Slots that fit in the owner's calendar, on the hour and half hour.
 *
 * Aligned to :00 and :30 on purpose. A free window from 10:07 to 11:53 is real
 * but unsayable, and a business asked for "zehn Uhr sieben" will hear a machine.
 * Alignment costs a little availability and buys a list a person can answer.
 */
export function computeFreeSlots(busy: BusyPeriod[], options: FreeSlotOptions): CandidateSlot[] {
  const earliestHour = options.earliestHour ?? DEFAULTS.earliestHour;
  const latestHour = options.latestHour ?? DEFAULTS.latestHour;
  const limit = options.limit ?? DEFAULTS.limit;
  const maxPerDay = options.maxPerDay ?? DEFAULTS.maxPerDay;
  const weekdays = options.weekdays ?? DEFAULTS.weekdays;
  const durationMs = options.durationMinutes * 60_000;

  // Sorted and merged so an overlapping pair cannot leave a phantom gap between
  // them — two events 10:00–11:00 and 10:30–12:00 are busy until 12:00.
  const merged = mergeBusy(busy);

  const slots: CandidateSlot[] = [];
  for (const day of daysBetween(options.from, options.to, options.timezone)) {
    if (!weekdays.includes(day.weekday)) continue;
    let onThisDay = 0;

    // Stepped in whole hours rather than half: two slots on a day should be a
    // real choice, not 09:00 and 09:30.
    for (let minutes = earliestHour * 60; minutes + options.durationMinutes <= latestHour * 60; minutes += 60) {
      if (slots.length >= limit) return slots;
      if (onThisDay >= maxPerDay) break;

      const start = wallTimeToUtc(
        [day.year, day.month, day.day, Math.floor(minutes / 60), minutes % 60, 0],
        options.timezone,
        "UTC",
      );
      const end = new Date(start.getTime() + durationMs);

      if (start.getTime() < options.from.getTime()) continue;
      if (end.getTime() > options.to.getTime()) continue;
      if (merged.some((period) => overlaps(start, end, period))) continue;

      slots.push({
        id: `s${slots.length + 1}`,
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
      });
      onThisDay += 1;
      // Second slot of a day goes to the afternoon, so the pair is morning and
      // afternoon rather than two adjacent hours.
      if (onThisDay === 1 && minutes < 13 * 60) minutes = 13 * 60 - 60;
    }
  }
  return slots;
}

/** Half-open on both sides: an event ending exactly at `start` does not block it. */
function overlaps(start: Date, end: Date, period: BusyPeriod): boolean {
  return period.end.getTime() > start.getTime() && period.start.getTime() < end.getTime();
}

function mergeBusy(busy: BusyPeriod[]): BusyPeriod[] {
  const sorted = [...busy].sort((a, b) => a.start.getTime() - b.start.getTime());
  const merged: BusyPeriod[] = [];
  for (const period of sorted) {
    const last = merged[merged.length - 1];
    if (last && period.start.getTime() <= last.end.getTime()) {
      if (period.end.getTime() > last.end.getTime()) last.end = period.end;
      continue;
    }
    merged.push({ start: period.start, end: period.end });
  }
  return merged;
}

interface CalendarDay {
  year: number;
  month: number;
  day: number;
  /** ISO weekday, 1 = Monday. */
  weekday: number;
}

/**
 * The local calendar days the window touches.
 *
 * Walked in the owner's timezone rather than UTC: "Tuesday" has to mean their
 * Tuesday, and a window starting at 23:00 local is still that day.
 */
function daysBetween(from: Date, to: Date, timeZone: string): CalendarDay[] {
  const days: CalendarDay[] = [];
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  let cursor = from;
  let guard = 0;
  let previousKey = "";
  while (cursor.getTime() <= to.getTime() && guard < 400) {
    guard += 1;
    const key = formatter.format(cursor);
    if (key !== previousKey) {
      previousKey = key;
      const [year, month, day] = key.split("-").map(Number);
      days.push({
        year: year ?? 1970,
        month: month ?? 1,
        day: day ?? 1,
        // Derived at UTC noon of that local date, far enough from either
        // midnight that no zone can shift it onto the neighbouring day.
        weekday: isoWeekday(new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1, 12))),
      });
    }
    cursor = new Date(cursor.getTime() + 6 * 3_600_000);
  }
  return days;
}

function isoWeekday(date: Date): number {
  const day = date.getUTCDay();
  return day === 0 ? 7 : day;
}

/** How the slots are read out on the phone and shown back to the owner. */
export function describeSlots(slots: CandidateSlot[], timeZone: string): string {
  return slots
    .map((slot) => {
      const start = new Date(slot.startsAt);
      const day = new Intl.DateTimeFormat("de-DE", {
        timeZone,
        weekday: "long",
        day: "2-digit",
        month: "2-digit",
      }).format(start);
      const time = new Intl.DateTimeFormat("de-DE", {
        timeZone,
        hour: "2-digit",
        minute: "2-digit",
      }).format(start);
      return `${slot.id}: ${day} um ${time} Uhr`;
    })
    .join("\n");
}
