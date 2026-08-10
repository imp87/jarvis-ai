import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeXmlText,
  findElements,
  hasElement,
  isOkPropstat,
  okProps,
  textOf,
  textsOf,
} from "../src/services/caldav/xml.js";

test("elements are found regardless of the namespace prefix a server picks", () => {
  // The same document from three servers: iCloud, Nextcloud, and one that
  // binds DAV: as the default namespace with no prefix at all.
  for (const body of [
    `<D:multistatus xmlns:D="DAV:"><D:response><D:href>/cal/</D:href></D:response></D:multistatus>`,
    `<d:multistatus xmlns:d="DAV:"><d:response><d:href>/cal/</d:href></d:response></d:multistatus>`,
    `<multistatus xmlns="DAV:"><response><href>/cal/</href></response></multistatus>`,
  ]) {
    assert.equal(findElements(body, "response").length, 1);
    assert.equal(textOf(body, "href"), "/cal/");
  }
});

test("only outermost elements are returned, so a nested one cannot leak out", () => {
  const body = `<root><item>outer <item>inner</item></item><item>second</item></root>`;
  const items = findElements(body, "item");
  assert.equal(items.length, 2);
  assert.equal(items[0]?.inner, "outer <item>inner</item>");
  assert.equal(items[1]?.inner, "second");
});

test("self-closing and attribute-bearing elements are read correctly", () => {
  const body = `<set><comp name="VEVENT"/><comp name="VTODO"/></set>`;
  const comps = findElements(body, "comp");
  assert.equal(comps.length, 2);
  assert.equal(comps[0]?.attributes["name"], "VEVENT");
  assert.equal(comps[1]?.attributes["name"], "VTODO");
  assert.equal(comps[0]?.inner, "");
});

test("a > inside a quoted attribute does not end the tag early", () => {
  const body = `<a><b title="x > y"/><c>kept</c></a>`;
  assert.equal(findElements(body, "b")[0]?.attributes["title"], "x > y");
  assert.equal(textOf(body, "c"), "kept");
});

test("entities and CDATA are decoded in element text", () => {
  assert.equal(textOf(`<n>Caf&#233; &amp; Bar</n>`, "n"), "Café & Bar");
  assert.equal(textOf(`<n>&lt;tag&gt;</n>`, "n"), "<tag>");
  assert.equal(textOf(`<n><![CDATA[BEGIN:VCALENDAR]]></n>`, "n"), "BEGIN:VCALENDAR");
  assert.equal(decodeXmlText("&#x41;&unknown;"), "A&unknown;");
});

test("comments and processing instructions are skipped", () => {
  const body = `<?xml version="1.0"?><!-- <response>fake</response> --><root><response>real</response></root>`;
  const responses = findElements(body, "response");
  assert.equal(responses.length, 1);
  assert.equal(responses[0]?.inner, "real");
});

test("propstat status is read as success only for 2xx", () => {
  assert.equal(isOkPropstat(`<status>HTTP/1.1 200 OK</status>`), true);
  assert.equal(isOkPropstat(`<status>HTTP/1.1 207 Multi-Status</status>`), true);
  assert.equal(isOkPropstat(`<status>HTTP/1.1 404 Not Found</status>`), false);
  assert.equal(isOkPropstat(``), false);
});

test("okProps ignores the 404 half of a split response", () => {
  // Servers routinely answer one PROPFIND with a 200 propstat for the
  // properties that exist and a 404 propstat for the rest. Reading the wrong
  // half is how a calendar ends up with a blank display name.
  const response = `
    <propstat>
      <prop><displayname>Privat</displayname></prop>
      <status>HTTP/1.1 200 OK</status>
    </propstat>
    <propstat>
      <prop><calendar-color/></prop>
      <status>HTTP/1.1 404 Not Found</status>
    </propstat>`;
  const props = okProps(response);
  assert.equal(textOf(props, "displayname"), "Privat");
  assert.equal(hasElement(props, "calendar-color"), false);
});

test("textsOf collects every value and drops the empty ones", () => {
  const body = `<set><href>/a/</href><href>  </href><href>/b/</href></set>`;
  assert.deepEqual(textsOf(body, "href"), ["/a/", "/b/"]);
});

test("a malformed document yields what it can instead of throwing", () => {
  assert.doesNotThrow(() => findElements(`<a><b>unclosed`, "b"));
  assert.doesNotThrow(() => findElements(`</stray><a>ok</a>`, "a"));
  assert.equal(textOf(`</stray><a>ok</a>`, "a"), "ok");
});
