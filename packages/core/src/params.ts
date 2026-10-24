import { type EvalContext, type EvalResult, type Quantity, evaluate, evaluateRaw, referencedNames } from "./expr";
import type { Expr, Parameter, WhittleDocument } from "./model";
import { KIND_DIM, type LengthUnit, type QuantityKind, UNIT_LITERALS } from "./units";

export interface ParamValue {
  ok: boolean;
  value: number;
  error?: string;
}

export interface Evaluator {
  params: Map<string, ParamValue>;
  /** Evaluate an expression to mm / rad / plain number. */
  eval(expr: Expr | number, kind: QuantityKind): EvalResult;
  /** Like eval, but throws a readable error (used inside the kernel). */
  num(expr: Expr | number, kind: QuantityKind, label?: string): number;
}

export const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Every unit word too: a parameter called "mil" or "yd" would be read as the unit, so its uses would go untracked.
const RESERVED = new Set(["pi", "PI", "tau", ...Object.keys(UNIT_LITERALS)]);

export function validateParamName(name: string, params: Parameter[], selfId?: string): string | null {
  if (!PARAM_NAME.test(name)) return "Use letters, digits and _ (start with a letter)";
  if (RESERVED.has(name)) return `"${name}" is reserved`;
  if (params.some((p) => p.name === name && p.id !== selfId)) return `"${name}" already exists`;
  return null;
}

/**
 * Resolve every parameter of a document (in dependency order, with cycle
 * detection) and return an evaluator for feature expressions.
 */
export function createEvaluator(
  parameters: Parameter[],
  lengthUnit: LengthUnit,
): Evaluator {
  const byName = new Map(parameters.map((p) => [p.name, p]));
  const resolved = new Map<string, Quantity>();
  const results = new Map<string, ParamValue>();
  const visiting = new Set<string>();

  const ctx: EvalContext = {
    lengthUnit,
    lookup: (name) => resolve(name),
  };

  function resolve(name: string): Quantity | undefined {
    if (resolved.has(name)) return resolved.get(name);
    const p = byName.get(name);
    if (!p) return undefined;
    if (visiting.has(name)) throw new Error(`"${name}" depends on itself`);
    visiting.add(name);
    try {
      const r = evaluate(p.expr, p.kind, {
        lengthUnit,
        lookup: (n) => {
          const q = resolve(n);
          if (q === undefined && results.get(n)?.ok === false) throw new Error(`"${n}" has an error`);
          return q;
        },
      });
      if (r.ok) {
        const q: Quantity = { value: r.value, dim: KIND_DIM[p.kind], bare: false };
        resolved.set(name, q);
        results.set(name, { ok: true, value: r.value });
        return q;
      }
      results.set(name, { ok: false, value: NaN, error: r.error });
      return undefined;
    } catch (e) {
      results.set(name, { ok: false, value: NaN, error: e instanceof Error ? e.message : String(e) });
      return undefined;
    } finally {
      visiting.delete(name);
    }
  }

  for (const p of parameters) {
    if (!results.has(p.name)) resolve(p.name);
  }

  const evaluator: Evaluator = {
    params: results,
    eval: (expr, kind) => {
      if (typeof expr === "string") {
        for (const n of referencedNames(expr)) {
          const r = results.get(n);
          if (r && !r.ok) return { ok: false, error: `Parameter "${n}" has an error: ${r.error}` };
        }
      }
      return evaluate(expr, kind, ctx);
    },
    num: (expr, kind, label) => {
      const r = evaluator.eval(expr, kind);
      if (!r.ok) throw new Error(label ? `${label}: ${r.error}` : r.error);
      return r.value;
    },
  };
  return evaluator;
}

export function documentEvaluator(doc: WhittleDocument): Evaluator {
  return createEvaluator(doc.parameters, doc.units);
}

/** Names of parameters that the given expression depends on, transitively. */
export function dependsOn(expr: string, parameters: Parameter[]): Set<string> {
  const byName = new Map(parameters.map((p) => [p.name, p]));
  const out = new Set<string>();
  const stack = referencedNames(expr);
  while (stack.length) {
    const n = stack.pop()!;
    if (out.has(n)) continue;
    out.add(n);
    const p = byName.get(n);
    if (p) stack.push(...referencedNames(p.expr));
  }
  return out;
}

