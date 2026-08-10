import { decryptSecret, type Logger } from "@jarvis/shared";
import type { CalDavAccountRow, CalDavCalendarRow, CalendarRepository } from "@jarvis/db";
import { CalDavClient, CalDavError } from "./caldav/client.js";
import type { CalendarEvent } from "./caldav/ical.js";
import { buildCalendarObject, newEventUid, type EventDraft } from "./caldav/ical-write.js";

export interface CalDavServiceDependencies {
  calendars: CalendarRepository;
  masterKey: Buffer;
  logger: Logger;
  /**
   * Zone used to render days when no account states one of its own. Sourced
   * from the deployment's configured timezone — see the note on
   * `caldav_accounts.timezone` for why each account also carries its own.
   */
  defaultTimezone: string;
  timeoutMs?: number;
  /** Injection point for tests; production always uses global fetch. */
  fetchImpl?: typeof fetch;
}

export interface CalDavAccountStatus {
  accountId: string;
  state: "stopped" | "discovering" | "ready" | "error";
  error?: string;
  calendarCount?: number;
  lastCheckedAt?: Date;
}

export interface CalendarEventView {
  accountName: string;
  calendarName: string;
  timezone: string;
  event: CalendarEvent;
  /** Everything needed to change this event, and nothing the user ever sees. */
  source: {
    accountId: string;
    calendarUrl: string;
    readOnly: boolean;
    href: string;
    etag: string | null;
    /** VEVENTs sharing this resource. More than one means a recurrence set. */
    siblingCount: number;
  };
}

export interface EventChanges {
  summary?: string;
  location?: string | null;
  description?: string | null;
  start?: Date;
  end?: Date;
  allDay?: boolean;
}

/**
 * The result of naming an event in words rather than by id.
 *
 * Ambiguity is a distinct outcome, never a silent "first match wins": picking
 * the wrong appointment to delete is not recoverable from the user's side.
 */
export type EventLookup =
  | { kind: "found"; view: CalendarEventView }
  | { kind: "none" }
  | { kind: "ambiguous"; candidates: CalendarEventView[] };

export interface CalendarEventsResult {
  events: CalendarEventView[];
  /** Recurring masters a server returned because it would not expand them. */
  unresolvedRecurring: CalendarEventView[];
  /** Per-calendar failures, so a partial answer is never silently partial. */
  warnings: string[];
}

/**
 * Read-only CalDAV access, one client per account.
 *
 * Unlike the IMAP service there is no long-lived worker: calendars are queried
 * on demand, because a time-range REPORT is cheap and always current. The only
 * persistent state is the discovered collection list, refreshed at boot and
 * whenever an account is edited.
 */
export class CalDavService {
  private readonly statuses = new Map<string, CalDavAccountStatus>();
  private started = false;

  constructor(private readonly deps: CalDavServiceDependencies) {}

