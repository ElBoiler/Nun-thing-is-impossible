/**
 * Glyph widths for the PDF base-14 fonts.
 *
 * A font dictionary is allowed to omit /Widths when it uses one of the standard
 * fonts, and plenty of report generators do exactly that. Without widths the
 * extractor cannot tell where one text run ends, so columns run together
 * ("Rohrisolierung DN 100124,50"). These tables — the Adobe AFM values for
 * codes 32..126 — keep the column gaps intact.
 *
 * Widths are in 1/1000 em. Accented characters reuse their base letter's
 * width, which is exact for these four families.
 */

const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

const TIMES_ROMAN = [
  250, 333, 408, 500, 500, 833, 778, 180, 333, 333, 500, 564, 250, 333, 250, 278,
  500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 278, 278, 564, 564, 564, 444,
  921, 722, 667, 667, 722, 611, 556, 722, 722, 333, 389, 722, 611, 889, 722, 722,
  556, 722, 667, 556, 611, 722, 722, 944, 722, 722, 611, 333, 278, 333, 469, 500,
  333, 444, 500, 444, 500, 444, 333, 500, 500, 278, 278, 500, 278, 778, 500, 500,
  500, 500, 333, 389, 278, 500, 500, 722, 500, 500, 444, 480, 200, 480, 541,
];

const TIMES_BOLD = [
  250, 333, 555, 500, 500, 1000, 833, 278, 333, 333, 500, 570, 250, 333, 250, 278,
  500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 333, 333, 570, 570, 570, 500,
  930, 722, 667, 722, 722, 667, 611, 778, 778, 389, 500, 778, 667, 944, 722, 778,
  611, 778, 722, 556, 667, 722, 722, 1000, 722, 722, 667, 333, 278, 333, 581, 500,
  333, 500, 556, 444, 556, 444, 333, 500, 556, 278, 333, 556, 278, 833, 556, 500,
  556, 556, 444, 389, 333, 556, 500, 722, 500, 500, 444, 394, 220, 394, 520,
];

/** Latin-1 accented characters share the width of their base letter. */
const BASE_LETTER = {
  192: 65, 193: 65, 194: 65, 195: 65, 196: 65, 197: 65, 199: 67, 200: 69, 201: 69,
  202: 69, 203: 69, 204: 73, 205: 73, 206: 73, 207: 73, 209: 78, 210: 79, 211: 79,
  212: 79, 213: 79, 214: 79, 217: 85, 218: 85, 219: 85, 220: 85, 221: 89,
  224: 97, 225: 97, 226: 97, 227: 97, 228: 97, 229: 97, 231: 99, 232: 101, 233: 101,
  234: 101, 235: 101, 236: 105, 237: 105, 238: 105, 239: 105, 241: 110, 242: 111,
  243: 111, 244: 111, 245: 111, 246: 111, 249: 117, 250: 117, 251: 117, 252: 117,
  253: 121, 255: 121, 223: 115, 216: 79, 248: 111, 198: 65, 230: 97,
};

const FAMILIES = [
  { test: /courier|mono/i, widths: null, fixed: 600 },
  { test: /times|serif|georgia|garamond|book/i, bold: TIMES_BOLD, regular: TIMES_ROMAN },
  { test: /.*/, bold: HELVETICA_BOLD, regular: HELVETICA },
];

/**
 * Width table for a base font name, or null when the name is unknown.
 * @returns {null | ((code:number) => number)} width lookup in em units
 */
export function standardWidths(baseFont) {
  if (!baseFont) return null;
  // Subset fonts are named like "ABCDEF+Helvetica-Bold".
  const name = String(baseFont).replace(/^[A-Z]{6}\+/, '');
  const bold = /bold|black|heavy|semibold|[-,]bd\b/i.test(name);
  const family = FAMILIES.find((entry) => entry.test.test(name));
  if (!family) return null;
  if (family.fixed) return () => family.fixed / 1000;
  const table = bold ? family.bold : family.regular;
  const fallback = (bold ? 556 : 500) / 1000;
  return (code) => {
    const resolved = BASE_LETTER[code] ?? code;
    if (resolved >= 32 && resolved <= 126) return table[resolved - 32] / 1000;
    if (code === 160) return table[0] / 1000; // non-breaking space
    return fallback;
  };
}

export const __testing = { HELVETICA, TIMES_ROMAN };
