/**
 * Unit-aware expression language used by every numeric input in Whittle.
 *
 *   width / 2 + 3 mm      2 * pi * r      atan(rise / run)      45 deg
 *
 * Bare numbers are friendly: they adopt the unit of whatever they are combined
 * with, or of the field they are typed into (the document's length unit, or
 * degrees for angles). So `width + 5` and `30` both "just work".
 */
import {
  type Dim,
  type LengthUnit,
  type QuantityKind,
  KIND_DIM,
  LENGTH_TO_MM,
  UNIT_LITERALS,
  describeDim,
  dimEquals,
  isDimensionless,
} from "./units";

export interface Quantity {
  value: number;
  dim: Dim;
  /** True when no unit was ever attached (e.g. `12` or `3 * 4`). */
  bare: boolean;
  /** Built from pi or tau, so in an angle context it means radians (`pi / 2` is 90°, not 1.57°). */
  radians?: boolean;
}

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

type Node =
  | { t: "num"; value: number; unit?: string; pos: number }
  | { t: "id"; name: string; pos: number }
  | { t: "call"; name: string; args: Node[]; pos: number }
  | { t: "un"; op: "-" | "+"; arg: Node; pos: number }
  | { t: "bin"; op: "+" | "-" | "*" | "/" | "^"; left: Node; right: Node; pos: number };

export class ExprError extends Error {
  constructor(
    message: string,
    public readonly pos = -1,
  ) {
    super(message);
  }
}

interface Token {
  k: "num" | "id" | "op" | "eof";
  v: string;
  pos: number;
}

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) throw new ExprError(`Unexpected "${c}"`, i);
      out.push({ k: "num", v: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ k: "id", v: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    if (c === "\u00b0") {
      out.push({ k: "id", v: "deg", pos: i });
      i++;
      continue;
    }
    if (c === '"') {
      out.push({ k: "id", v: "in", pos: i });
      i++;
      continue;
    }
    if ("+-*/^(),".includes(c)) {
      out.push({ k: "op", v: c, pos: i });
      i++;
      continue;
    }
    throw new ExprError(`I don't understand the character "${c}"`, i);
  }
  out.push({ k: "eof", v: "", pos: src.length });
  return out;
}

export function parse(src: string): Node {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p]!;
  const next = () => toks[p++]!;
  const isOp = (t: Token, v: string) => t.k === "op" && t.v === v;
  const expectOp = (v: string) => {
    const t = next();
    if (!isOp(t, v)) throw new ExprError(`Expected "${v}"`, t.pos);
  };

  function add(): Node {
    let left = mul();
    for (;;) {
      const t = peek();
      if (isOp(t, "+") || isOp(t, "-")) {
        next();
        left = { t: "bin", op: t.v as "+" | "-", left, right: mul(), pos: t.pos };
      } else return left;
    }
  }
  function mul(): Node {
    let left = unary();
    for (;;) {
      const t = peek();
      if (isOp(t, "*") || isOp(t, "/")) {
        next();
        left = { t: "bin", op: t.v as "*" | "/", left, right: unary(), pos: t.pos };
      } else return left;
    }
  }
  function unary(): Node {
    const t = peek();
    if (isOp(t, "-") || isOp(t, "+")) {
      next();
      return { t: "un", op: t.v as "-" | "+", arg: unary(), pos: t.pos };
    }
    return pow();
  }
  function pow(): Node {
    const base = primary();
    const t = peek();
    if (isOp(t, "^")) {
      next();
      return { t: "bin", op: "^", left: base, right: unary(), pos: t.pos };
    }
    return base;
  }
  function primary(): Node {
    const t = next();
    if (t.k === "num") {
      const node: Node = { t: "num", value: parseFloat(t.v), pos: t.pos };
      const u = peek();
      if (u.k === "id" && has(UNIT_LITERALS, u.v)) {
        next();
        node.unit = u.v;
      }
      return node;
    }
    if (t.k === "id") {
      if (isOp(peek(), "(")) {
        next();
        const args: Node[] = [];
        if (!isOp(peek(), ")")) {
          args.push(add());
          while (isOp(peek(), ",")) {
            next();
            args.push(add());
          }
        }
        expectOp(")");
        return { t: "call", name: t.v, args, pos: t.pos };
      }
      return { t: "id", name: t.v, pos: t.pos };
    }
    if (isOp(t, "(")) {
      const inner = add();
      expectOp(")");
      return inner;
    }
    if (t.k === "eof") throw new ExprError("The expression ends too early", t.pos);
    throw new ExprError(`Unexpected "${t.v}"`, t.pos);
  }

  if (peek().k === "eof") throw new ExprError("Enter a value");
  const root = add();
  const rest = peek();
  if (rest.k !== "eof") throw new ExprError(`Unexpected "${rest.v}"`, rest.pos);
  return root;
}