  async start(): Promise<void> {
    this.started = true;
    const accounts = await this.deps.calendars.listAccounts(true);
    // Discovery must never hold up startup: an unreachable calendar server is
    // not a reason to stop answering messages.
    await Promise.allSettled(accounts.map((account) => this.refresh(account)));
    this.deps.logger.info({ accountCount: accounts.length }, "CalDAV account manager started");
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  /** Called after every UI create, edit, enable, disable, or delete. */
  async reconcileAccount(accountId: string): Promise<CalDavAccountStatus> {
    const account = await this.deps.calendars.getAccount(accountId);
    if (!account || !account.enabled) {
      const status: CalDavAccountStatus = { accountId, state: "stopped" };
      this.statuses.set(accountId, status);
      return status;
    }
    return this.refresh(account);
  }

  removeAccount(accountId: string): void {
    this.statuses.delete(accountId);
  }

  statusFor(accountId: string): CalDavAccountStatus {
    return this.statuses.get(accountId) ?? { accountId, state: "stopped" };
  }

  /** The zone the user's day is rendered in: their first account's, or the deployment default. */
  async timezoneFor(userId: string): Promise<string> {
    const accounts = await this.deps.calendars.listAccountsForUser(userId, true);
    return accounts[0]?.timezone ?? this.deps.defaultTimezone;
  }

  async listCalendars(userId: string): Promise<Array<{ account: CalDavAccountRow; calendars: CalDavCalendarRow[] }>> {
    const accounts = await this.deps.calendars.listAccountsForUser(userId, true);
    const result = [];
    for (const account of accounts) {
      let calendars = await this.deps.calendars.listCalendars(account.id);
      // A boot-time discovery failure heals on first use rather than needing a
      // restart or a trip to the admin UI.
      if (calendars.length === 0 && this.statusFor(account.id).state !== "ready") {
        await this.refresh(account).catch(() => undefined);
        calendars = await this.deps.calendars.listCalendars(account.id);
      }
      result.push({ account, calendars });
    }
    return result;
  }

  /**
   * Every event overlapping [from, to) across the user's enabled calendars.
   *
   * @param calendarFilter Case-insensitive substring of a calendar name.
   */
  async listEvents(
    userId: string,
    from: Date,
    to: Date,
    calendarFilter?: string,
  ): Promise<CalendarEventsResult> {
    const accounts = await this.listCalendars(userId);
    const events: CalendarEventView[] = [];
    const unresolvedRecurring: CalendarEventView[] = [];
    const warnings: string[] = [];
    const needle = calendarFilter?.trim().toLowerCase();

    const jobs: Array<Promise<void>> = [];
    for (const { account, calendars } of accounts) {
      const client = this.clientFor(account);
      for (const calendar of calendars) {
        if (!calendar.enabled || !calendar.supportsEvents) continue;
        if (needle && !calendar.displayName.toLowerCase().includes(needle)) continue;
        jobs.push(
          (async () => {
            try {
              const result = await client.fetchEvents(calendar.url, from, to, account.timezone);
              if (!result.expandedByServer) {
                warnings.push(
                  `„${calendar.displayName}“: Der Server hat wiederkehrende Termine nicht aufgelöst.`,
                );
              }
              for (const resource of result.resources) {
                for (const event of resource.events) {
                  const view: CalendarEventView = {
                    accountName: account.name,
                    calendarName: calendar.displayName,
                    timezone: account.timezone,
                    event,
                    source: {
                      accountId: account.id,
                      calendarUrl: calendar.url,
                      readOnly: calendar.readOnly,
                      href: resource.href,
                      etag: resource.etag,
                      siblingCount: resource.events.length,
                    },
                  };
                  if (event.recurring && !result.expandedByServer) unresolvedRecurring.push(view);
                  else if (overlaps(event, from, to)) events.push(view);
                }
              }
            } catch (err) {
              const reason = err instanceof CalDavError ? err.message : String(err);
              warnings.push(`„${calendar.displayName}“ konnte nicht gelesen werden: ${reason}`);
              this.deps.logger.warn(
                { account: account.name, calendar: calendar.displayName, err: reason },
                "CalDAV calendar query failed",
              );
            }
          })(),
        );
      }
    }
    await Promise.all(jobs);

    events.sort((a, b) => a.event.start.getTime() - b.event.start.getTime());
    unresolvedRecurring.sort((a, b) => a.event.summary.localeCompare(b.event.summary, "de"));
    return { events, unresolvedRecurring, warnings };
  }

  /**
   * Finds the one event the user described, without an id ever changing hands.
   *
   * The selector is what a person would say: a day, a few words of the title,
   * and optionally a time when the same title appears twice.
   */
  async resolveEvent(
    userId: string,
    from: Date,
    to: Date,
    selector: { title: string; startsAt?: Date; calendar?: string },
  ): Promise<EventLookup> {
    const { events, unresolvedRecurring } = await this.listEvents(userId, from, to, selector.calendar);
    // Series masters are searched too. They can never be written to, but
    // "that is a recurring appointment" is a far better answer than "there is
    // no such appointment" for something the user can plainly see in the day.
    const searchable = [...events, ...unresolvedRecurring];
    const needle = selector.title.trim().toLowerCase();
    let matches = needle
      ? searchable.filter((view) => view.event.summary.toLowerCase().includes(needle))
      : searchable;

    if (selector.startsAt) {
      const wanted = selector.startsAt.getTime();
      const exact = matches.filter((view) => view.event.start.getTime() === wanted);
      // Only narrow when the time actually resolves something; a caller who
      // guessed the minute wrong should get the ambiguity list, not "none".
      if (exact.length > 0) matches = exact;
    }

    if (matches.length === 0) return { kind: "none" };
    if (matches.length > 1) return { kind: "ambiguous", candidates: matches };
    return { kind: "found", view: matches[0]! };
  }

  /** The calendar a new event goes into: the named one, or the only writable one. */
  async writableCalendars(
    userId: string,
    filter?: string,
  ): Promise<Array<{ account: CalDavAccountRow; calendar: CalDavCalendarRow }>> {
    const accounts = await this.listCalendars(userId);
    const needle = filter?.trim().toLowerCase();
    const writable = [];
    for (const { account, calendars } of accounts) {
      for (const calendar of calendars) {
        if (!calendar.enabled || !calendar.supportsEvents || calendar.readOnly) continue;
        if (needle && !calendar.displayName.toLowerCase().includes(needle)) continue;
        writable.push({ account, calendar });
      }
    }
    return writable;
  }

  async createEvent(
    account: CalDavAccountRow,
    calendar: CalDavCalendarRow,
    draft: Omit<EventDraft, "uid">,
  ): Promise<void> {
    const uid = newEventUid();
    const ics = buildCalendarObject({ ...draft, uid });
    await this.clientFor(account).createEvent(calendar.url, uid, ics);
    this.deps.logger.info(
      { account: account.name, calendar: calendar.displayName, summary: draft.summary },
      "calendar event created",
    );
  }

  async updateEvent(view: CalendarEventView, changes: EventChanges): Promise<void> {
    const account = await this.requireAccount(view.source.accountId);
    const current = view.event;
    const allDay = changes.allDay ?? current.allDay;
    const ics = buildCalendarObject({
      uid: current.uid,
      summary: changes.summary ?? current.summary,
      location: changes.location !== undefined ? changes.location : current.location,
      description: changes.description !== undefined ? changes.description : current.description,
      start: changes.start ?? current.start,
      end: changes.end ?? current.end,
      allDay,
      sequence: current.sequence + 1,
    });
    await this.clientFor(account).updateEvent(view.source.href, view.source.etag, ics);
    this.deps.logger.info(
      { account: account.name, calendar: view.calendarName, summary: current.summary },
      "calendar event updated",
    );
  }

  async deleteEvent(view: CalendarEventView): Promise<void> {
    const account = await this.requireAccount(view.source.accountId);
    await this.clientFor(account).deleteEvent(view.source.href, view.source.etag);
    this.deps.logger.info(
      { account: account.name, calendar: view.calendarName, summary: view.event.summary },
      "calendar event deleted",
    );
  }

  private async requireAccount(accountId: string): Promise<CalDavAccountRow> {
    const account = await this.deps.calendars.getAccount(accountId);
    if (!account) throw new CalDavError("The calendar account no longer exists.");
    return account;
  }

  private clientFor(account: CalDavAccountRow): CalDavClient {
    return new CalDavClient({
      baseUrl: account.baseUrl,
      username: account.username,
      password: decryptSecret(account.passwordEnc, this.deps.masterKey),
      ...(this.deps.timeoutMs !== undefined ? { timeoutMs: this.deps.timeoutMs } : {}),
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
      logger: this.deps.logger,
    });
  }

  private async refresh(account: CalDavAccountRow): Promise<CalDavAccountStatus> {
    if (!this.started) {
      const stopped: CalDavAccountStatus = { accountId: account.id, state: "stopped" };
      this.statuses.set(account.id, stopped);
      return stopped;
    }
    this.statuses.set(account.id, { accountId: account.id, state: "discovering" });
    try {
      const discovered = await this.clientFor(account).discoverCalendars();
      await this.deps.calendars.replaceCalendars(account.id, discovered);
      const status: CalDavAccountStatus = {
        accountId: account.id,
        state: "ready",
        calendarCount: discovered.length,
        lastCheckedAt: new Date(),
      };
      this.statuses.set(account.id, status);
      this.deps.logger.info(
        { account: account.name, calendarCount: discovered.length },
        "CalDAV calendars discovered",
      );
      return status;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const status: CalDavAccountStatus = {
        accountId: account.id,
        state: "error",
        error,
        lastCheckedAt: new Date(),
      };
      this.statuses.set(account.id, status);
      this.deps.logger.error({ account: account.name, err: error }, "CalDAV discovery failed");
      return status;
    }
  }
}

function overlaps(event: CalendarEvent, from: Date, to: Date): boolean {
  // Half-open on both sides: an event ending exactly at `from` is over, and one
  // starting exactly at `to` is outside the window.
  return event.end.getTime() > from.getTime() && event.start.getTime() < to.getTime();
}
