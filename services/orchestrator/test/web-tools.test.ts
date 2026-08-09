import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPublicHost,
  buildEmbeddedWebTools,
  decodeEntities,
  extractTitle,
  htmlToText,
  isPrivateAddress,
  parseDuckDuckGoLiteResults,
  parseDuckDuckGoResults,
  parseWebUrl,
} from "../src/agent/tools/web.js";

const silentLogger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => silentLogger,
} as never;

const ctx = { conversationId: "c", userId: "u" };

/** A fetch that answers every request with one canned HTML body. */
function stubFetch(body: string, status = 200): typeof fetch {
  return (async () =>
    new Response(body, {
      status,
      headers: { "content-type": "text/html; charset=utf-8" },
    })) as unknown as typeof fetch;
}

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

test("the lite endpoint's table markup is parsed, single quotes and all", () => {
  // Shape taken from a live lite.duckduckgo.com response.
  const html = `
    <table>
      <tr><td valign="top">1.&nbsp;</td>
        <td><a rel="nofollow" href="https://en.wikipedia.org/wiki/Steve_Jobs" class='result-link'>Steve Jobs - Wikipedia</a></td></tr>
      <tr><td>&nbsp;&nbsp;&nbsp;</td>
        <td class='result-snippet'>Steven Paul <b>Jobs</b> (1955 - 2011) was an American businessman.</td></tr>
      <tr><td>&nbsp;&nbsp;&nbsp;</td><td><span class='link-text'>en.wikipedia.org/wiki/Steve_Jobs</span></td></tr>
    </table>`;

  const hits = parseDuckDuckGoLiteResults(html);
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0], {
    title: "Steve Jobs - Wikipedia",
    url: "https://en.wikipedia.org/wiki/Steve_Jobs",
    snippet: "Steven Paul Jobs (1955 - 2011) was an American businessman.",
  });
});

test("a snippet nested inside a wrapper element is still found", () => {
  // Regression: pairing <tag>…</tag> with one non-greedy pattern let the outer
  // <div class="result"> swallow the snippet anchor inside it.
  const hits = parseDuckDuckGoResults(
    `<div class="result results_links_deep"><div class="links_main">` +
      `<h2><a class="result__a" href="https://example.com/x">Titel</a></h2>` +
      `<a class="result__snippet" href="#">Der Auszug.</a>` +
      `</div></div>`,
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.snippet, "Der Auszug.");
});

test("a page without result markup is an error, not an empty result set", async () => {
  // What a blocked server gets: HTTP 200, plausible HTML, no results in it.
  const [search] = buildEmbeddedWebTools({
    provider: "duckduckgo",
    logger: silentLogger,
    fetchImpl: stubFetch("<html><head><title>DuckDuckGo</title></head><body><p>…</p></body></html>"),
  });

  const result = await search!.execute({ query: "Steve Jobs" }, ctx);
  assert.equal(result.isError, true);
  // Both endpoints are tried before giving up, and the operator is told what to change.
  assert.match(result.content, /lite\.duckduckgo\.com/);
  assert.match(result.content, /html\.duckduckgo\.com/);
  assert.match(result.content, /WEB_SEARCH_PROVIDER=brave/);
  assert.doesNotMatch(result.content, /No results/i);
});

test("results from the first endpoint that answers are used", async () => {
  const [search] = buildEmbeddedWebTools({
    provider: "duckduckgo",
    logger: silentLogger,
    fetchImpl: stubFetch(
      `<td><a href="https://example.com/a" class='result-link'>Treffer</a></td>` +
        `<td class='result-snippet'>Auszug.</td>`,
    ),
  });

  const result = await search!.execute({ query: "test", limit: 3 }, ctx);
  assert.notEqual(result.isError, true);
  assert.match(result.content, /https:\/\/example\.com\/a/);
  assert.match(result.content, /Auszug\./);
});

test("Tavily results are mapped, and its error body reaches the operator", async () => {
  const ok = buildEmbeddedWebTools({
    provider: "tavily",
    tavilyApiKey: "tvly-test",
    logger: silentLogger,
    fetchImpl: (async (_url: unknown, init: { body?: string } = {}) => {
      // The key travels as a bearer token and the limit as max_results.
      assert.deepEqual(JSON.parse(init.body ?? "{}"), { query: "Steve Jobs", max_results: 2 });
      return Response.json({
        results: [
          { title: "Steve Jobs - Wikipedia", url: "https://en.wikipedia.org/wiki/Steve_Jobs", content: "Mitgründer von Apple." },
        ],
      });
    }) as unknown as typeof fetch,
  })[0];

  const result = await ok!.execute({ query: "Steve Jobs", limit: 2 }, ctx);
  assert.notEqual(result.isError, true);
  assert.match(result.content, /en\.wikipedia\.org\/wiki\/Steve_Jobs/);
  assert.match(result.content, /Mitgründer von Apple\./);

  const broke = buildEmbeddedWebTools({
    provider: "tavily",
    tavilyApiKey: "tvly-wrong",
    logger: silentLogger,
    fetchImpl: (async () =>
      Response.json({ detail: "Unauthorized: invalid API key" }, { status: 401 })) as unknown as typeof fetch,
  })[0];

  const failed = await broke!.execute({ query: "x" }, ctx);
  assert.equal(failed.isError, true);
  // The status alone cannot tell a typo from an exhausted quota.
  assert.match(failed.content, /401/);
  assert.match(failed.content, /invalid API key/);
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
