/**
 * Dependency-free PDF text extraction.
 *
 * Scope: text-layer PDFs — the order confirmations, delivery notes and
 * invoices that ERP systems emit. It parses the object graph (including
 * object streams), inflates content streams, runs the text-showing operators
 * with a real text/CTM matrix, decodes bytes through the font's /ToUnicode or
 * /Encoding, and reassembles glyph runs into positioned lines.
 *
 * Out of scope on purpose: encrypted PDFs and scanned pages with no text layer
 * (those need OCR). Both fail with an explicit message rather than silently
 * producing nothing.
 */

import { fromLatin1, inflateRaw, inflateZlib, toBytes } from './bytes.js';
import { standardWidths } from './standard-widths.js';

/* ------------------------------------------------------------------ syntax */

class Name {
  constructor(value) {
    this.name = value;
  }
  toString() {
    return `/${this.name}`;
  }
}

class Ref {
  constructor(num, gen) {
    this.num = num;
    this.gen = gen;
  }
}

class PdfStream {
  constructor(dict, start, rawLength) {
    this.dict = dict;
    this.start = start;
    this.rawLength = rawLength;
  }
}

const WHITESPACE = new Set([' ', '\n', '\r', '\t', '\f', '\0']);
const DELIMITERS = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%']);

function isRegular(ch) {
  return ch !== undefined && !WHITESPACE.has(ch) && !DELIMITERS.has(ch);
}

class Lexer {
  constructor(text, pos = 0) {
    this.text = text;
    this.pos = pos;
  }

  skipWhitespace() {
    const { text } = this;
    while (this.pos < text.length) {
      const ch = text[this.pos];
      if (WHITESPACE.has(ch)) {
        this.pos++;
      } else if (ch === '%') {
        while (this.pos < text.length && text[this.pos] !== '\n' && text[this.pos] !== '\r') this.pos++;
      } else {
        return;
      }
    }
  }

  readKeyword() {
    const start = this.pos;
    while (isRegular(this.text[this.pos])) this.pos++;
    return this.text.slice(start, this.pos);
  }

  readName() {
    this.pos++; // '/'
    let out = '';
    while (isRegular(this.text[this.pos])) {
      let ch = this.text[this.pos];
      if (ch === '#' && /[0-9a-fA-F]{2}/.test(this.text.substr(this.pos + 1, 2))) {
        ch = String.fromCharCode(parseInt(this.text.substr(this.pos + 1, 2), 16));
        this.pos += 2;
      }
      out += ch;
      this.pos++;
    }
    return new Name(out);
  }

  readLiteralString() {
    this.pos++; // '('
    let depth = 1;
    let out = '';
    const { text } = this;
    while (this.pos < text.length) {
      let ch = text[this.pos++];
      if (ch === '\\') {
        const next = text[this.pos++];
        switch (next) {
          case 'n': out += '\n'; break;
          case 'r': out += '\r'; break;
          case 't': out += '\t'; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          case '\n': break;
          case '\r': if (text[this.pos] === '\n') this.pos++; break;
          default:
            if (next >= '0' && next <= '7') {
              let octal = next;
              while (octal.length < 3 && text[this.pos] >= '0' && text[this.pos] <= '7') octal += text[this.pos++];
              out += String.fromCharCode(parseInt(octal, 8));
            } else {
              out += next;
            }
        }
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) break;
      }
      out += ch;
    }
    return out;
  }

  readHexString() {
    this.pos++; // '<'
    let hex = '';
    while (this.pos < this.text.length && this.text[this.pos] !== '>') {
      const ch = this.text[this.pos++];
      if (/[0-9a-fA-F]/.test(ch)) hex += ch;
    }
    this.pos++; // '>'
    if (hex.length % 2) hex += '0';
    let out = '';
    for (let i = 0; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
    return out;
  }

  /** Parse one PDF object. Returns undefined at end of input. */
  parseObject() {
    this.skipWhitespace();
    const { text } = this;
    if (this.pos >= text.length) return undefined;
    const ch = text[this.pos];

    if (ch === '/') return this.readName();
    if (ch === '(') return this.readLiteralString();
    if (ch === '[') {
      this.pos++;
      const array = [];
      for (;;) {
        this.skipWhitespace();
        if (this.pos >= text.length) break;
        if (text[this.pos] === ']') {
          this.pos++;
          break;
        }
        const value = this.parseObject();
        if (value === undefined) break;
        array.push(value);
      }
      return array;
    }
    if (ch === '<') {
      if (text[this.pos + 1] === '<') {
        this.pos += 2;
        const dict = Object.create(null);
        for (;;) {
          this.skipWhitespace();
          if (this.pos >= text.length) break;
          if (text[this.pos] === '>' && text[this.pos + 1] === '>') {
            this.pos += 2;
            break;
          }
          if (text[this.pos] !== '/') {
            // Malformed dictionary: skip a token and keep going.
            const value = this.parseObject();
            if (value === undefined) break;
            continue;
          }
          const key = this.readName().name;
          const value = this.parseObject();
          dict[key] = value;
        }
        this.skipWhitespace();
        if (text.startsWith('stream', this.pos)) {
          this.pos += 6;
          if (text[this.pos] === '\r') this.pos++;
          if (text[this.pos] === '\n') this.pos++;
          return new PdfStream(dict, this.pos, null);
        }
        return dict;
      }
      return this.readHexString();
    }
    if (ch === ']' || ch === '>' || ch === '}' || ch === ')') {
      this.pos++;
      return this.parseObject();
    }
    if (ch === '{') {
      this.pos++;
      return this.parseObject();
    }

    const start = this.pos;
    const keyword = this.readKeyword();
    if (keyword === '') {
      this.pos++;
      return this.parseObject();
    }
    if (keyword === 'true') return true;
    if (keyword === 'false') return false;
    if (keyword === 'null') return null;
    if (/^[+-.\d]/.test(keyword)) {
      const number = parseFloat(keyword.replace(/(\d)-.*$/, '$1'));
      // `12 0 R` -> indirect reference
      if (/^\d+$/.test(keyword)) {
        const save = this.pos;
        this.skipWhitespace();
        const genStart = this.pos;
        const gen = this.readKeyword();
        if (/^\d+$/.test(gen)) {
          this.skipWhitespace();
          const kw = this.readKeyword();
          if (kw === 'R') return new Ref(Number(keyword), Number(gen));
          if (kw === 'obj') {
            // Caller is scanning object headers; rewind so it can react.
            this.pos = genStart;
            return Number.isFinite(number) ? number : 0;
          }
        }
        this.pos = save;
      }
      return Number.isFinite(number) ? number : 0;
    }
    this.pos = start;
    return { operator: this.readKeyword() };
  }
}

