import type { Logger } from "@jarvis/shared";
import type { DiscoveredCalendar } from "@jarvis/db";
import { findElements, firstElement, hasElement, okProps, textOf } from "./xml.js";
import { parseVEvents, type CalendarEvent } from "./ical.js";

const DAV_NS = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ic="http://apple.com/ns/ical/"';

export interface CalDavClientOptions {
  baseUrl: string;
  username: string;
  password: string;
  timeoutMs?: number;
  /** Hard ceiling on one response body. A year of a busy calendar is large. */
  maxBytes?: number;
  /** Injection point for tests; production always uses global fetch. */
  fetchImpl?: typeof fetch;
  logger?: Logger;
}

export class CalDavError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "CalDavError";
  }
}

export interface EventQueryResult {
  events: CalendarEvent[];
  /**
   * False when the server refused `<expand>` and returned master events. The
   * caller must then treat recurring entries as unresolved rather than as
   * instances that genuinely fall in the window.
   */
  expandedByServer: boolean;
}

/**
 * A read-only CalDAV client: discovery and time-range queries, nothing else.
 *
 * Written against `fetch` rather than a DAV library for the same reason the
 * rest of this codebase parses its own payloads — the surface actually used is
 * three requests wide, and the credentials stay inside this process.
 */
export class CalDavClient {
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: CalDavClientOptions) {
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxBytes = options.maxBytes ?? 8_000_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Walks current-user-principal → calendar-home-set → collections.
   *
   * Every step is allowed to fail: an account may be configured with the
   * calendar home URL directly, in which case the discovery hops are skipped
   * and the base URL is listed straight away.
   */
  async discoverCalendars(): Promise<DiscoveredCalendar[]> {
    const roots = await this.candidateHomes();
    const errors: string[] = [];
    for (const home of roots) {
      try {
        const calendars = await this.listCollections(home);
        if (calendars.length > 0) return calendars;
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    if (errors.length > 0) throw new CalDavError(errors[0] ?? "CalDAV discovery failed");
    throw new CalDavError(
      "No calendar collections were found. Check the URL — for iCloud use https://caldav.icloud.com",
    );
  }

  /** Candidate calendar-home URLs, best guess first. */
  private async candidateHomes(): Promise<string[]> {
    const base = normaliseUrl(this.options.baseUrl);
    const homes: string[] = [];

    for (const start of [base, wellKnown(base)]) {
      let principalBody: string;
      try {
        principalBody = await this.propfind(start, 0, ["current-user-principal", "calendar-home-set"]);
      } catch (err) {
        // A 401 is terminal: no other URL will do better with these credentials.
        if (err instanceof CalDavError && err.status === 401) throw err;
        continue;
      }
      const direct = this.hrefsFrom(principalBody, "calendar-home-set", start);
      homes.push(...direct);
      if (direct.length > 0) break;

      const principals = this.hrefsFrom(principalBody, "current-user-principal", start);
      for (const principal of principals) {
        try {
          const homeBody = await this.propfind(principal, 0, ["calendar-home-set"]);
          homes.push(...this.hrefsFrom(homeBody, "calendar-home-set", principal));
        } catch {
          // Try the next principal; the base URL fallback below still applies.
        }
      }
      if (homes.length > 0) break;
    }

    // The account may already point at the home, or at a single calendar.
    homes.push(base);
    return [...new Set(homes)];
  }

  private hrefsFrom(body: string, propertyName: string, relativeTo: string): string[] {
    const hrefs: string[] = [];
    for (const response of findElements(body, "response")) {
      const props = okProps(response.inner);
      const property = firstElement(props, propertyName);
      if (!property) continue;
      for (const href of findElements(property.inner, "href")) {
        const value = textOf(`<x>${href.inner}</x>`, "x") ?? "";
        if (value.trim()) hrefs.push(resolve(value.trim(), relativeTo));
      }
    }
    return hrefs;
  }

  /** One PROPFIND at Depth: 1, filtered down to real event collections. */
  private async listCollections(homeUrl: string): Promise<DiscoveredCalendar[]> {
    const body = await this.propfind(homeUrl, 1, [
      "resourcetype",
      "displayname",
      "getctag",
      "calendar-color",
      "supported-calendar-component-set",
      "current-user-privilege-set",
    ]);

    const calendars: DiscoveredCalendar[] = [];
    for (const response of findElements(body, "response")) {
      const href = textOf(response.inner, "href");
      if (!href) continue;
      const props = okProps(response.inner);
      const resourceType = firstElement(props, "resourcetype");
      if (!resourceType || !hasElement(resourceType.inner, "calendar")) continue;

      const url = resolve(href, homeUrl);
      // The home itself can carry the calendar resourcetype on some servers.
      if (stripTrailingSlash(url) === stripTrailingSlash(homeUrl)) continue;

      calendars.push({
        url,
        displayName: textOf(props, "displayname") || lastPathSegment(url),
        ctag: textOf(props, "getctag") ?? null,
        color: textOf(props, "calendar-color") ?? null,
        readOnly: isReadOnly(props),
        supportsEvents: supportsEvents(props),
      });
    }
    return calendars;
  }

  /**
   * Events overlapping [start, end).
   *
   * `<expand>` asks the server to resolve recurrences into concrete instances
   * in UTC. Servers that do not implement it answer with an error or ignore the
   * element, so the query is retried plain and the result flagged.
   */
  async fetchEvents(
    calendarUrl: string,
    start: Date,
    end: Date,
    fallbackTimeZone: string,
  ): Promise<EventQueryResult> {
    const range = `start="${icalUtc(start)}" end="${icalUtc(end)}"`;
    const query = (expand: boolean): string =>
      `<?xml version="1.0" encoding="utf-8" ?>
<c:calendar-query ${DAV_NS}>
  <d:prop>
    <d:getetag/>
    <c:calendar-data>${expand ? `<c:expand ${range}/>` : ""}</c:calendar-data>
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range ${range}/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;

    let expandedByServer = true;
    let body: string;
    try {
      body = await this.report(calendarUrl, query(true));
    } catch (err) {
      if (err instanceof CalDavError && err.status === 401) throw err;
      this.options.logger?.debug(
        { calendar: calendarUrl, err: String(err) },
        "CalDAV server rejected <expand>; retrying without it",
      );
      expandedByServer = false;
      body = await this.report(calendarUrl, query(false));
    }

    const events: CalendarEvent[] = [];
    for (const response of findElements(body, "response")) {
      const data = textOf(okProps(response.inner), "calendar-data");
      if (!data) continue;
      events.push(...parseVEvents(data, fallbackTimeZone));
    }

    // A server that silently ignored <expand> is indistinguishable from one
    // that honoured it, except that masters keep their RRULE.
    if (expandedByServer && events.some((event) => event.recurring)) expandedByServer = false;

    return { events, expandedByServer };
  }

  private async propfind(url: string, depth: 0 | 1, properties: string[]): Promise<string> {
    const body = `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind ${DAV_NS}>
  <d:prop>
${properties.map((name) => `    <${prefixFor(name)}:${name}/>`).join("\n")}
  </d:prop>
</d:propfind>`;
    return this.request("PROPFIND", url, body, String(depth));
  }

  private async report(url: string, body: string): Promise<string> {
    return this.request("REPORT", url, body, "1");
  }

  private async request(method: string, url: string, body: string, depth: string): Promise<string> {
    const credentials = Buffer.from(`${this.options.username}:${this.options.password}`, "utf8").toString("base64");
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Basic ${credentials}`,
          "Content-Type": 'application/xml; charset="utf-8"',
          Depth: depth,
          // Some servers answer text/html to a request that accepts anything.
          Accept: "application/xml, text/xml",
          "User-Agent": "Jarvis/1.0 CalDAV",
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "follow",
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new CalDavError(`${method} ${url} failed: ${reason}`);
    }

    if (response.status === 401 || response.status === 403) {
      throw new CalDavError(
        `The server rejected the credentials (HTTP ${response.status}). ` +
          "iCloud needs an app-specific password, not the Apple ID password.",
        response.status,
      );
    }
    if (!response.ok && response.status !== 207) {
      throw new CalDavError(`${method} ${url} returned HTTP ${response.status}`, response.status);
    }
    return this.readCapped(response, url);
  }

  private async readCapped(response: Response, url: string): Promise<string> {
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > this.maxBytes) {
      throw new CalDavError(`${url} returned ${declared} bytes, over the ${this.maxBytes} byte limit`);
    }
    if (!response.body) return response.text();

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > this.maxBytes) {
          throw new CalDavError(`${url} exceeded the ${this.maxBytes} byte response limit`);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  }
}

