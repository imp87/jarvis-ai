import assert from "node:assert/strict";
import test from "node:test";
import type { CalDavAccountRow, CalDavCalendarRow, CalendarRepository, DiscoveredCalendar } from "@jarvis/db";
import type { Logger, ToolContext } from "@jarvis/shared";
import { CalDavClient, CalDavError } from "../src/services/caldav/client.js";
import { CalDavService } from "../src/services/caldav.js";
import { buildEmbeddedCalendarTools } from "../src/agent/tools/calendar.js";

const SILENT: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  trace: () => undefined,
  child: () => SILENT,
} as unknown as Logger;

interface Recorded {
  method: string;
  url: string;
  body: string;
  depth: string | null;
}

/**
 * A small stand-in for an iCloud-shaped server: principal discovery, then the
 * calendar home, then the collections, then a calendar-query.
 */
function fakeServer(options: { expandSupported?: boolean; unauthorized?: boolean } = {}): {
  fetchImpl: typeof fetch;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const xml = (body: string): Response =>
    new Response(body, { status: 207, headers: { "content-type": "application/xml" } });

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = String(init?.body ?? "");
    const headers = new Headers(init?.headers as HeadersInit);
    calls.push({ method, url, body, depth: headers.get("Depth") });

    if (options.unauthorized) return new Response("nope", { status: 401 });

    if (method === "PROPFIND" && url.endsWith("/") && url.includes("caldav.example.com/")) {
      const path = new URL(url).pathname;
      if (path === "/") {
        return xml(`<D:multistatus xmlns:D="DAV:">
          <D:response><D:href>/</D:href><D:propstat>
            <D:prop><D:current-user-principal><D:href>/principals/steven/</D:href></D:current-user-principal></D:prop>
            <D:status>HTTP/1.1 200 OK</D:status>
          </D:propstat></D:response></D:multistatus>`);
      }
      if (path === "/principals/steven/") {
        return xml(`<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
          <D:response><D:href>/principals/steven/</D:href><D:propstat>
            <D:prop><C:calendar-home-set><D:href>/calendars/steven/</D:href></C:calendar-home-set></D:prop>
            <D:status>HTTP/1.1 200 OK</D:status>
          </D:propstat></D:response></D:multistatus>`);
      }
      if (path === "/calendars/steven/") {
        return xml(`<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/">
          <D:response>
            <D:href>/calendars/steven/</D:href>
            <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
          </D:response>
          <D:response>
            <D:href>/calendars/steven/privat/</D:href>
            <D:propstat><D:prop>
              <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
              <D:displayname>Privat</D:displayname>
              <CS:getctag>ctag-1</CS:getctag>
              <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>
            </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
          </D:response>
          <D:response>
            <D:href>/calendars/steven/aufgaben/</D:href>
            <D:propstat><D:prop>
              <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
              <D:displayname>Aufgaben</D:displayname>
              <C:supported-calendar-component-set><C:comp name="VTODO"/></C:supported-calendar-component-set>
            </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
          </D:response>
        </D:multistatus>`);
      }
      return new Response("not found", { status: 404 });
    }

    if (method === "REPORT") {
      if (body.includes("<c:expand") && options.expandSupported === false) {
        return new Response("expand not supported", { status: 403 });
      }
      return xml(`<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
        <D:response><D:href>/calendars/steven/privat/1.ics</D:href><D:propstat><D:prop>
          <C:calendar-data>BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:1@example.com
SUMMARY:Zahnarzt
LOCATION:Hauptstr. 1
DTSTART:20260810T070000Z
DTEND:20260810T080000Z
END:VEVENT
END:VCALENDAR</C:calendar-data>
          <D:getetag>"abc"</D:getetag>
        </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
        <D:response><D:href>/calendars/steven/privat/2.ics</D:href><D:propstat><D:prop>
          <C:calendar-data>BEGIN:VCALENDAR
BEGIN:VEVENT
UID:2@example.com
SUMMARY:Urlaub
DTSTART;VALUE=DATE:20260810
END:VEVENT
END:VCALENDAR</C:calendar-data>
        </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
      </D:multistatus>`);
    }

    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

function client(fetchImpl: typeof fetch): CalDavClient {
  return new CalDavClient({
    baseUrl: "https://caldav.example.com",
    username: "steven",
    password: "app-specific",
    fetchImpl,
    logger: SILENT,
  });
}

test("discovery walks principal to calendar home and classifies each collection", async () => {
  const { fetchImpl, calls } = fakeServer();
  const calendars = await client(fetchImpl).discoverCalendars();

  // A VTODO-only collection is recorded rather than dropped: the flag is what
  // keeps it out of event queries, and it is what a later task sync will need.
  assert.deepEqual(
    calendars.map((calendar) => [calendar.displayName, calendar.supportsEvents]),
    [["Privat", true], ["Aufgaben", false]],
  );
  const privat = calendars[0];
  assert.equal(privat?.url, "https://caldav.example.com/calendars/steven/privat/");
  assert.equal(privat?.ctag, "ctag-1");

  // The calendar home itself is a plain collection and must not be listed.
  assert.ok(!calendars.some((calendar) => calendar.url.endsWith("/calendars/steven/")));

  // The collection listing must be the only Depth: 1 request.
  assert.deepEqual(
    calls.filter((call) => call.depth === "1").map((call) => new URL(call.url).pathname),
    ["/calendars/steven/"],
  );
});

test("a calendar that cannot hold events is never queried for them", async () => {
  const { fetchImpl, calls } = fakeServer();
  const service = serviceWith(fetchImpl, [
    calendarRow("cal-0", "Privat", "privat", true),
    calendarRow("cal-1", "Aufgaben", "aufgaben", false),
  ]);
  await service.listEvents("user-1", new Date("2026-08-10T00:00:00Z"), new Date("2026-08-11T00:00:00Z"));

  const queried = calls.filter((call) => call.method === "REPORT").map((call) => new URL(call.url).pathname);
  assert.deepEqual(queried, ["/calendars/steven/privat/"]);
});

test("credentials are sent as Basic auth and a 401 is reported in plain language", async () => {
  const { fetchImpl, calls } = fakeServer({ unauthorized: true });
  await assert.rejects(
    () => client(fetchImpl).discoverCalendars(),
    (err: unknown) => {
      assert.ok(err instanceof CalDavError);
      assert.equal(err.status, 401);
      assert.match(err.message, /app-specific password/);
      return true;
    },
  );
  // A rejected password must stop discovery, not fan out over every candidate.
  assert.equal(calls.length, 1);
});

test("a time-range query is expanded by the server and parsed into instances", async () => {
  const { fetchImpl, calls } = fakeServer();
  const result = await client(fetchImpl).fetchEvents(
    "https://caldav.example.com/calendars/steven/privat/",
    new Date("2026-08-10T00:00:00Z"),
    new Date("2026-08-11T00:00:00Z"),
    "Europe/Berlin",
  );

  assert.equal(result.expandedByServer, true);
  assert.equal(result.events.length, 2);
  assert.equal(result.events[0]?.summary, "Zahnarzt");
  assert.equal(result.events[1]?.allDay, true);

  const report = calls.find((call) => call.method === "REPORT");
  assert.match(report?.body ?? "", /<c:time-range start="20260810T000000Z" end="20260811T000000Z"\/>/);
  assert.match(report?.body ?? "", /<c:expand /);
});

test("a server that refuses <expand> is retried plain and the result flagged", async () => {
  const { fetchImpl, calls } = fakeServer({ expandSupported: false });
  const result = await client(fetchImpl).fetchEvents(
    "https://caldav.example.com/calendars/steven/privat/",
    new Date("2026-08-10T00:00:00Z"),
    new Date("2026-08-11T00:00:00Z"),
    "Europe/Berlin",
  );

  assert.equal(result.expandedByServer, false);
  assert.equal(result.events.length, 2);
  const reports = calls.filter((call) => call.method === "REPORT");
  assert.equal(reports.length, 2);
  assert.ok(!reports[1]?.body.includes("<c:expand"));
});

/** In-memory stand-in for the repository, so the tools can run without a database. */
function stubRepository(account: CalDavAccountRow, calendars: CalDavCalendarRow[]): CalendarRepository {
  let stored = calendars;
  return {
    listAccounts: async () => [account],
    listAccountsForUser: async () => [account],
    getAccount: async () => account,
    listCalendars: async () => stored,
    replaceCalendars: async (_id: string, discovered: DiscoveredCalendar[]) => {
      stored = discovered.map((calendar, index) => ({
        ...calendar,
        id: `cal-${index}`,
        accountId: account.id,
        enabled: true,
      }));
    },
  } as unknown as CalendarRepository;
}

function calendarRow(id: string, displayName: string, slug: string, supportsEvents: boolean): CalDavCalendarRow {
  return {
    id,
    accountId: "acc-1",
    url: `https://caldav.example.com/calendars/steven/${slug}/`,
    displayName,
    ctag: "ctag-1",
    color: null,
    readOnly: false,
    supportsEvents,
    enabled: true,
  };
}

function serviceWith(fetchImpl: typeof fetch, calendars?: CalDavCalendarRow[]): CalDavService {
  const account: CalDavAccountRow = {
    id: "acc-1",
    userId: "user-1",
    name: "iCloud",
    baseUrl: "https://caldav.example.com",
    username: "steven",
    // decryptSecret is stubbed out by passing a service that never calls it —
    // see the masterKey note below.
    passwordEnc: "",
    timezone: "Europe/Berlin",
    enabled: true,
  };
  const service = new CalDavService({
    calendars: stubRepository(account, calendars ?? [calendarRow("cal-0", "Privat", "privat", true)]),
    masterKey: Buffer.alloc(32),
    logger: SILENT,
    defaultTimezone: "Europe/Berlin",
    fetchImpl,
  });
  // The stored envelope is empty in this fixture, so short-circuit decryption
  // rather than encrypting a fixture password with a throwaway key.
  Reflect.set(service, "clientFor", () =>
    new CalDavClient({
      baseUrl: account.baseUrl,
      username: account.username,
      password: "app-specific",
      fetchImpl,
      logger: SILENT,
    }),
  );
  return service;
}

const ctx: ToolContext = { conversationId: "conv-1", userId: "user-1" };

test("list_events renders a German day summary and never leaks an event id", async () => {
  const { fetchImpl } = fakeServer();
  const tools = buildEmbeddedCalendarTools(serviceWith(fetchImpl));
  const listEvents = tools.find((tool) => tool.name === "list_events");
  assert.ok(listEvents);

  const result = await listEvents.execute({ from: "2026-08-10", days: 1 }, ctx);
  const content = String(result.content);

  assert.match(content, /Montag, 10\.08\.2026/);
  // 07:00Z is 09:00 in Berlin — the account's zone, not UTC.
  assert.match(content, /09:00–10:00: Zahnarzt, Hauptstr\. 1/);
  assert.match(content, /ganztägig: Urlaub/);
  assert.ok(!content.includes("@example.com"), "event UIDs must never reach the user");
  assert.ok(!content.includes("caldav.example.com"), "internal URLs must never reach the user");
});

test("list_events reports an empty day plainly", async () => {
  const { fetchImpl } = fakeServer();
  const tools = buildEmbeddedCalendarTools(serviceWith(fetchImpl));
  const listEvents = tools.find((tool) => tool.name === "list_events");
  const result = await listEvents?.execute({ from: "2026-09-01", days: 1 }, ctx);
  assert.match(String(result?.content), /keine Termine/);
});

test("list_events rejects a malformed date instead of silently using today", async () => {
  const { fetchImpl } = fakeServer();
  const tools = buildEmbeddedCalendarTools(serviceWith(fetchImpl));
  const listEvents = tools.find((tool) => tool.name === "list_events");
  const result = await listEvents?.execute({ from: "morgen" }, ctx);
  assert.equal(result?.isError, true);
});

test("list_calendars names calendars without exposing URLs", async () => {
  const { fetchImpl } = fakeServer();
  const tools = buildEmbeddedCalendarTools(serviceWith(fetchImpl));
  const listCalendars = tools.find((tool) => tool.name === "list_calendars");
  const result = await listCalendars?.execute({}, ctx);
  const content = String(result?.content);
  assert.match(content, /iCloud/);
  assert.match(content, /Privat/);
  assert.ok(!content.includes("https://"));
});