/* ----------------------------------------------------------------- filters */

function applyPngPredictor(data, colors, bpc, columns) {
  const bpp = Math.ceil((colors * bpc) / 8);
  const rowLength = Math.ceil((colors * bpc * columns) / 8);
  const rows = Math.floor(data.length / (rowLength + 1));
  const out = new Uint8Array(rows * rowLength);
  let previous = new Uint8Array(rowLength);
  for (let r = 0; r < rows; r++) {
    const filter = data[r * (rowLength + 1)];
    const row = data.subarray(r * (rowLength + 1) + 1, (r + 1) * (rowLength + 1));
    const current = new Uint8Array(rowLength);
    for (let i = 0; i < rowLength; i++) {
      const raw = row[i] || 0;
      const left = i >= bpp ? current[i - bpp] : 0;
      const up = previous[i];
      const upLeft = i >= bpp ? previous[i - bpp] : 0;
      switch (filter) {
        case 0: current[i] = raw; break;
        case 1: current[i] = (raw + left) & 0xff; break;
        case 2: current[i] = (raw + up) & 0xff; break;
        case 3: current[i] = (raw + ((left + up) >> 1)) & 0xff; break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const nearest = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          current[i] = (raw + nearest) & 0xff;
          break;
        }
        default: current[i] = raw;
      }
    }
    out.set(current, r * rowLength);
    previous = current;
  }
  return out;
}

function decodeAsciiHex(bytes) {
  const text = fromLatin1(bytes);
  let hex = '';
  for (const ch of text) {
    if (ch === '>') break;
    if (/[0-9a-fA-F]/.test(ch)) hex += ch;
  }
  if (hex.length % 2) hex += '0';
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function decodeAscii85(bytes) {
  const text = fromLatin1(bytes).replace(/\s/g, '').replace(/^<~/, '');
  const out = [];
  let tuple = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '~') break;
    if (ch === 'z' && tuple.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    tuple.push(text.charCodeAt(i) - 33);
    if (tuple.length === 5) {
      let value = 0;
      for (const digit of tuple) value = value * 85 + digit;
      out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
      tuple = [];
    }
  }
  if (tuple.length > 1) {
    const count = tuple.length;
    while (tuple.length < 5) tuple.push(84);
    let value = 0;
    for (const digit of tuple) value = value * 85 + digit;
    const full = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
    out.push(...full.slice(0, count - 1));
  }
  return new Uint8Array(out);
}

function decodeRunLength(bytes) {
  const out = [];
  let i = 0;
  while (i < bytes.length) {
    const length = bytes[i++];
    if (length === 128) break;
    if (length < 128) {
      for (let j = 0; j <= length; j++) out.push(bytes[i++]);
    } else {
      const value = bytes[i++];
      for (let j = 0; j < 257 - length; j++) out.push(value);
    }
  }
  return new Uint8Array(out);
}

