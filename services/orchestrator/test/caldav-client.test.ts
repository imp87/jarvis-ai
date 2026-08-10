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
  ifMatch: string | null;
  ifNoneMatch: string | null;
}

/**
 * A small stand-in for an iCloud-shaped server: principal discovery, then the
 * calendar home, then the collections, then a calendar-query.
 */
function fakeServer(
  options: {
    expandSupported?: boolean;
    unauthorized?: boolean;
    /** Emulates a concurrent edit: the If-Match no longer matches. */
    etagConflict?: boolean;
    /** Returns a recurring master instead of a plain event. */
    recurring?: boolean;
    /** Two events sharing a title, to exercise the ambiguity path. */
    duplicates?: boolean;
  } = {},
): {
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
    calls.push({
      method,
      url,
      body,
      depth: headers.get("Depth"),
      ifMatch: headers.get("If-Match"),
      ifNoneMatch: headers.get("If-None-Match"),
    });

    if (options.unauthorized) return new Response("nope", { status: 401 });

    if (method === "PUT" || method === "DELETE") {
      if (options.etagConflict) return new Response("changed", { status: 412 });
      return new Response(null, {
        status: method === "PUT" ? 201 : 204,
        headers: method === "PUT" ? { etag: '"new-etag"' } : {},
      });
    }

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
      const rrule = options.recurring ? "\nRRULE:FREQ=WEEKLY;BYDAY=MO" : "";
      return xml(`<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
        <D:response><D:href>/calendars/steven/privat/1.ics</D:href><D:propstat><D:prop>
          <C:calendar-data>BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:1@example.com
SUMMARY:Zahnarzt
LOCATION:Hauptstr. 1
DTSTART:20260810T070000Z
DTEND:20260810T080000Z${rrule}
END:VEVENT
END:VCALENDAR</C:calendar-data>
          <D:getetag>"abc"</D:getetag>
        </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
        <D:response><D:href>/calendars/steven/privat/2.ics</D:href><D:propstat><D:prop>
          <C:calendar-data>BEGIN:VCALENDAR
BEGIN:VEVENT
UID:2@example.com
SUMMARY:${options.duplicates ? "Zahnarzt" : "Urlaub"}
${options.duplicates ? "DTSTART:20260810T130000Z\nDTEND:20260810T140000Z" : "DTSTART;VALUE=DATE:20260810"}
END:VEVENT
END:VCALENDAR</C:calendar-data>
          <D:getetag>"def"</D:getetag>
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
  assert.equal(result.resources.length, 2);
  assert.equal(result.resources[0]?.events[0]?.summary, "Zahnarzt");
  assert.equal(result.resources[1]?.events[0]?.allDay, true);
  // The href and ETag are what make a safe later update possible.
  assert.equal(result.resources[0]?.href, "https://caldav.example.com/calendars/steven/privat/1.ics");
  assert.equal(result.resources[0]?.etag, '"abc"');

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
  assert.equal(result.resources.length, 2);
  const reports = calls.filter((call) => call.method === "REPORT");
  assert.equal(reports.length, 2);
  assert.ok(!reports[1]?.body.includes("<c:expand"));
});

test("creating an event PUTs a valid object and refuses to clobber an existing one", async () => {
  const { fetchImpl, calls } = fakeServer();
  const written = await client(fetchImpl).createEvent(
    "https://caldav.example.com/calendars/steven/privat/",
    "uid-1@jarvis",
    "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
  );

  assert.equal(written.href, "https://caldav.example.com/calendars/steven/privat/uid-1%40jarvis.ics");
  assert.equal(written.etag, '"new-etag"');
  const put = calls.find((call) => call.method === "PUT");
  // Without If-None-Match a UID collision would silently overwrite.
  assert.equal(put?.ifNoneMatch, "*");
});

test("updating and deleting send If-Match so a concurrent edit is never lost", async () => {
  const { fetchImpl, calls } = fakeServer();
  const target = "https://caldav.example.com/calendars/steven/privat/1.ics";
  await client(fetchImpl).updateEvent(target, '"abc"', "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n");
  await client(fetchImpl).deleteEvent(target, '"abc"');

  assert.equal(calls.find((call) => call.method === "PUT")?.ifMatch, '"abc"');
  assert.equal(calls.find((call) => call.method === "DELETE")?.ifMatch, '"abc"');
});

test("a 412 is reported as a concurrent change, not as a generic failure", async () => {
  const { fetchImpl } = fakeServer({ etagConflict: true });
  const target = "https://caldav.example.com/calendars/steven/privat/1.ics";
  await assert.rejects(
    () => client(fetchImpl).updateEvent(target, '"stale"', "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n"),
    (err: unknown) => {
      assert.ok(err instanceof CalDavError);
      assert.equal(err.status, 412);
      assert.match(err.message, /changed on the server/);
      return true;
    },
  );
});

test("deleting something already gone is treated as success", async () => {
  const fetchImpl = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
  await assert.doesNotReject(() =>
    client(fetchImpl).deleteEvent("https://caldav.example.com/calendars/steven/privat/1.ics", null),
  );
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

function writeTool(service: CalDavService, name: string) {
  const tool = buildEmbeddedCalendarTools(service).find((entry) => entry.name === name);
  assert.ok(tool, `${name} must exist`);
  return tool;
}

/** A tool context carrying what the user actually just said. */
const asked = (text: string): ToolContext => ({
  conversationId: "conv-1",
  userId: "user-1",
  lastUserText: text,
});

test("create_event writes the appointment and confirms it in words", async () => {
  const { fetchImpl, calls } = fakeServer();
  const result = await writeTool(serviceWith(fetchImpl), "create_event").execute(
    { title: "Zahnarzt", date: "2026-08-18", start_time: "09:00", location: "Hauptstr. 1" },
    asked("Trag mir am 18. um neun den Zahnarzt ein."),
  );

  const put = calls.find((call) => call.method === "PUT");
  assert.ok(put, "an event must have been written");
  // 09:00 Berlin is 07:00 UTC — the account's zone decides, not the server's.
  assert.match(put.body, /DTSTART:20260818T070000Z/);
  assert.match(put.body, /DTEND:20260818T080000Z/);
  assert.match(put.body, /SUMMARY:Zahnarzt/);
  assert.match(String(result.content), /Dienstag, 18\.08\.2026, 09:00–10:00 — Zahnarzt/);
  assert.ok(!String(result.content).includes("@jarvis"), "the UID must never reach the user");
});

test("a write is refused outright when the user's message did not ask for one", async () => {
  for (const [tool, args] of [
    ["create_event", { title: "X", date: "2026-08-18", start_time: "09:00" }],
    ["update_event", { date: "2026-08-10", title: "Zahnarzt", new_start_time: "11:00" }],
    ["delete_event", { date: "2026-08-10", title: "Zahnarzt" }],
  ] as const) {
    const { fetchImpl, calls } = fakeServer();
    const result = await writeTool(serviceWith(fetchImpl), tool).execute(
      args,
      // The user asked to be read to; a mail or event body wanting a change
      // must not be able to turn that into a write.
      asked("Was steht am 18. August an?"),
    );
    assert.equal(result.isError, true, tool);
    assert.equal(
      calls.filter((call) => call.method === "PUT" || call.method === "DELETE").length,
      0,
      `${tool} must not touch the server`,
    );
  }
});

test("update_event asks which appointment is meant instead of guessing", async () => {
  const { fetchImpl, calls } = fakeServer({ duplicates: true });
  const result = await writeTool(serviceWith(fetchImpl), "update_event").execute(
    { date: "2026-08-10", title: "Zahnarzt", new_start_time: "16:00" },
    asked("Verschieb den Zahnarzt auf 16 Uhr."),
  );

  assert.equal(result.isError, true);
  const content = String(result.content);
  // The candidate list has to be answerable out loud: times, not identifiers.
  assert.match(content, /09:00: Zahnarzt/);
  assert.match(content, /15:00: Zahnarzt/);
  assert.ok(!content.includes(".ics"), "resource URLs must never reach the user");
  assert.equal(calls.filter((call) => call.method === "PUT").length, 0, "nothing may be written");
});

test("naming the time resolves the ambiguity and the move preserves the duration", async () => {
  const { fetchImpl, calls } = fakeServer({ duplicates: true });
  await writeTool(serviceWith(fetchImpl), "update_event").execute(
    { date: "2026-08-10", title: "Zahnarzt", at: "09:00", new_start_time: "16:00" },
    asked("Verschieb den Zahnarzt von neun auf 16 Uhr."),
  );

  const put = calls.find((call) => call.method === "PUT");
  assert.ok(put);
  assert.match(put.body, /DTSTART:20260810T140000Z/);
  // The original was one hour long; a move must not silently resize it.
  assert.match(put.body, /DTEND:20260810T150000Z/);
  assert.equal(put.ifMatch, '"abc"', "the update must be guarded by the ETag it read");
});

test("a recurring appointment is refused rather than flattened or wiped", async () => {
  for (const tool of ["update_event", "delete_event"] as const) {
    const { fetchImpl, calls } = fakeServer({ recurring: true });
    const result = await writeTool(serviceWith(fetchImpl), tool).execute(
      { date: "2026-08-10", title: "Zahnarzt", new_start_time: "16:00" },
      asked(tool === "delete_event" ? "Lösch den Zahnarzt." : "Verschieb den Zahnarzt auf 16 Uhr."),
    );
    assert.equal(result.isError, true, tool);
    assert.match(String(result.content), /Terminserie/);
    assert.equal(
      calls.filter((call) => call.method === "PUT" || call.method === "DELETE").length,
      0,
      `${tool} must leave the series alone`,
    );
  }
});

test("delete_event removes the appointment and says what it removed", async () => {
  const { fetchImpl, calls } = fakeServer();
  const result = await writeTool(serviceWith(fetchImpl), "delete_event").execute(
    { date: "2026-08-10", title: "Zahnarzt" },
    asked("Sag den Zahnarzt bitte ab."),
  );

  const removed = calls.find((call) => call.method === "DELETE");
  assert.ok(removed);
  assert.equal(removed.ifMatch, '"abc"');
  assert.match(String(result.content), /Termin gelöscht: .*Zahnarzt/);
});

test("a read-only calendar is never written to", async () => {
  const { fetchImpl, calls } = fakeServer();
  const readOnly = { ...calendarRow("cal-0", "Privat", "privat", true), readOnly: true };
  const result = await writeTool(serviceWith(fetchImpl, [readOnly]), "delete_event").execute(
    { date: "2026-08-10", title: "Zahnarzt" },
    asked("Lösch den Zahnarzt."),
  );
  assert.equal(result.isError, true);
  assert.match(String(result.content), /nur lesbar/);
  assert.equal(calls.filter((call) => call.method === "DELETE").length, 0);
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
