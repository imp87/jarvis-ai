/**
 * A very small, namespace-agnostic XML reader for WebDAV multistatus bodies.
 *
 * Hand-rolled for the same reason `web.ts` parses HTML itself: the shapes we
 * read are tiny and fixed, and a full XML stack would be a dependency for four
 * element names. The one thing it must get right is namespaces — servers are
 * free to bind `DAV:` to `d:`, `D:` or nothing at all, and iCloud, Nextcloud
 * and Radicale each pick differently — so every lookup is by local name.
 */

export interface XmlElement {
  /** Local name, lowercased, with any namespace prefix stripped. */
  name: string;
  attributes: Record<string, string>;
  /** Raw inner XML; empty for a self-closing element. */
  inner: string;
}

interface Tag {
  name: string;
  kind: "open" | "close" | "self";
  attributes: Record<string, string>;
  /** Index of the opening "<". */
  start: number;
  /** Index just past the closing ">". */
  end: number;
}

/**
 * Every outermost element with this local name. Nested elements of the same
 * name are returned as part of their parent's `inner`, not separately, so
 * `findElements(body, "response")` cannot accidentally return a fragment.
 */
export function findElements(xml: string, localName: string): XmlElement[] {
  const target = localName.toLowerCase();
  const found: XmlElement[] = [];
  let depth = 0;
  let innerStart = -1;
  let open: Tag | undefined;

  for (const tag of scanTags(xml)) {
    if (tag.name !== target) continue;
    if (tag.kind === "self") {
      if (depth === 0) found.push({ name: target, attributes: tag.attributes, inner: "" });
      continue;
    }
    if (tag.kind === "open") {
      if (depth === 0) {
        innerStart = tag.end;
        open = tag;
      }
      depth += 1;
      continue;
    }
    // A close tag with nothing open is malformed; ignore it rather than throw,
    // since one bad element should not lose the rest of a multistatus.
    if (depth === 0) continue;
    depth -= 1;
    if (depth === 0 && open) {
      found.push({ name: target, attributes: open.attributes, inner: xml.slice(innerStart, tag.start) });
      open = undefined;
    }
  }
  return found;
}

export function firstElement(xml: string, localName: string): XmlElement | undefined {
  return findElements(xml, localName)[0];
}

export function hasElement(xml: string, localName: string): boolean {
  return findElements(xml, localName).length > 0;
}

/** Decoded, trimmed text of the first matching element. */
export function textOf(xml: string, localName: string): string | undefined {
  const element = firstElement(xml, localName);
  if (!element) return undefined;
  return decodeXmlText(stripTags(element.inner)).trim();
}

/** Decoded text of every matching element, with empties dropped. */
export function textsOf(xml: string, localName: string): string[] {
  return findElements(xml, localName)
    .map((element) => decodeXmlText(stripTags(element.inner)).trim())
    .filter((value) => value.length > 0);
}

/**
 * True when a `<propstat>` reported success. A multistatus routinely carries a
 * 404 propstat next to a 200 one for the same resource — reading properties out
 * of the failed half is how "displayname: undefined" turns into a blank name.
 */
export function isOkPropstat(propstatInner: string): boolean {
  const status = textOf(propstatInner, "status") ?? "";
  return /\s2\d\d\s/.test(` ${status} `);
}

/** The `<prop>` bodies of every successful propstat inside one response. */
export function okProps(responseInner: string): string {
  return findElements(responseInner, "propstat")
    .filter((propstat) => isOkPropstat(propstat.inner))
    .map((propstat) => firstElement(propstat.inner, "prop")?.inner ?? "")
    .join("");
}

export function decodeXmlText(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? safeFromCodePoint(code) : match;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? safeFromCodePoint(code) : match;
    }
    switch (entity.toLowerCase()) {
      case "amp": return "&";
      case "lt": return "<";
      case "gt": return ">";
      case "quot": return '"';
      case "apos": return "'";
      case "nbsp": return " ";
      default: return match;
    }
  });
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function safeFromCodePoint(code: number): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/** Inner text with child elements removed and CDATA sections unwrapped. */
function stripTags(xml: string): string {
  let out = "";
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt === -1) {
      out += xml.slice(i);
      break;
    }
    out += xml.slice(i, lt);
    if (xml.startsWith("<![CDATA[", lt)) {
      const close = xml.indexOf("]]>", lt);
      if (close === -1) break;
      // CDATA is literal: it must not go through entity decoding afterwards,
      // but keeping that distinction would need a token stream. Calendar data
      // is the only CDATA we ever see and it contains no entities.
      out += xml.slice(lt + 9, close);
      i = close + 3;
      continue;
    }
    const end = findTagEnd(xml, lt);
    if (end === -1) break;
    i = end;
  }
  return out;
}

function* scanTags(xml: string): Generator<Tag> {
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt === -1) return;
    if (xml.startsWith("<!--", lt)) {
      const close = xml.indexOf("-->", lt);
      i = close === -1 ? xml.length : close + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const close = xml.indexOf("]]>", lt);
      i = close === -1 ? xml.length : close + 3;
      continue;
    }
    if (xml.startsWith("<?", lt)) {
      const close = xml.indexOf("?>", lt);
      i = close === -1 ? xml.length : close + 2;
      continue;
    }
    if (xml.startsWith("<!", lt)) {
      const close = xml.indexOf(">", lt);
      i = close === -1 ? xml.length : close + 1;
      continue;
    }
    const end = findTagEnd(xml, lt);
    if (end === -1) return;
    const body = xml.slice(lt + 1, end - 1);
    i = end;
    const tag = parseTag(body);
    if (tag) yield { ...tag, start: lt, end };
  }
}

/** Index just past the ">" that closes the tag opened at `start`. */
function findTagEnd(xml: string, start: number): number {
  let quote: string | undefined;
  for (let i = start + 1; i < xml.length; i += 1) {
    const char = xml[i];
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">") return i + 1;
  }
  return -1;
}

function parseTag(body: string): Omit<Tag, "start" | "end"> | undefined {
  let rest = body.trim();
  if (!rest) return undefined;
  let kind: Tag["kind"] = "open";
  if (rest.startsWith("/")) {
    kind = "close";
    rest = rest.slice(1);
  } else if (rest.endsWith("/")) {
    kind = "self";
    rest = rest.slice(0, -1);
  }
  const match = /^([^\s/>]+)/.exec(rest.trim());
  if (!match?.[1]) return undefined;
  const qualified = match[1];
  const name = (qualified.includes(":") ? qualified.slice(qualified.lastIndexOf(":") + 1) : qualified).toLowerCase();
  if (!name) return undefined;
  return {
    name,
    kind,
    attributes: kind === "close" ? {} : parseAttributes(rest.slice(match[1].length)),
  };
}

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const rawName = match[1];
    if (!rawName) continue;
    const name = (rawName.includes(":") ? rawName.slice(rawName.lastIndexOf(":") + 1) : rawName).toLowerCase();
    attributes[name] = decodeXmlText(match[3] ?? match[4] ?? "");
  }
  return attributes;
}