function decodeLzw(bytes, earlyChange = 1) {
  const out = [];
  const dictionary = [];
  const reset = () => {
    dictionary.length = 0;
    for (let i = 0; i < 256; i++) dictionary.push([i]);
    dictionary.push(null, null); // 256 clear, 257 eod
  };
  reset();
  let codeWidth = 9;
  let previous = null;
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < bytes.length; i++) {
    buffer = (buffer << 8) | bytes[i];
    bits += 8;
    while (bits >= codeWidth) {
      const code = (buffer >> (bits - codeWidth)) & ((1 << codeWidth) - 1);
      bits -= codeWidth;
      if (code === 256) {
        reset();
        codeWidth = 9;
        previous = null;
        continue;
      }
      if (code === 257) return new Uint8Array(out);
      let entry;
      if (code < dictionary.length && dictionary[code]) {
        entry = dictionary[code];
      } else if (previous) {
        entry = [...previous, previous[0]];
      } else {
        return new Uint8Array(out);
      }
      out.push(...entry);
      if (previous) dictionary.push([...previous, entry[0]]);
      previous = entry;
      if (dictionary.length + earlyChange >= (1 << codeWidth) && codeWidth < 12) codeWidth++;
    }
  }
  return new Uint8Array(out);
}

/* -------------------------------------------------------------- encodings */

const WIN_ANSI_HIGH = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†',
  0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ',
  0x8e: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•',
  0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›',
  0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
};

const GLYPH_NAMES = {
  space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%', ampersand: '&',
  quotesingle: "'", parenleft: '(', parenright: ')', asterisk: '*', plus: '+', comma: ',', hyphen: '-',
  period: '.', slash: '/', zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6',
  seven: '7', eight: '8', nine: '9', colon: ':', semicolon: ';', less: '<', equal: '=', greater: '>',
  question: '?', at: '@', bracketleft: '[', backslash: '\\', bracketright: ']', asciicircum: '^',
  underscore: '_', grave: '`', braceleft: '{', bar: '|', braceright: '}', asciitilde: '~',
  quoteright: '’', quoteleft: '‘', quotedblleft: '“', quotedblright: '”',
  endash: '–', emdash: '—', bullet: '•', ellipsis: '…', Euro: '€',
  adieresis: 'ä', odieresis: 'ö', udieresis: 'ü', Adieresis: 'Ä', Odieresis: 'Ö', Udieresis: 'Ü',
  germandbls: 'ß', eacute: 'é', egrave: 'è', agrave: 'à', ccedilla: 'ç', section: '§', degree: '°',
  paragraph: '¶', sterling: '£', yen: '¥', cent: '¢', currency: '¤', copyright: '©', registered: '®',
  plusminus: '±', multiply: '×', divide: '÷', onequarter: '¼', onehalf: '½', threequarters: '¾',
  nbspace: ' ', periodcentered: '·',
};

function glyphNameToUnicode(name) {
  if (Object.prototype.hasOwnProperty.call(GLYPH_NAMES, name)) return GLYPH_NAMES[name];
  if (/^[A-Za-z]$/.test(name)) return name;
  let m = /^uni([0-9A-Fa-f]{4})$/.exec(name);
  if (m) return String.fromCharCode(parseInt(m[1], 16));
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (m) return String.fromCodePoint(parseInt(m[1], 16));
  return null;
}

function winAnsi(code) {
  if (code >= 0x20 && code <= 0x7e) return String.fromCharCode(code);
  if (WIN_ANSI_HIGH[code]) return WIN_ANSI_HIGH[code];
  if (code >= 0xa0) return String.fromCharCode(code);
  return '';
}