/** Keys whose values are ids, enums or plain text, never expressions. */
const NOT_EXPR = new Set([
  "id", "type", "name", "mode", "anchor", "text", "sketch", "extent", "op", "target", "axis", "shape", "bodyId", "pattern",
  "style", "fileName", "format", "data", "surface", "curve", "sketches", "tools", "face", "faces", "edges", "comment",
  "profile", "path", "orientation", "section", "keep", "center", "pull", "tilt", "refs", "a", "b", "c",
  // Words, not formulas: plane kind, second pattern direction, thin-wall side, ruled-surface direction, joint type and origin, curve source.
  "kind", "axis2", "thinSide", "direction", "joint", "origin", "source",
]);

function renameIn(expr: string, from: string, to: string): string {
  if (!referencedNames(expr).includes(from)) return expr;
  // Not a function of the same name: renaming a parameter "max" leaves max(a, b) alone.
  return expr.replace(new RegExp(`(?<![A-Za-z0-9_.])${from}(?![A-Za-z0-9_]|\\s*\\()`, "g"), to);
}

/** Visits every formula field of the features (the same fields a rename touches); `set` replaces its text. */
function eachExpr(features: unknown, fn: (expr: string, set: (v: string) => void) => void): void {
  const walk = (o: unknown): void => {
    if (!o || typeof o !== "object") return;
    const rec = o as Record<string, unknown>;
    for (const k of Object.keys(rec)) {
      if (NOT_EXPR.has(k)) continue;
      // An outline point [x, y, "arc"] ends with a word, not a formula.
      if (Array.isArray(rec) && k === "2" && (rec[2] === "arc" || rec[2] === "spline")) continue;
      const v = rec[k];
      if (typeof v === "string") {
        if (k !== "plane") fn(v, (x) => (rec[k] = x));
      } else walk(v);
    }
  };
  walk(features);
}

/**
 * Rename a parameter and every reference to it (other parameters and all
 * feature fields), so renaming never breaks the design. Mutates `doc`.
 */
export function renameParameter(doc: Pick<WhittleDocument, "parameters" | "features">, from: string, to: string): void {
  for (const p of doc.parameters) {
    if (p.name === from) p.name = to;
    p.expr = renameIn(p.expr, from, to);
  }
  eachExpr(doc.features, (v, set) => set(renameIn(v, from, to)));
}

/** How many features and other parameters use parameter `name` in a formula (field names and words don't count). */
export function parameterUses(doc: Pick<WhittleDocument, "parameters" | "features">, name: string): number {
  let n = 0;
  for (const f of doc.features) {
    let hit = false;
    eachExpr(f, (v) => (hit ||= referencedNames(v).includes(name)));
    if (hit) n++;
  }
  return n + doc.parameters.filter((p) => p.name !== name && referencedNames(p.expr).includes(name)).length;
}

export { evaluateRaw };
/** Rows of a CSV file (quoted cells, doubled quotes, commas and newlines inside quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === "," || c === ";") row.push(cell), (cell = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell), rows.push(row), (row = []), (cell = "");
    } else cell += c;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  return rows.filter((r) => r.some((x) => x.trim()));
}

const KINDS = new Set<QuantityKind>(["length", "angle", "number", "count"]);

/**
 * Merge a parameter table (Whittle's own export, or any sheet with Name and Value/Formula columns) into the list:
 * names that exist get the new formula, new names are added. Returns what happened, row by row.
 */
export function mergeParameterCsv(params: Parameter[], text: string, newId: () => string): { updated: string[]; added: string[]; skipped: string[] } {
  const rows = parseCsv(text);
  const head = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
  const col = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const hasHead = col("name") >= 0;
  const [ni, fi, ki, ci] = hasHead ? [col("name"), col("formula", "expression", "value", "expr"), col("kind", "type"), col("note", "comment", "description")] : [0, 1, 2, 4];
  const out = { updated: [] as string[], added: [] as string[], skipped: [] as string[] };
  for (const r of rows.slice(hasHead ? 1 : 0)) {
    const name = (r[ni] ?? "").trim();
    const expr = (r[fi] ?? "").trim();
    const kind = (r[ki] ?? "").trim().toLowerCase() as QuantityKind;
    const comment = ci >= 0 ? (r[ci] ?? "").trim() : "";
    if (!name) continue;
    const p = params.find((x) => x.name === name);
    if (!expr || (!p && validateParamName(name, params))) {
      out.skipped.push(name);
      continue;
    }
    if (p) {
      p.expr = expr;
      if (KINDS.has(kind)) p.kind = kind;
      if (comment) p.comment = comment;
      out.updated.push(name);
    } else {
      params.push({ id: newId(), name, expr, kind: KINDS.has(kind) ? kind : "length", ...(comment ? { comment } : {}) });
      out.added.push(name);
    }
  }
  return out;
}
