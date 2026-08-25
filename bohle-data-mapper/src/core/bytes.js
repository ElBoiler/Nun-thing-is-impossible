/** Byte helpers shared by the ZIP, XLSX and PDF layers. */

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8');
const latin1Decoder = new TextDecoder('latin1');

export function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (typeof input === 'string') return utf8Encoder.encode(input);
  throw new TypeError('Expected bytes or string');
}

export function utf8(text) {
  return utf8Encoder.encode(text);
}

export function fromUtf8(bytes) {
  return utf8Decoder.decode(toBytes(bytes));
}

/**
 * Decode bytes as latin1 so that string index === byte index. The PDF parser
 * relies on this: PDF syntax is byte-oriented, and text is decoded later via
 * the font's own encoding.
 */
export function fromLatin1(bytes) {
  return latin1Decoder.decode(toBytes(bytes));
}

export function concatBytes(chunks) {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function runStream(bytes, stream) {
  const readable = new Blob([toBytes(bytes)]).stream().pipeThrough(stream);
  const chunks = [];
  const reader = readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return concatBytes(chunks);
}

/** Raw DEFLATE (ZIP member payloads). */
export function inflateRaw(bytes) {
  return runStream(bytes, new DecompressionStream('deflate-raw'));
}

/** zlib-wrapped DEFLATE (PDF /FlateDecode streams). */
export function inflateZlib(bytes) {
  return runStream(bytes, new DecompressionStream('deflate'));
}

export function deflateRaw(bytes) {
  return runStream(bytes, new CompressionStream('deflate-raw'));
}
