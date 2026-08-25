/** A1-style spreadsheet reference helpers. Columns and rows are 1-based. */

export function columnToNumber(letters) {
  let n = 0;
  const upper = String(letters).toUpperCase();
  for (let i = 0; i < upper.length; i++) {
    const code = upper.charCodeAt(i) - 64; // 'A' -> 1
    if (code < 1 || code > 26) throw new Error(`Invalid column "${letters}"`);
    n = n * 26 + code;
  }
  return n;
}

export function numberToColumn(num) {
  if (!Number.isInteger(num) || num < 1) throw new Error(`Invalid column number ${num}`);
  let n = num;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** "B7" or "$B$7" -> { col: 2, row: 7 } */
export function parseRef(ref) {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(String(ref).trim());
  if (!m) throw new Error(`Invalid cell reference "${ref}"`);
  return { col: columnToNumber(m[1]), row: Number(m[2]) };
}

export function formatRef(col, row) {
  return `${numberToColumn(col)}${row}`;
}

/** "A1:C10" (or a single cell) -> { start: {col,row}, end: {col,row} } */
export function parseRange(range) {
  const text = String(range).trim().replace(/^[^!]*!/, '');
  const [a, b] = text.split(':');
  const start = parseRef(a);
  const end = b ? parseRef(b) : start;
  return {
    start: { col: Math.min(start.col, end.col), row: Math.min(start.row, end.row) },
    end: { col: Math.max(start.col, end.col), row: Math.max(start.row, end.row) },
  };
}

/** Split "Sheet1!B2" into its parts. Quoted sheet names ('My Sheet'!A1) are supported. */
export function splitSheetRef(ref) {
  const text = String(ref).trim();
  const bang = text.lastIndexOf('!');
  if (bang === -1) return { sheet: null, ref: text };
  let sheet = text.slice(0, bang);
  if (sheet.startsWith("'") && sheet.endsWith("'")) sheet = sheet.slice(1, -1).replace(/''/g, "'");
  return { sheet, ref: text.slice(bang + 1) };
}