function parseToUnicodeCMap(text) {
  const map = new Map();
  const hex = (value) => parseInt(value, 16);
  const toStr = (value) => {
    let out = '';
    for (let i = 0; i + 3 < value.length + 1; i += 4) {
      const code = parseInt(value.substr(i, 4), 16);
      if (Number.isFinite(code)) out += String.fromCharCode(code);
    }
    return out;
  };

  const charRe = /beginbfchar([\s\S]*?)endbfchar/g;
  let block;
  while ((block = charRe.exec(text))) {
    const pairRe = /<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]*)>|\/(\S+))/g;
    let pair;
    while ((pair = pairRe.exec(block[1]))) {
      const src = hex(pair[1]);
      if (pair[2] !== undefined) map.set(src, toStr(pair[2]));
      else {
        const glyph = glyphNameToUnicode(pair[3]);
        if (glyph) map.set(src, glyph);
      }
    }
  }

  const rangeRe = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((block = rangeRe.exec(text))) {
    const body = block[1];
    const entryRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]*)>|\[([\s\S]*?)\])/g;
    let entry;
    while ((entry = entryRe.exec(body))) {
      const lo = hex(entry[1]);
      const hi = hex(entry[2]);
      if (entry[3] !== undefined) {
        const base = entry[3];
        for (let code = lo; code <= hi && code - lo < 65536; code++) {
          if (base.length <= 4) {
            map.set(code, String.fromCharCode(hex(base) + (code - lo)));
          } else {
            const prefix = base.slice(0, base.length - 4);
            map.set(code, toStr(prefix + (hex(base.slice(-4)) + (code - lo)).toString(16).padStart(4, '0')));
          }
        }
      } else {
        const items = entry[4].match(/<([0-9A-Fa-f]*)>/g) || [];
        items.forEach((item, index) => map.set(lo + index, toStr(item.slice(1, -1))));
      }
    }
  }
  return map;
}

/* ------------------------------------------------------------------ matrix */

const IDENTITY = [1, 0, 0, 1, 0, 0];

