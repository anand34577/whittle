import { type EvalContext, type EvalResult, type Quantity, evaluate, evaluateRaw, referencedNames } from "./expr";
import type { Expr, Parameter, WhittleDocument } from "./model";
import { KIND_DIM, type LengthUnit, type QuantityKind } from "./units";

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
const RESERVED = new Set(["pi", "PI", "tau", "mm", "cm", "m", "in", "ft", "deg", "rad"]);

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
]);

function renameIn(expr: string, from: string, to: string): string {
  if (!referencedNames(expr).includes(from)) return expr;
  return expr.replace(new RegExp(`(?<![A-Za-z0-9_.])${from}(?![A-Za-z0-9_])`, "g"), to);
}

/**
 * Rename a parameter and every reference to it (other parameters and all
 * feature fields), so renaming never breaks the design. Mutates `doc`.
 */
export function renameParameter(doc: Pick<WhittleDocument, "parameters" | "features">, from: string, to: string): void {
  const walk = (o: unknown): void => {
    if (!o || typeof o !== "object") return;
    const rec = o as Record<string, unknown>;
    for (const k of Object.keys(rec)) {
      if (NOT_EXPR.has(k)) continue;
      const v = rec[k];
      if (typeof v === "string") {
        if (k !== "plane") rec[k] = renameIn(v, from, to);
      } else walk(v);
    }
  };
  for (const p of doc.parameters) {
    if (p.name === from) p.name = to;
    p.expr = renameIn(p.expr, from, to);
  }
  walk(doc.features);
}

export { evaluateRaw };