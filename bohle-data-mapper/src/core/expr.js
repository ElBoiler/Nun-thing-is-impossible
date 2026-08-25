/**
 * A very small expression language for mapping rules.
 *
 * Rules run inside a Chrome extension, where the CSP forbids `eval` and
 * `new Function` — and where running arbitrary JS from a rules file would be a
 * bad idea anyway. So expressions are parsed and evaluated here: arithmetic,
 * comparisons, string helpers, and lookups into the field/row scope.
 *
 *   "menge * einzelpreis"
 *   "if(rabatt > 0, netto * (1 - rabatt / 100), netto)"
 *   "upper(left(kunde, 3)) & '-' & auftragsnummer"
 */

const OPERATORS = ['<=', '>=', '==', '!=', '<>', '&&', '||', '<', '>', '=', '+', '-', '*', '/', '%', '&'];

function tokenize(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let out = '';
      i++;
      while (i < source.length && source[i] !== ch) {
        if (source[i] === '\\' && i + 1 < source.length) {
          out += source[i + 1];
          i += 2;
        } else {
          out += source[i++];
        }
      }
      i++;
      tokens.push({ type: 'string', value: out });
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(source[i + 1] || ''))) {
      let out = '';
      while (i < source.length && /[0-9._]/.test(source[i])) out += source[i++];
      tokens.push({ type: 'number', value: Number(out.replace(/_/g, '')) });
      continue;
    }
    if (/[A-Za-z_$À-ɏ]/.test(ch)) {
      let out = '';
      while (i < source.length && /[A-Za-z0-9_$.À-ɏ]/.test(source[i])) out += source[i++];
      tokens.push({ type: 'ident', value: out });
      continue;
    }
    const operator = OPERATORS.find((op) => source.startsWith(op, i));
    if (operator) {
      tokens.push({ type: 'op', value: operator });
      i += operator.length;
      continue;
    }
    if ('(),?:[]'.includes(ch)) {
      tokens.push({ type: 'punct', value: ch });
      i++;
      continue;
    }
    throw new Error(`Unexpected character "${ch}" in expression`);
  }
  tokens.push({ type: 'end', value: null });
  return tokens;
}

/* ------------------------------------------------------------- evaluation */

function toNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.getTime();
  const text = String(value).trim().replace(/\s/g, '');
  // Accept both 1.234,56 (de) and 1,234.56 (en).
  const normalised = /,\d{1,2}$/.test(text)
    ? text.replace(/\./g, '').replace(',', '.')
    : text.replace(/,/g, '');
  const num = Number(normalised.replace(/[^0-9.eE+-]/g, ''));
  return Number.isFinite(num) ? num : 0;
}

function toText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

function truthy(value) {
  if (value === null || value === undefined || value === '' || value === false) return false;
  if (typeof value === 'number') return value !== 0;
  return true;
}

const FUNCTIONS = {
  number: (v) => toNumber(v),
  text: (v) => toText(v),
  round: (v, digits = 0) => {
    const factor = 10 ** toNumber(digits);
    return Math.round((toNumber(v) + Number.EPSILON) * factor) / factor;
  },
  floor: (v) => Math.floor(toNumber(v)),
  ceil: (v) => Math.ceil(toNumber(v)),
  abs: (v) => Math.abs(toNumber(v)),
  min: (...args) => Math.min(...args.map(toNumber)),
  max: (...args) => Math.max(...args.map(toNumber)),
  sum: (...args) => args.flat().reduce((total, v) => total + toNumber(v), 0),
  len: (v) => toText(v).length,
  upper: (v) => toText(v).toUpperCase(),
  lower: (v) => toText(v).toLowerCase(),
  trim: (v) => toText(v).trim(),
  left: (v, n) => toText(v).slice(0, toNumber(n)),
  right: (v, n) => (toNumber(n) === 0 ? '' : toText(v).slice(-toNumber(n))),
  mid: (v, start, length) => toText(v).substr(Math.max(0, toNumber(start) - 1), toNumber(length)),
  contains: (v, needle) => toText(v).toLowerCase().includes(toText(needle).toLowerCase()),
  replace: (v, find, withText) => toText(v).split(toText(find)).join(toText(withText)),
  concat: (...args) => args.map(toText).join(''),
  if: (condition, whenTrue, whenFalse = '') => (truthy(condition) ? whenTrue : whenFalse),
  coalesce: (...args) => args.find((value) => value !== null && value !== undefined && value !== '') ?? '',
  isblank: (v) => v === null || v === undefined || v === '',
  today: () => new Date(),
};

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek() {
    return this.tokens[this.pos];
  }

  eat(type, value) {
    const token = this.peek();
    if (token.type === type && (value === undefined || token.value === value)) {
      this.pos++;
      return token;
    }
    return null;
  }

  expect(type, value) {
    const token = this.eat(type, value);
    if (!token) throw new Error(`Expected ${value || type} in expression`);
    return token;
  }

  parse() {
    const node = this.ternary();
    if (this.peek().type !== 'end') throw new Error('Unexpected trailing input in expression');
    return node;
  }

  ternary() {
    const condition = this.binary(0);
    if (this.eat('punct', '?')) {
      const whenTrue = this.ternary();
      this.expect('punct', ':');
      const whenFalse = this.ternary();
      return { type: 'ternary', condition, whenTrue, whenFalse };
    }
    return condition;
  }

  binary(level) {
    const levels = [
      ['||'],
      ['&&'],
      ['==', '!=', '=', '<>'],
      ['<', '>', '<=', '>='],
      ['+', '-', '&'],
      ['*', '/', '%'],
    ];
    if (level >= levels.length) return this.unary();
    let left = this.binary(level + 1);
    for (;;) {
      const token = this.peek();
      if (token.type === 'op' && levels[level].includes(token.value)) {
        this.pos++;
        const right = this.binary(level + 1);
        left = { type: 'binary', operator: token.value, left, right };
      } else {
        return left;
      }
    }
  }

  unary() {
    if (this.eat('op', '-')) return { type: 'unary', operator: '-', operand: this.unary() };
    if (this.eat('op', '+')) return this.unary();
    return this.primary();
  }

  primary() {
    const token = this.peek();
    if (token.type === 'number' || token.type === 'string') {
      this.pos++;
      return { type: 'literal', value: token.value };
    }
    if (token.type === 'ident') {
      this.pos++;
      if (this.eat('punct', '(')) {
        const args = [];
        if (!this.eat('punct', ')')) {
          do {
            args.push(this.ternary());
          } while (this.eat('punct', ','));
          this.expect('punct', ')');
        }
        return { type: 'call', name: token.value.toLowerCase(), args };
      }
      return { type: 'ref', path: token.value };
    }
    if (this.eat('punct', '(')) {
      const node = this.ternary();
      this.expect('punct', ')');
      return node;
    }
    throw new Error(`Unexpected token "${token.value ?? 'end of input'}" in expression`);
  }
}