const CONSTANTS: Record<string, number> = { pi: Math.PI, PI: Math.PI, tau: Math.PI * 2 };

/** All identifiers (parameter references) used by an expression. */
export function referencedNames(src: string): string[] {
  const names = new Set<string>();
  const walk = (n: Node): void => {
    if (n.t === "id") {
      if (!has(CONSTANTS, n.name) && !has(UNIT_LITERALS, n.name)) names.add(n.name);
    } else if (n.t === "call") n.args.forEach(walk);
    else if (n.t === "un") walk(n.arg);
    else if (n.t === "bin") {
      walk(n.left);
      walk(n.right);
    }
  };
  try {
    walk(parse(src));
  } catch {
    /* syntax errors are reported by evaluate */
  }
  return [...names];
}

export interface EvalContext {
  lengthUnit: LengthUnit;
  lookup(name: string): Quantity | undefined;
}

const NONE: Dim = { len: 0, ang: 0 };

/** Give a bare number the unit implied by `dim`, using the display units. */
function adopt(q: Quantity, dim: Dim, ctx: EvalContext): Quantity {
  if (!q.bare || isDimensionless(dim)) return q;
  if (q.radians && dim.len === 0 && dim.ang === 1) return { value: q.value, dim, bare: false };
  let factor: number;
  if (dim.len === 1 && dim.ang === 0) factor = LENGTH_TO_MM[ctx.lengthUnit];
  else if (dim.len === 0 && dim.ang === 1) factor = Math.PI / 180;
  else throw new ExprError(`Add a unit to make this ${describeDim(dim)}`);
  return { value: q.value * factor, dim, bare: false };
}

function sameDims(a: Quantity, b: Quantity, ctx: EvalContext, what: string): [Quantity, Quantity] {
  if (a.bare && !b.bare) a = adopt(a, b.dim, ctx);
  if (b.bare && !a.bare) b = adopt(b, a.dim, ctx);
  if (!dimEquals(a.dim, b.dim)) {
    throw new ExprError(`Can't ${what} ${describeDim(a.dim)} and ${describeDim(b.dim)}`);
  }
  return [a, b];
}

function angleArg(q: Quantity, ctx: EvalContext, fn: string): number {
  if (q.radians && (q.bare || isDimensionless(q.dim))) return q.value;
  if (q.bare) return adopt(q, KIND_DIM.angle, ctx).value;
  if (dimEquals(q.dim, KIND_DIM.angle) || isDimensionless(q.dim)) return q.value;
  throw new ExprError(`${fn}() needs an angle, got ${describeDim(q.dim)}`);
}

/** A bare number scaled by a plain ratio (pi, sin(30), a count) stays bare, so `10 * pi` still adopts the field's unit. */
const keepsRadians = (a: Quantity, b: Quantity) => (a.radians || b.radians) && isDimensionless(a.dim) && isDimensionless(b.dim) ? true : undefined;
const scalesBare = (a: Quantity, b: Quantity) => (a.bare || isDimensionless(a.dim)) && (b.bare || isDimensionless(b.dim)) && (a.bare || b.bare);

function evalBinary(n: Extract<Node, { t: "bin" }>, ctx: EvalContext): Quantity {
  let a = evalNode(n.left, ctx);
  let b = evalNode(n.right, ctx);
  switch (n.op) {
    case "+":
      [a, b] = sameDims(a, b, ctx, "add");
      return { value: a.value + b.value, dim: a.dim, bare: a.bare && b.bare, radians: keepsRadians(a, b) };
    case "-":
      [a, b] = sameDims(a, b, ctx, "subtract");
      return { value: a.value - b.value, dim: a.dim, bare: a.bare && b.bare, radians: keepsRadians(a, b) };
    case "*":
      return {
        value: a.value * b.value,
        dim: { len: a.dim.len + b.dim.len, ang: a.dim.ang + b.dim.ang },
        bare: scalesBare(a, b),
        radians: keepsRadians(a, b),
      };
    case "/":
      if (b.value === 0) throw new ExprError("Division by zero", n.pos);
      return {
        value: a.value / b.value,
        dim: { len: a.dim.len - b.dim.len, ang: a.dim.ang - b.dim.ang },
        bare: scalesBare(a, b),
        radians: keepsRadians(a, b),
      };
    case "^": {
      if (!isDimensionless(b.dim)) throw new ExprError("Exponents must be plain numbers", n.pos);
      const e = b.value;
      if (!isDimensionless(a.dim) && !Number.isInteger(e)) {
        throw new ExprError("Only whole-number powers of units are supported", n.pos);
      }
      return { value: Math.pow(a.value, e), dim: { len: a.dim.len * e, ang: a.dim.ang * e }, bare: a.bare };
    }
  }
}

