/**
 * Minimal, dependency-free XML tokenizer.
 *
 * Office Open XML (the guts of an .xlsx) is machine generated and very regular,
 * so a small pull-tokenizer beats a DOM: it works in the service worker and in
 * plain Node (no DOMParser), and it hands back byte offsets, which is what the
 * writer needs to splice cells into a sheet without re-serialising the parts of
 * the document it does not understand.
 */

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** Decode XML text/attribute content (entities + numeric character references). */
export function decodeXml(text) {
  if (text.indexOf('&') === -1) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    const named = ENTITIES[body];
    return named === undefined ? match : named;
  });
}

/** Escape a string for use as XML text or a double-quoted attribute value. */
export function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Control characters are illegal in XML 1.0 and make Excel reject the file.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

function parseAttrs(raw) {
  const attrs = {};
  const re = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(raw))) {
    attrs[m[1]] = decodeXml(m[3] !== undefined ? m[3] : m[4]);
  }
  return attrs;
}

/**
 * Walk an XML string.
 *
 * Yields tokens of shape:
 *   { type: 'open' | 'close' | 'self', name, attrs, start, end }
 *   { type: 'text', value, start, end }
 *
 * `start`/`end` are offsets into `xml`, so `xml.slice(start, end)` round-trips.
 */
export function* tokenize(xml) {
  let i = 0;
  const len = xml.length;
  while (i < len) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) {
      if (i < len) yield { type: 'text', value: xml.slice(i), start: i, end: len };
      return;
    }
    if (lt > i) yield { type: 'text', value: xml.slice(i, lt), start: i, end: lt };

    if (xml.startsWith('<!--', lt)) {
      const close = xml.indexOf('-->', lt);
      i = close === -1 ? len : close + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const close = xml.indexOf(']]>', lt);
      const end = close === -1 ? len : close + 3;
      yield { type: 'text', value: xml.slice(lt + 9, close === -1 ? len : close), start: lt, end, cdata: true };
      i = end;
      continue;
    }
    if (xml[lt + 1] === '?' || xml[lt + 1] === '!') {
      const close = xml.indexOf('>', lt);
      i = close === -1 ? len : close + 1;
      continue;
    }

    // Element: scan to the closing '>' while respecting quoted attribute values.
    let j = lt + 1;
    let quote = null;
    while (j < len) {
      const c = xml[j];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '>') {
        break;
      }
      j++;
    }
    const end = Math.min(j + 1, len);
    const raw = xml.slice(lt + 1, j);
    const closing = raw[0] === '/';
    const selfClosing = !closing && raw.endsWith('/');
    const body = closing ? raw.slice(1) : selfClosing ? raw.slice(0, -1) : raw;
    const nameMatch = /^\s*([^\s/>]+)/.exec(body);
    const name = nameMatch ? nameMatch[1] : '';
    yield {
      type: closing ? 'close' : selfClosing ? 'self' : 'open',
      name,
      localName: name.includes(':') ? name.slice(name.indexOf(':') + 1) : name,
      attrs: closing ? {} : parseAttrs(body.slice(nameMatch ? nameMatch[0].length : 0)),
      start: lt,
      end,
    };
    i = end;
  }
}

/**
 * Collect every `<name …>` element with its attributes and inner text.
 * Convenience for the small metadata parts (workbook.xml, rels, styles).
 */
export function findElements(xml, wanted) {
  const out = [];
  const stack = [];
  for (const token of tokenize(xml)) {
    if (token.type === 'self' && token.localName === wanted) {
      out.push({ attrs: token.attrs, text: '', start: token.start, end: token.end });
    } else if (token.type === 'open' && token.localName === wanted) {
      stack.push({ attrs: token.attrs, start: token.start, contentStart: token.end });
    } else if (stack.length && token.type === 'close' && token.localName === wanted) {
      const top = stack.pop();
      out.push({
        attrs: top.attrs,
        text: xml.slice(top.contentStart, token.start),
        start: top.start,
        end: token.end,
        contentStart: top.contentStart,
        contentEnd: token.start,
      });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Concatenate the character data of an XML fragment, ignoring markup. */
export function textContent(fragment) {
  let out = '';
  for (const token of tokenize(fragment)) {
    if (token.type === 'text') out += token.cdata ? token.value : decodeXml(token.value);
  }
  return out;
}