function lookup(path, scope) {
  const parts = path.split('.');
  const tryPath = (root) => {
    let current = root;
    for (const part of parts) {
      // Own properties only: an expression must never reach `constructor`,
      // `__proto__` or anything else off the prototype chain.
      if (current === null || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, part)) {
        return undefined;
      }
      current = current[part];
    }
    return current;
  };
  const direct = tryPath(scope);
  if (direct !== undefined) return direct;
  if (scope.row) {
    const inRow = tryPath(scope.row);
    if (inRow !== undefined) return inRow;
  }
  if (scope.fields) {
    const inFields = tryPath(scope.fields);
    if (inFields !== undefined) return inFields;
  }
  if (parts.length === 1) {
    const lowered = parts[0].toLowerCase();
    for (const container of [scope.fields, scope.row, scope]) {
      if (!container) continue;
      const key = Object.keys(container).find((name) => name.toLowerCase() === lowered);
      if (key !== undefined) return container[key];
    }
  }
  return undefined;
}

function evaluate(node, scope) {
  switch (node.type) {
    case 'literal':
      return node.value;
    case 'ref': {
      if (node.path === 'true') return true;
      if (node.path === 'false') return false;
      if (node.path === 'null') return null;
      const value = lookup(node.path, scope);
      return value === undefined ? '' : value;
    }
    case 'unary':
      return -toNumber(evaluate(node.operand, scope));
    case 'ternary':
      return truthy(evaluate(node.condition, scope))
        ? evaluate(node.whenTrue, scope)
        : evaluate(node.whenFalse, scope);
    case 'call': {
      const fn = FUNCTIONS[node.name];
      if (!fn) throw new Error(`Unknown function "${node.name}()" in expression`);
      // `if` must not evaluate both branches eagerly for the common guard case,
      // but keeping it simple is fine here: arguments are pure.
      return fn(...node.args.map((arg) => evaluate(arg, scope)));
    }
    case 'binary': {
      const left = evaluate(node.left, scope);
      if (node.operator === '&&') return truthy(left) ? evaluate(node.right, scope) : false;
      if (node.operator === '||') return truthy(left) ? left : evaluate(node.right, scope);
      const right = evaluate(node.right, scope);
      switch (node.operator) {
        case '+':
          if (typeof left === 'string' || typeof right === 'string') {
            const bothNumeric = toText(left).trim() !== '' && toText(right).trim() !== ''
              && !Number.isNaN(Number(toText(left))) && !Number.isNaN(Number(toText(right)));
            if (!bothNumeric) return toText(left) + toText(right);
          }
          return toNumber(left) + toNumber(right);
        case '&': return toText(left) + toText(right);
        case '-': return toNumber(left) - toNumber(right);
        case '*': return toNumber(left) * toNumber(right);
        case '/': {
          const divisor = toNumber(right);
          return divisor === 0 ? '' : toNumber(left) / divisor;
        }
        case '%': {
          const divisor = toNumber(right);
          return divisor === 0 ? '' : toNumber(left) % divisor;
        }
        case '==':
        case '=':
          return toText(left) === toText(right) || toNumber(left) === toNumber(right);
        case '!=':
        case '<>':
          return !(toText(left) === toText(right) || toNumber(left) === toNumber(right));
        case '<': return toNumber(left) < toNumber(right);
        case '>': return toNumber(left) > toNumber(right);
        case '<=': return toNumber(left) <= toNumber(right);
        case '>=': return toNumber(left) >= toNumber(right);
        default:
          throw new Error(`Unsupported operator "${node.operator}"`);
      }
    }
    default:
      throw new Error(`Unsupported expression node "${node.type}"`);
  }
}

const cache = new Map();

/** Parse (and cache) an expression. Throws on syntax errors. */
export function compileExpression(source) {
  const key = String(source);
  if (!cache.has(key)) cache.set(key, new Parser(tokenize(key)).parse());
  return cache.get(key);
}

/**
 * Evaluate an expression against a scope, e.g.
 * `{ fields: {...}, row: {...}, value: … }`.
 */
export function evaluateExpression(source, scope = {}) {
  return evaluate(compileExpression(source), scope);
}

export const __testing = { tokenize, toNumber, toText, FUNCTIONS };
