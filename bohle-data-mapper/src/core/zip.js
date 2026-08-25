/**
 * A tiny ZIP reader/writer built on the platform's CompressionStream.
 *
 * An .xlsx is a ZIP of XML parts. To keep a customer's template intact we only
 * ever rewrite the parts we touch and copy every other member through in its
 * already-compressed form, byte for byte.
 */

import { concatBytes, crc32, deflateRaw, fromUtf8, inflateRaw, toBytes, utf8 } from './bytes.js';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

class ZipArchive {
  constructor(bytes, entries) {
    this.bytes = bytes;
    /** @type {Map<string, object>} */
    this.entries = entries;
  }

  get names() {
    return [...this.entries.keys()];
  }

  has(name) {
    return this.entries.has(name);
  }

  entry(name) {
    return this.entries.get(name) || null;
  }

  /** Decompressed contents, or null when the member does not exist. */
  async bytesOf(name) {
    const entry = this.entries.get(name);
    if (!entry) return null;
    if (entry.method === METHOD_STORE) return entry.compressed;
    if (entry.method === METHOD_DEFLATE) return inflateRaw(entry.compressed);
    throw new Error(`Unsupported ZIP compression method ${entry.method} for "${name}"`);
  }

  /** UTF-8 text of a member, or null. */
  async textOf(name) {
    const bytes = await this.bytesOf(name);
    return bytes === null ? null : fromUtf8(bytes);
  }
}

function readU16(view, offset) {
  return view.getUint16(offset, true);
}

function readU32(view, offset) {
  return view.getUint32(offset, true);
}

/** Parse a ZIP container. Entry payloads stay compressed until requested. */
export function readZip(input) {
  const bytes = toBytes(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let eocd = -1;
  const minStart = Math.max(0, bytes.length - 0xffff - 22);
  for (let i = bytes.length - 22; i >= minStart; i--) {
    if (readU32(view, i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('Not a ZIP/XLSX file (no end-of-central-directory record found)');

  const total = readU16(view, eocd + 10);
  let offset = readU32(view, eocd + 16);
  if (offset === 0xffffffff) throw new Error('ZIP64 archives are not supported');

  const entries = new Map();
  const decoder = new TextDecoder('utf-8');
  for (let i = 0; i < total; i++) {
    if (readU32(view, offset) !== SIG_CENTRAL) throw new Error('Corrupt ZIP central directory');
    const flags = readU16(view, offset + 8);
    const method = readU16(view, offset + 10);
    const crc = readU32(view, offset + 16);
    const compressedSize = readU32(view, offset + 20);
    const uncompressedSize = readU32(view, offset + 24);
    const nameLength = readU16(view, offset + 28);
    const extraLength = readU16(view, offset + 30);
    const commentLength = readU16(view, offset + 32);
    const localOffset = readU32(view, offset + 42);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error(`ZIP64 entry "${name}" is not supported`);
    }

    if (readU32(view, localOffset) !== SIG_LOCAL) throw new Error(`Corrupt local header for "${name}"`);
    const localNameLength = readU16(view, localOffset + 26);
    const localExtraLength = readU16(view, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;

    entries.set(name, {
      name,
      flags,
      method,
      crc,
      compressedSize,
      uncompressedSize,
      compressed: bytes.subarray(dataStart, dataStart + compressedSize),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return new ZipArchive(bytes, entries);
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f);
  const day = (((year - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, day };
}

/**
 * Build a ZIP.
 *
 * Each file is either `{ name, data }` (string or bytes, deflated here) or a
 * pass-through of an existing member: `{ name, passthrough: entry }`.
 */
export async function writeZip(files, { date = new Date() } = {}) {
  const { time, day } = dosDateTime(date);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = utf8(file.name);
    let method;
    let crc;
    let uncompressedSize;
    let payload;

    if (file.passthrough) {
      const entry = file.passthrough;
      method = entry.method;
      crc = entry.crc;
      uncompressedSize = entry.uncompressedSize;
      payload = entry.compressed;
    } else {
      const raw = toBytes(file.data ?? '');
      crc = crc32(raw);
      uncompressedSize = raw.length;
      if (file.store || raw.length === 0) {
        method = METHOD_STORE;
        payload = raw;
      } else {
        const deflated = await deflateRaw(raw);
        // Storing beats deflating for tiny/incompressible parts.
        if (deflated.length < raw.length) {
          method = METHOD_DEFLATE;
          payload = deflated;
        } else {
          method = METHOD_STORE;
          payload = raw;
        }
      }
    }

    const local = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, SIG_LOCAL, true);
    localView.setUint16(4, 20, true); // version needed
    localView.setUint16(6, 0x0800, true); // UTF-8 names
    localView.setUint16(8, method, true);
    localView.setUint16(10, time, true);
    localView.setUint16(12, day, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, payload.length, true);
    localView.setUint32(22, uncompressedSize, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, SIG_CENTRAL, true);
    centralView.setUint16(4, 20, true); // version made by
    centralView.setUint16(6, 20, true); // version needed
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, method, true);
    centralView.setUint16(12, time, true);
    centralView.setUint16(14, day, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, payload.length, true);
    centralView.setUint32(24, uncompressedSize, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint32(42, offset, true);
    central.set(nameBytes, 46);

    locals.push(local, payload);
    centrals.push(central);
    offset += local.length + payload.length;
  }

  const centralSize = centrals.reduce((sum, c) => sum + c.length, 0);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, SIG_EOCD, true);
  eocdView.setUint16(8, files.length, true);
  eocdView.setUint16(10, files.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, offset, true);

  return concatBytes([...locals, ...centrals, eocd]);
}