function evalNode(n: Node, ctx: EvalContext): Quantity {
  switch (n.t) {
    case "num": {
      if (!n.unit) return { value: n.value, dim: NONE, bare: true };
      const u = UNIT_LITERALS[n.unit]!;
      return { value: n.value * u.factor, dim: u.dim, bare: false };
    }
    case "id": {
      if (has(CONSTANTS, n.name)) return { value: CONSTANTS[n.name]!, dim: NONE, bare: false, radians: true };
      const q = ctx.lookup(n.name);
      if (!q) throw new ExprError(`There's no parameter called "${n.name}"`, n.pos);
      return q;
    }
    case "un": {
      const q = evalNode(n.arg, ctx);
      return n.op === "-" ? { ...q, value: -q.value } : q;
    }
    case "bin":
      return evalBinary(n, ctx);
    case "call":
      return callFn(n.name, n.args.map((x) => evalNode(x, ctx)), ctx, n.pos);
  }
}

function callFn(name: string, args: Quantity[], ctx: EvalContext, pos: number): Quantity {
  const arity = (k: number) => {
    if (args.length !== k) throw new ExprError(`${name}() takes ${k} value(s)`, pos);
  };
  const plain = (value: number): Quantity => ({ value, dim: NONE, bare: false });
  const angle = (value: number): Quantity => ({ value, dim: KIND_DIM.angle, bare: false });
  switch (name) {
    case "sin":
      arity(1);
      return plain(Math.sin(angleArg(args[0]!, ctx, name)));
    case "cos":
      arity(1);
      return plain(Math.cos(angleArg(args[0]!, ctx, name)));
    case "tan":
      arity(1);
      return plain(Math.tan(angleArg(args[0]!, ctx, name)));
    case "asin":
    case "acos":
    case "atan": {
      arity(1);
      const a = args[0]!;
      if (!isDimensionless(a.dim)) throw new ExprError(`${name}() needs a plain ratio`, pos);
      return angle(Math[name](a.value));
    }
    case "atan2": {
      arity(2);
      const [y, x] = sameDims(args[0]!, args[1]!, ctx, "compare");
      return angle(Math.atan2(y.value, x.value));
    }
    case "sqrt": {
      arity(1);
      const a = args[0]!;
      if (a.dim.len % 2 || a.dim.ang % 2) throw new ExprError("sqrt() of this unit has no unit", pos);
      if (a.value < 0) throw new ExprError("sqrt() of a negative number", pos);
      return { value: Math.sqrt(a.value), dim: { len: a.dim.len / 2, ang: a.dim.ang / 2 }, bare: a.bare };
    }
    case "abs":
      arity(1);
      return { ...args[0]!, value: Math.abs(args[0]!.value) };
    case "round":
    case "floor":
    case "ceil": {
      arity(1);
      // Round in the units people read: `round(1.4 in)` is 1 in, not 36 mm.
      const a = args[0]!;
      const unit = a.dim.len === 1 && a.dim.ang === 0 ? LENGTH_TO_MM[ctx.lengthUnit] : a.dim.len === 0 && a.dim.ang === 1 ? Math.PI / 180 : 1;
      const r = Math[name](a.value / unit) * unit;
      return { ...a, value: r };
    }
    case "min":
    case "max": {
      if (args.length < 1) throw new ExprError(`${name}() needs at least one value`, pos);
      let acc = args[0]!;
      for (const nextArg of args.slice(1)) {
        const [a, b] = sameDims(acc, nextArg, ctx, "compare");
        acc = (name === "min" ? a.value <= b.value : a.value >= b.value) ? a : b;
      }
      return acc;
    }
    default:
      throw new ExprError(`Unknown function ${name}()`, pos);
  }
}

export type EvalResult = { ok: true; value: number } | { ok: false; error: string };

/** Evaluate an expression and convert the result to the expected kind (mm / rad / plain). */
export function evaluate(src: string | number, kind: QuantityKind, ctx: EvalContext): EvalResult {
  if (typeof src === "number") return { ok: true, value: src };
  try {
    let q = evalNode(parse(src), ctx);
    const want = KIND_DIM[kind];
    if (q.bare) q = adopt(q, want, ctx);
    else if (q.radians && isDimensionless(q.dim) && dimEquals(want, KIND_DIM.angle)) q = { value: q.value, dim: want, bare: false };
    if (!dimEquals(q.dim, want)) {
      return {
        ok: false,
        error: `This needs ${describeDim(want)}, but the expression gives ${describeDim(q.dim)}`,
      };
    }
    if (!Number.isFinite(q.value)) return { ok: false, error: "The result isn't a finite number" };
    if (kind === "count") return { ok: true, value: Math.round(q.value) };
    return { ok: true, value: q.value };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Evaluate an expression without forcing a kind (used for the parameter table). */
export function evaluateRaw(src: string, ctx: EvalContext): Quantity {
  return evalNode(parse(src), ctx);
}