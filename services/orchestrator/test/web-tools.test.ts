import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPublicHost,
  decodeEntities,
  extractTitle,
  htmlToText,
  isPrivateAddress,
  parseDuckDuckGoResults,
  parseWebUrl,
} from "../src/agent/tools/web.js";

test("htmlToText drops scripts and keeps readable structure", () => {
  const text = htmlToText(
    `<html><head><title>Wetter</title><style>b{}</style></head><body>` +
      `<script>var a = 1 < 2;</script>` +
      `<h1>Berlin</h1><p>Heute 21&nbsp;&deg;C, morgen k&uuml;hler.</p>` +
      `<ul><li>Regen</li><li>Wind</li></ul></body></html>`,
  );
  assert.equal(text, "Berlin\nHeute 21 °C, morgen kühler.\n\n- Regen\n- Wind");
  assert.ok(!text.includes("var a"));
});

test("entities decode numerically and by name", () => {
  assert.equal(decodeEntities("R&amp;D &#8364;5 &#x2026; &Uuml;ber"), "R&D €5 … Über");
  // An unknown entity is left alone rather than silently swallowed.
  assert.equal(decodeEntities("&nichtsda; x"), "&nichtsda; x");
});

test("extractTitle reads the document title", () => {
  assert.equal(extractTitle("<html><head><title>  Wetter &amp; Klima </title>"), "Wetter & Klima");
  assert.equal(extractTitle("<html><body>kein Titel</body></html>"), undefined);
});

test("DuckDuckGo results are unwrapped, paired with snippets and stripped of ads", () => {
  const html = `
    <div class="result results_links_deep result--ad">
      <a class="result__a" href="//duckduckgo.com/y.js?ad_domain=shop.example">Anzeige</a>
      <a class="result__snippet" href="#">Werbung</a>
    </div>
    <div class="result results_links_deep">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwetter.example%2Fberlin&amp;rut=x">Wetter <b>Berlin</b></a>
      <a class="result__snippet" href="#">Heute 21&deg;C und trocken.</a>
    </div>
    <div class="result results_links_deep">
      <a rel="nofollow" class="result__a" href="https://direkt.example/seite">Direkter Treffer</a>
      <div class="result__snippet">Ohne Redirector.</div>
    </div>`;

  const hits = parseDuckDuckGoResults(html);
  assert.equal(hits.length, 2);
  assert.deepEqual(hits[0], {
    title: "Wetter Berlin",
    url: "https://wetter.example/berlin",
    snippet: "Heute 21°C und trocken.",
  });
  assert.equal(hits[1]?.url, "https://direkt.example/seite");
  assert.equal(hits[1]?.snippet, "Ohne Redirector.");
});

test("only absolute http(s) URLs are accepted", () => {
  assert.equal(parseWebUrl("https://example.com/a").hostname, "example.com");
  assert.throws(() => parseWebUrl("file:///etc/passwd"), /only http and https/);
  assert.throws(() => parseWebUrl("example.com"), /valid absolute URL/);
});

test("private and link-local addresses are recognised", () => {
  for (const address of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.9",
    "192.168.1.1",
    "169.254.169.254",
    "::1",
    "fd00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
  ]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700::1111"]) {
    assert.equal(isPrivateAddress(address), false, address);
  }
});

test("the host guard blocks the local network, including via DNS", async () => {
  const never = async (): Promise<string[]> => {
    throw new Error("should not resolve");
  };
  await assert.rejects(
    assertPublicHost(new URL("http://localhost:8080/x"), never),
    /local address/,
  );
  await assert.rejects(
    assertPublicHost(new URL("http://127.0.0.1:15432/"), never),
    /private network/,
  );
  // The hostname is public-looking; only the resolved address gives it away.
  await assert.rejects(
    assertPublicHost(new URL("http://intern.example.com/"), async () => ["10.0.0.5"]),
    /private network/,
  );
  await assert.doesNotReject(
    assertPublicHost(new URL("https://example.com/"), async () => ["93.184.216.34"]),
  );
});