/** Which namespace prefix a requested property lives in. */
function prefixFor(property: string): string {
  if (property === "getctag") return "cs";
  if (property === "calendar-color") return "ic";
  if (property.startsWith("calendar-") || property.startsWith("supported-calendar-")) return "c";
  return "d";
}

function supportsEvents(props: string): boolean {
  const set = firstElement(props, "supported-calendar-component-set");
  // Absent means "no restriction stated" — RFC 4791 lets a collection hold any
  // component, so treating silence as "events allowed" is the correct read.
  if (!set) return true;
  const comps = findElements(set.inner, "comp");
  if (comps.length === 0) return true;
  return comps.some((comp) => (comp.attributes["name"] ?? "").toUpperCase() === "VEVENT");
}

function isReadOnly(props: string): boolean {
  const privileges = firstElement(props, "current-user-privilege-set");
  if (!privileges) return false;
  return !hasElement(privileges.inner, "write") && !hasElement(privileges.inner, "write-content");
}

export function icalUtc(date: Date): string {
  return `${date.toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`;
}

function normaliseUrl(raw: string): string {
  const trimmed = raw.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return new URL(withScheme).toString();
}

function wellKnown(base: string): string {
  return new URL("/.well-known/caldav", base).toString();
}

function resolve(href: string, relativeTo: string): string {
  try {
    return new URL(href, relativeTo).toString();
  } catch {
    return href;
  }
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function lastPathSegment(url: string): string {
  const segments = stripTrailingSlash(new URL(url).pathname).split("/");
  return decodeURIComponent(segments[segments.length - 1] ?? "") || "Kalender";
}