function multiply(m, n) {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

function applyMatrix(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/* -------------------------------------------------------------- document */

class PdfDocument {
  constructor(raw, text) {
    this.raw = raw;
    this.text = text;
    this.objects = new Map();
    this.streamCache = new Map();
    this.pages = [];
  }

  resolve(value, depth = 0) {
    if (value instanceof Ref && depth < 32) {
      return this.resolve(this.objects.get(value.num), depth + 1);
    }
    return value;
  }

  dictGet(dict, ...keys) {
    if (!dict) return undefined;
    for (const key of keys) {
      if (dict[key] !== undefined) return this.resolve(dict[key]);
    }
    return undefined;
  }

  rawStreamBytes(stream) {
    const source = stream.source || this.raw;
    const sourceText = stream.sourceText || this.text;
    let length = this.resolve(stream.dict.Length);
    if (typeof length !== 'number' || length < 0 || stream.start + length > source.length) length = null;
    if (length !== null) {
      const after = sourceText.slice(stream.start + length, stream.start + length + 20);
      if (!/^\s*endstream/.test(after)) length = null;
    }
    if (length === null) {
      const end = sourceText.indexOf('endstream', stream.start);
      length = end === -1 ? source.length - stream.start : end - stream.start;
      while (length > 0 && (sourceText[stream.start + length - 1] === '\n' || sourceText[stream.start + length - 1] === '\r')) {
        length--;
      }
    }
    return source.subarray(stream.start, stream.start + length);
  }

  async decodeStream(stream) {
    if (this.streamCache.has(stream)) return this.streamCache.get(stream);
    let bytes = this.rawStreamBytes(stream);
    let filters = this.resolve(stream.dict.Filter ?? stream.dict.F);
    let parms = this.resolve(stream.dict.DecodeParms ?? stream.dict.DP);
    if (filters instanceof Name) filters = [filters];
    if (!Array.isArray(filters)) filters = filters ? [filters] : [];
    if (!Array.isArray(parms)) parms = [parms];

    for (let i = 0; i < filters.length; i++) {
      const filter = this.resolve(filters[i]);
      const parm = this.resolve(parms[i]) || null;
      const name = filter instanceof Name ? filter.name : String(filter);
      if (name === 'FlateDecode' || name === 'Fl') {
        try {
          bytes = await inflateZlib(bytes);
        } catch {
          try {
            bytes = await inflateRaw(bytes.subarray(bytes[0] === 0x78 ? 2 : 0));
          } catch {
            bytes = new Uint8Array(0);
          }
        }
      } else if (name === 'LZWDecode' || name === 'LZW') {
        bytes = decodeLzw(bytes, this.dictGet(parm, 'EarlyChange') ?? 1);
      } else if (name === 'ASCIIHexDecode' || name === 'AHx') {
        bytes = decodeAsciiHex(bytes);
      } else if (name === 'ASCII85Decode' || name === 'A85') {
        bytes = decodeAscii85(bytes);
      } else if (name === 'RunLengthDecode' || name === 'RL') {
        bytes = decodeRunLength(bytes);
      } else {
        // Image codecs (DCT/JPX/CCITT) — nothing textual to gain.
        bytes = new Uint8Array(0);
        break;
      }
      const predictor = this.dictGet(parm, 'Predictor') || 1;
      if (predictor >= 10) {
        bytes = applyPngPredictor(
          bytes,
          this.dictGet(parm, 'Colors') || 1,
          this.dictGet(parm, 'BitsPerComponent') || 8,
          this.dictGet(parm, 'Columns') || 1,
        );
      }
    }
    this.streamCache.set(stream, bytes);
    return bytes;
  }
}

function collectObjects(doc) {
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let match;
  while ((match = re.exec(doc.text))) {
    const num = Number(match[1]);
    const lexer = new Lexer(doc.text, match.index + match[0].length);
    let value;
    try {
      value = lexer.parseObject();
    } catch {
      continue;
    }
    if (value === undefined) continue;
    doc.objects.set(num, value);
    if (value instanceof PdfStream) {
      // Skip past the stream payload so its bytes are never mistaken for objects.
      const end = doc.text.indexOf('endstream', value.start);
      if (end > re.lastIndex) re.lastIndex = end;
    }
  }
}

async function expandObjectStreams(doc) {
  const containers = [...doc.objects.values()].filter(
    (value) => value instanceof PdfStream && doc.resolve(value.dict.Type) instanceof Name && value.dict.Type.name === 'ObjStm',
  );
  for (const container of containers) {
    let bytes;
    try {
      bytes = await doc.decodeStream(container);
    } catch {
      continue;
    }
    const text = fromLatin1(bytes);
    const count = doc.dictGet(container.dict, 'N') || 0;
    const first = doc.dictGet(container.dict, 'First') || 0;
    const header = new Lexer(text, 0);
    const pairs = [];
    for (let i = 0; i < count; i++) {
      const num = header.parseObject();
      const offset = header.parseObject();
      if (typeof num !== 'number' || typeof offset !== 'number') break;
      pairs.push([num, offset]);
    }
    for (const [num, offset] of pairs) {
      if (doc.objects.has(num)) continue;
      const lexer = new Lexer(text, first + offset);
      let value;
      try {
        value = lexer.parseObject();
      } catch {
        continue;
      }
      if (value instanceof PdfStream) {
        value.source = bytes;
        value.sourceText = text;
      }
      if (value !== undefined) doc.objects.set(num, value);
    }
  }
}

function collectPages(doc) {
  const catalog = [...doc.objects.values()].find(
    (value) => value && !Array.isArray(value) && typeof value === 'object' && value.Type instanceof Name && value.Type.name === 'Catalog',
  );
  const pages = [];
  const seen = new Set();

  const walk = (node, inherited, depth) => {
    const dict = doc.resolve(node);
    if (!dict || typeof dict !== 'object' || Array.isArray(dict) || depth > 64 || pages.length > 5000) return;
    const state = {
      Resources: doc.dictGet(dict, 'Resources') ?? inherited.Resources,
      MediaBox: doc.dictGet(dict, 'MediaBox') ?? inherited.MediaBox,
      Rotate: doc.dictGet(dict, 'Rotate') ?? inherited.Rotate,
    };
    const kids = doc.dictGet(dict, 'Kids');
    const type = dict.Type instanceof Name ? dict.Type.name : null;
    if (Array.isArray(kids) && type !== 'Page') {
      for (const kid of kids) {
        const key = kid instanceof Ref ? kid.num : kid;
        if (seen.has(key)) continue;
        if (kid instanceof Ref) seen.add(key);
        walk(kid, state, depth + 1);
      }
      return;
    }
    if (type === 'Page' || dict.Contents !== undefined) {
      pages.push({ dict, ...state });
    }
  };

  if (catalog) walk(doc.resolve(catalog.Pages), {}, 0);

  if (!pages.length) {
    // Damaged page tree: fall back to object order.
    for (const [, value] of [...doc.objects.entries()].sort((a, b) => a[0] - b[0])) {
      if (value && typeof value === 'object' && !Array.isArray(value) && value.Type instanceof Name && value.Type.name === 'Page') {
        pages.push({
          dict: value,
          Resources: doc.dictGet(value, 'Resources'),
          MediaBox: doc.dictGet(value, 'MediaBox'),
          Rotate: doc.dictGet(value, 'Rotate'),
        });
      }
    }
  }
  return pages;
}

/* -------------------------------------------------------------------- fonts */

async function buildFont(doc, fontDict) {
  const font = {
    twoByte: false,
    widths: new Map(),
    defaultWidth: 0.5,
    toUnicode: null,
    differences: new Map(),
    widthFor: null,
  };
  if (!fontDict) return font;

  const subtype = fontDict.Subtype instanceof Name ? fontDict.Subtype.name : '';
  const toUnicodeStream = doc.dictGet(fontDict, 'ToUnicode');
  if (toUnicodeStream instanceof PdfStream) {
    try {
      font.toUnicode = parseToUnicodeCMap(fromLatin1(await doc.decodeStream(toUnicodeStream)));
    } catch {
      font.toUnicode = null;
    }
  }

  if (subtype === 'Type0') {
    font.twoByte = true;
    const descendants = doc.dictGet(fontDict, 'DescendantFonts');
    const descendant = Array.isArray(descendants) ? doc.resolve(descendants[0]) : null;
    if (descendant) {
      font.defaultWidth = (doc.dictGet(descendant, 'DW') ?? 1000) / 1000;
      const w = doc.dictGet(descendant, 'W');
      if (Array.isArray(w)) {
        for (let i = 0; i < w.length;) {
          const first = doc.resolve(w[i++]);
          const next = doc.resolve(w[i++]);
          if (Array.isArray(next)) {
            next.forEach((width, index) => font.widths.set(first + index, doc.resolve(width) / 1000));
          } else {
            const width = doc.resolve(w[i++]);
            for (let code = first; code <= next && code - first < 65536; code++) font.widths.set(code, width / 1000);
          }
        }
      }
    }
    return font;
  }

  const encoding = doc.dictGet(fontDict, 'Encoding');
  if (encoding && !(encoding instanceof Name)) {
    const differences = doc.dictGet(encoding, 'Differences');
    if (Array.isArray(differences)) {
      let code = 0;
      for (const item of differences) {
        const value = doc.resolve(item);
        if (typeof value === 'number') code = value;
        else if (value instanceof Name) font.differences.set(code++, value.name);
      }
    }
  }

  const firstChar = doc.dictGet(fontDict, 'FirstChar') ?? 0;
  const widths = doc.dictGet(fontDict, 'Widths');
  if (Array.isArray(widths)) {
    widths.forEach((width, index) => {
      const value = doc.resolve(width);
      if (typeof value === 'number') font.widths.set(firstChar + index, value / 1000);
    });
  }
  const descriptor = doc.dictGet(fontDict, 'FontDescriptor');
  const missing = descriptor ? doc.dictGet(descriptor, 'MissingWidth') : null;
  if (typeof missing === 'number') font.defaultWidth = missing / 1000;
  if (!font.widths.size) {
    // No /Widths: allowed for the base-14 fonts, and common in simple
    // generators. Fall back to the standard metrics so columns stay apart.
    const baseFont = doc.dictGet(fontDict, 'BaseFont');
    font.widthFor = standardWidths(baseFont instanceof Name ? baseFont.name : '');
  }
  return font;
}

function decodeWithFont(font, bytes) {
  const glyphs = [];
  if (font.twoByte) {
    for (let i = 0; i < bytes.length; i += 2) {
      const code = (bytes.charCodeAt(i) << 8) | (bytes.charCodeAt(i + 1) || 0);
      const unicode = font.toUnicode?.get(code);
      glyphs.push({
        code,
        text: unicode !== undefined ? unicode : code >= 32 && code < 0xffff ? String.fromCharCode(code) : '',
        width: font.widths.get(code) ?? font.defaultWidth,
      });
    }
    return glyphs;
  }
  for (let i = 0; i < bytes.length; i++) {
    const code = bytes.charCodeAt(i);
    let text = font.toUnicode?.get(code);
    if (text === undefined) {
      const glyphName = font.differences.get(code);
      text = glyphName ? glyphNameToUnicode(glyphName) : null;
      if (text === null || text === undefined) text = winAnsi(code);
    }
    glyphs.push({
      code,
      text,
      width: font.widths.get(code) ?? (font.widthFor ? font.widthFor(code) : font.defaultWidth),
    });
  }
  return glyphs;
}

/* ------------------------------------------------------- content execution */

function* contentTokens(text) {
  const lexer = new Lexer(text, 0);
  for (;;) {
    lexer.skipWhitespace();
    if (lexer.pos >= text.length) return;
    const ch = text[lexer.pos];
    if (ch === '/' || ch === '(' || ch === '<' || ch === '[' || /[+-.\d]/.test(ch)) {
      const before = lexer.pos;
      let value;
      try {
        value = lexer.parseObject();
      } catch {
        return;
      }
      if (lexer.pos === before) lexer.pos++;
      yield { operand: value };
      continue;
    }
    const keyword = lexer.readKeyword();
    if (keyword === '') {
      lexer.pos++;
      continue;
    }
    if (keyword === 'BI') {
      // Inline image: jump past the binary payload.
      const id = text.indexOf('ID', lexer.pos);
      const ei = text.indexOf('EI', id === -1 ? lexer.pos : id + 2);
      lexer.pos = ei === -1 ? text.length : ei + 2;
      continue;
    }
    yield { operator: keyword, pos: lexer.pos };
  }
}

async function runContent(doc, content, resources, state, out, depth) {
  const fonts = new Map();
  const getFont = async (name) => {
    if (fonts.has(name)) return fonts.get(name);
    const fontDicts = doc.dictGet(resources, 'Font');
    const fontDict = fontDicts ? doc.dictGet(fontDicts, name) : null;
    const font = await buildFont(doc, fontDict);
    fonts.set(name, font);
    return font;
  };

  let ctm = state.ctm;
  const stack = [];
  let tm = IDENTITY;
  let tlm = IDENTITY;
  let font = null;
  let fontSize = 0;
  let charSpacing = 0;
  let wordSpacing = 0;
  let horizontalScale = 1;
  let leading = 0;
  let rise = 0;
  const operands = [];

  const showText = (bytes) => {
    if (!font || !bytes) return;
    const glyphs = decodeWithFont(font, bytes);
    let text = '';
    const startMatrix = multiply(multiply([fontSize * horizontalScale, 0, 0, fontSize, 0, rise], tm), ctm);
    let displacement = 0;
    for (const glyph of glyphs) {
      text += glyph.text;
      const isSpaceByte = !font.twoByte && glyph.code === 32;
      displacement += (glyph.width * fontSize + charSpacing + (isSpaceByte ? wordSpacing : 0)) * horizontalScale;
    }
    tm = multiply([1, 0, 0, 1, displacement, 0], tm);
    if (!text.trim()) return;
    const [x, y] = applyMatrix(startMatrix, 0, 0);
    const endMatrix = multiply(multiply([fontSize * horizontalScale, 0, 0, fontSize, 0, rise], tm), ctm);
    const [endX] = applyMatrix(endMatrix, 0, 0);
    const scale = Math.hypot(ctm[2], ctm[3]) || 1;
    out.push({ text, x, y, width: Math.abs(endX - x), height: Math.abs(fontSize * scale) });
  };

  for (const token of contentTokens(content)) {
    if (token.operand !== undefined) {
      if (operands.length < 64) operands.push(token.operand);
      continue;
    }
    const op = token.operator;
    const num = (index) => {
      const value = operands[operands.length + index];
      return typeof value === 'number' ? value : 0;
    };

    switch (op) {
      case 'q':
        stack.push({ ctm });
        break;
      case 'Q': {
        const saved = stack.pop();
        if (saved) ctm = saved.ctm;
        break;
      }
      case 'cm':
        ctm = multiply([num(-6), num(-5), num(-4), num(-3), num(-2), num(-1)], ctm);
        break;
      case 'BT':
        tm = IDENTITY;
        tlm = IDENTITY;
        break;
      case 'ET':
        break;
      case 'Tf': {
        fontSize = num(-1);
        const name = operands[operands.length - 2];
        if (name instanceof Name) font = await getFont(name.name);
        break;
      }
      case 'Td':
        tlm = multiply([1, 0, 0, 1, num(-2), num(-1)], tlm);
        tm = tlm;
        break;
      case 'TD':
        leading = -num(-1);
        tlm = multiply([1, 0, 0, 1, num(-2), num(-1)], tlm);
        tm = tlm;
        break;
      case 'Tm':
        tlm = [num(-6), num(-5), num(-4), num(-3), num(-2), num(-1)];
        tm = tlm;
        break;
      case 'T*':
        tlm = multiply([1, 0, 0, 1, 0, -leading], tlm);
        tm = tlm;
        break;
      case 'TL':
        leading = num(-1);
        break;
      case 'Tc':
        charSpacing = num(-1);
        break;
      case 'Tw':
        wordSpacing = num(-1);
        break;
      case 'Tz':
        horizontalScale = num(-1) / 100;
        break;
      case 'Ts':
        rise = num(-1);
        break;
      case 'Tj':
        showText(typeof operands[operands.length - 1] === 'string' ? operands[operands.length - 1] : '');
        break;
      case "'":
        tlm = multiply([1, 0, 0, 1, 0, -leading], tlm);
        tm = tlm;
        showText(typeof operands[operands.length - 1] === 'string' ? operands[operands.length - 1] : '');
        break;
      case '"':
        wordSpacing = num(-3);
        charSpacing = num(-2);
        tlm = multiply([1, 0, 0, 1, 0, -leading], tlm);
        tm = tlm;
        showText(typeof operands[operands.length - 1] === 'string' ? operands[operands.length - 1] : '');
        break;
      case 'TJ': {
        const array = operands[operands.length - 1];
        if (Array.isArray(array)) {
          for (const item of array) {
            if (typeof item === 'string') showText(item);
            else if (typeof item === 'number') {
              tm = multiply([1, 0, 0, 1, (-item / 1000) * fontSize * horizontalScale, 0], tm);
            }
          }
        }
        break;
      }
      case 'Do': {
        if (depth >= 8) break;
        const name = operands[operands.length - 1];
        const xobjects = doc.dictGet(resources, 'XObject');
        const xobject = name instanceof Name && xobjects ? doc.dictGet(xobjects, name.name) : null;
        if (xobject instanceof PdfStream) {
          const subtype = xobject.dict.Subtype instanceof Name ? xobject.dict.Subtype.name : '';
          if (subtype === 'Form') {
            const matrix = doc.dictGet(xobject.dict, 'Matrix');
            const formCtm = Array.isArray(matrix) && matrix.length === 6 ? multiply(matrix.map(Number), ctm) : ctm;
            const formResources = doc.dictGet(xobject.dict, 'Resources') || resources;
            const bytes = await doc.decodeStream(xobject);
            await runContent(doc, fromLatin1(bytes), formResources, { ctm: formCtm }, out, depth + 1);
          }
        }
        break;
      }
      default:
        break;
    }
    operands.length = 0;
  }
}

function assembleLines(items) {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  let current = null;
  for (const item of sorted) {
    const tolerance = Math.max(1.5, (item.height || 10) * 0.4);
    if (!current || Math.abs(current.y - item.y) > tolerance) {
      current = { y: item.y, items: [item] };
      lines.push(current);
    } else {
      current.items.push(item);
      current.y = (current.y * (current.items.length - 1) + item.y) / current.items.length;
    }
  }
  return lines.map((line, index) => {
    line.items.sort((a, b) => a.x - b.x);
    let text = '';
    let previousEnd = null;
    for (const item of line.items) {
      if (previousEnd !== null) {
        const gap = item.x - previousEnd;
        const threshold = Math.max(1, (item.height || 10) * 0.18);
        if (gap > threshold && !/\s$/.test(text) && !/^\s/.test(item.text)) text += ' ';
      }
      text += item.text;
      previousEnd = item.x + item.width;
    }
    return {
      index,
      y: line.y,
      x: line.items.length ? line.items[0].x : 0,
      text: text.replace(/\s+/g, ' ').trim(),
      items: line.items,
    };
  }).filter((line) => line.text.length > 0);
}

/**
 * Parse a PDF and extract its text layer.
 *
 * @returns {Promise<{pageCount:number, pages:Array, lines:Array, text:string}>}
 */
export async function readPdf(input) {
  const raw = toBytes(input);
  if (fromLatin1(raw.subarray(0, 1024)).indexOf('%PDF-') === -1) {
    throw new Error('Not a PDF file (missing %PDF header)');
  }
  const text = fromLatin1(raw);
  if (/\/Encrypt\s+\d+\s+\d+\s+R/.test(text)) {
    throw new Error('This PDF is encrypted. Remove the password protection and try again.');
  }

  const doc = new PdfDocument(raw, text);
  collectObjects(doc);
  await expandObjectStreams(doc);

  const pageNodes = collectPages(doc);
  const pages = [];
  let lineCounter = 0;
  const allLines = [];

  for (let index = 0; index < pageNodes.length; index++) {
    const node = pageNodes[index];
    const mediaBox = Array.isArray(node.MediaBox) ? node.MediaBox.map((v) => Number(doc.resolve(v)) || 0) : [0, 0, 595, 842];
    const width = Math.abs(mediaBox[2] - mediaBox[0]);
    const height = Math.abs(mediaBox[3] - mediaBox[1]);

    let contents = doc.dictGet(node.dict, 'Contents');
    if (!Array.isArray(contents)) contents = contents ? [contents] : [];
    let content = '';
    for (const part of contents) {
      const stream = doc.resolve(part);
      if (stream instanceof PdfStream) {
        try {
          content += `${fromLatin1(await doc.decodeStream(stream))}\n`;
        } catch {
          /* skip unreadable content stream */
        }
      }
    }

    const items = [];
    if (content) {
      // Flip to a top-left origin so "line 1" is the top of the page.
      const base = [1, 0, 0, 1, -mediaBox[0], -mediaBox[1]];
      try {
        await runContent(doc, content, node.Resources, { ctm: base }, items, 0);
      } catch (error) {
        items.length = 0;
        console.warn(`Page ${index + 1}: content stream failed (${error.message})`);
      }
    }

    const lines = assembleLines(items).map((line) => ({ ...line, page: index + 1, index: lineCounter++ }));
    allLines.push(...lines);
    pages.push({
      number: index + 1,
      width,
      height,
      items,
      lines,
      text: lines.map((line) => line.text).join('\n'),
    });
  }

  const fullText = pages.map((page) => page.text).join('\n');
  if (!fullText.trim() && pages.length) {
    throw new Error(
      'No text layer found — this PDF looks like a scan. Run OCR on it first (e.g. "Text erkennen" in Acrobat) and try again.',
    );
  }

  return { pageCount: pages.length, pages, lines: allLines, text: fullText };
}

export const __testing = { Lexer, parseToUnicodeCMap, assembleLines, decodeAscii85, decodeLzw };
