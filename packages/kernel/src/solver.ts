/**
 * Sketch constraint solving with PlaneGCS (FreeCAD's solver, compiled to WASM;
 * LGPL-2.1, loaded as a separate file). It runs inside the kernel worker as
 * part of every rebuild, so changing a parameter re-solves the sketches that
 * use it, and the UI thread never solves.
 */
import { type GcsWrapper, type SketchPrimitive, DebugMode, SolveStatus, make_gcs_wrapper } from "@salusoft89/planegcs";
import {
  type Evaluator,
  type Id,
  type SketchConstraint,
  type SketchFeature,
  type SketchSolution,
  type Vec2,
  describeConstraint,
  geomById,
  resolveGeometry,
  splineJoin,
} from "@whittle/core";

let gcs: GcsWrapper | null = null;

/** Load the solver. `wasmUrl` is needed in browsers; Node finds the file itself. */
export async function initSolver(wasmUrl?: string): Promise<void> {
  if (gcs) return;
  gcs = await make_gcs_wrapper(wasmUrl);
  gcs.debug_mode = DebugMode.NoDebug;
}

type Prim = SketchPrimitive;

/** The fixed references every sketch has. */
const REFS: Prim[] = [
  { id: "origin", type: "point", x: 0, y: 0, fixed: true },
  { id: "xaxis.b", type: "point", x: 1, y: 0, fixed: true },
  { id: "yaxis.b", type: "point", x: 0, y: 1, fixed: true },
  { id: "xaxis", type: "line", p1_id: "origin", p2_id: "xaxis.b" },
  { id: "yaxis", type: "line", p1_id: "origin", p2_id: "yaxis.b" },
];

/** PlaneGCS primitives for the sketch's constraints. Throws a readable error for a bad dimension. */
function constraintPrims(sk: SketchFeature, ev: Evaluator, radius: (id: Id) => number, pos: (id: Id) => Vec2): { prims: Prim[]; fixed: Set<Id> } {
  const prims: Prim[] = [];
  const fixed = new Set<Id>();
  const kind = (id: Id) => (id === "origin" ? "point" : id === "xaxis" || id === "yaxis" ? "line" : geomById(sk, id)?.type);
  const joined = (p: Id, q: Id) =>
    p === q || !!sk.constraints?.some((c) => c.type === "coincident" && c.refs.includes(p) && c.refs.includes(q));
  /** An end point two curves share (tangency there is solved as an angle, which converges far better). */
  const sharedEnd = (u: Id, v: Id): Id | undefined => {
    const ends = (id: Id) => {
      const g = geomById(sk, id);
      return g?.type === "line" || g?.type === "arc" ? [g.a, g.b] : [];
    };
    return ends(u).find((p) => ends(v).some((q) => joined(p, q)));
  };
  /** Direction of travel along a curve at a point: lines run a to b, arcs counter-clockwise. */
  const direction = (id: Id, at: Vec2): Vec2 => {
    const g = geomById(sk, id)!;
    if (g.type === "line") {
      const [a, b] = [pos(g.a), pos(g.b)];
      return [b[0] - a[0], b[1] - a[1]];
    }
    const c = pos((g as { c: Id }).c);
    return [c[1] - at[1], at[0] - c[0]];
  };
  const val = (c: SketchConstraint, k: "length" | "angle") => {
    try {
      return ev.num(c.value ?? "", k);
    } catch (e) {
      throw new Error(`${describeConstraint(c)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  for (const c of sk.constraints ?? []) {
    const [r0, r1] = c.refs as [Id, Id];
    const k0 = kind(r0);
    const k1 = r1 === undefined ? undefined : kind(r1);
    if (!k0 || (r1 !== undefined && !k1)) continue;
    // Order a pair so the point (or line) comes first.
    const [p, q, kp, kq] = k1 && k1 === "point" && k0 !== "point" ? [r1, r0, k1, k0] : k1 === "line" && k0 !== "line" && k0 !== "point" ? [r1, r0, k1, k0] : [r0, r1, k0, k1];
    const id = c.id;
    const add = (o: Record<string, unknown>) => prims.push({ id: prims.some((x) => x.id === id) ? `${id}#${prims.length}` : id, ...o } as Prim);
    switch (c.type) {
      case "coincident":
        if (kq === "point") add({ type: "p2p_coincident", p1_id: p, p2_id: q });
        else if (kq === "line") add({ type: "point_on_line_pl", p_id: p, l_id: q });
        else if (kq === "circle") add({ type: "point_on_circle", p_id: p, c_id: q });
        else if (kq === "arc") add({ type: "point_on_arc", p_id: p, a_id: q });
        break;
      case "horizontal":
      case "vertical":
        if (kp === "line") add({ type: `${c.type}_l`, l_id: p });
        else add({ type: `${c.type}_pp`, p1_id: p, p2_id: q });
        break;
      case "parallel":
        add({ type: "parallel", l1_id: p, l2_id: q });
        break;
      case "perpendicular":
        add({ type: "perpendicular_ll", l1_id: p, l2_id: q });
        break;
      case "tangent": {
        if (kp === "spline" || kq === "spline") {
          // The spline's next fit point lies on the other curve's tangent line at the join.
          const [sp, ot] = kp === "spline" ? [p, q!] : [q!, p];
          const j = splineJoin(sk, sp, ot);
          const o = geomById(sk, ot);
          if (j && o?.type === "line") add({ type: "point_on_line_pl", p_id: j.next, l_id: ot });
          else if (j && o?.type === "arc") add({ type: "perpendicular_pppp", l1p1_id: j.end, l1p2_id: j.next, l2p1_id: o.c, l2p2_id: j.end });
          break;
        }
        const end = sharedEnd(p, q);
        if (end) {
          // Tangent where they meet: the curves leave the point in the same (or opposite) direction.
          const at = pos(end);
          const [u, v] = [direction(p, at), direction(q, at)];
          const same = u[0] * v[0] + u[1] * v[1] >= 0;
          add({ type: "angle_via_point", crv1_id: p, crv2_id: q, p_id: end, angle: same ? 0 : Math.PI });
        } else if (kp === "line") add({ type: kq === "circle" ? "tangent_lc" : "tangent_la", l_id: p, [kq === "circle" ? "c_id" : "a_id"]: q });
        else if (kp === "circle" && kq === "circle") add({ type: "tangent_cc", c1_id: p, c2_id: q });
        else if (kp === "arc" && kq === "arc") add({ type: "tangent_aa", a1_id: p, a2_id: q });
        else add({ type: "tangent_ca", c_id: kp === "circle" ? p : q, a_id: kp === "circle" ? q : p });
        break;
      }
      case "equal":
        if (kp === "line") add({ type: "equal_length", l1_id: p, l2_id: q });
        else if (kp === "circle" && kq === "circle") add({ type: "equal_radius_cc", c1_id: p, c2_id: q });
        else if (kp === "arc" && kq === "arc") add({ type: "equal_radius_aa", a1_id: p, a2_id: q });
        else add({ type: "equal_radius_ca", c1_id: kp === "circle" ? p : q, a2_id: kp === "circle" ? q : p });
        break;
      case "symmetric": {
        // The two points come first; the mirror is the line, or else the last point.
        const m = c.refs.find((r) => kind(r) === "line") ?? c.refs[2]!;
        const [s1, s2] = c.refs.filter((r) => r !== m) as [Id, Id];
        add(kind(m) === "line" ? { type: "p2p_symmetric_ppl", p1_id: s1, p2_id: s2, l_id: m } : { type: "p2p_symmetric_ppp", p1_id: s1, p2_id: s2, p_id: m });
        break;
      }
      case "midpoint": {
        // The line's ends mirror about the point. The axes have no middle: just on the line.
        const g = geomById(sk, q);
        if (g?.type === "line") add({ type: "p2p_symmetric_ppp", p1_id: g.a, p2_id: g.b, p_id: p });
        else add({ type: "point_on_line_pl", p_id: p, l_id: q });
        break;
      }
      case "collinear": {
        // Both ends of the second line on the first.
        const g = geomById(sk, q);
        const ends = g?.type === "line" ? [g.a, g.b] : ["origin", `${q}.b`];
        for (const e of ends) add({ type: "point_on_line_pl", p_id: e, l_id: p });
        break;
      }
      case "fixed": {
        const g = geomById(sk, p);
        if (g?.type === "point") fixed.add(g.id);
        if (g?.type === "line") fixed.add(g.a).add(g.b);
        if (g?.type === "arc") fixed.add(g.a).add(g.b).add(g.c);
        if (g?.type === "circle") {
          fixed.add(g.c);
          add({ type: "circle_radius", c_id: g.id, radius: radius(g.id) });
        }
        break;
      }
      case "distance": {
        const d = val(c, "length");
        if (d < 0) throw new Error(`${describeConstraint(c)}: a distance can't be negative`);
        if (d === 0) throw new Error(`${describeConstraint(c)}: a distance of zero is not possible. Use a Coincident constraint instead.`);
        if (q === undefined) {
          const g = geomById(sk, p);
          if (g?.type === "line") add({ type: "p2p_distance", p1_id: g.a, p2_id: g.b, distance: d });
        } else if (kq === "point") add({ type: "p2p_distance", p1_id: p, p2_id: q, distance: d });
        else if (kp === "point") add({ type: "p2l_distance", p_id: p, l_id: q, distance: d });
        else {
          // Between two (parallel) lines: from one line's start to the other line.
          const g = geomById(sk, p);
          const start = p === "xaxis" || p === "yaxis" ? "origin" : g?.type === "line" ? g.a : p;
          add({ type: "p2l_distance", p_id: start, l_id: q, distance: d });
        }
        break;
      }
      case "radius": {
        const r = val(c, "length");
        if (r <= 0) throw new Error(`${describeConstraint(c)}: a radius must be greater than zero`);
        add(kp === "circle" ? { type: "circle_radius", c_id: p, radius: r } : { type: "arc_radius", a_id: p, radius: r });
        break;
      }
      case "angle": {
        const a = val(c, "angle");
        if (q === undefined) {
          const g = geomById(sk, p);
          if (g?.type === "line") add({ type: "p2p_angle", p1_id: g.a, p2_id: g.b, angle: a });
        } else add({ type: "l2l_angle_ll", l1_id: r0, l2_id: r1, angle: a });
        break;
      }
    }
  }
  return { prims, fixed };
}

function geometryPrims(sk: SketchFeature, pos: (id: Id) => Vec2, radius: (id: Id) => number, fixed: Set<Id>): Prim[] {
  const points: Prim[] = [];
  const curves: Prim[] = [];
  for (const g of sk.geometry ?? []) {
    if (g.type === "point") {
      const [x, y] = pos(g.id);
      points.push({ id: g.id, type: "point", x, y, fixed: fixed.has(g.id) });
    } else if (g.type === "spline") {
      continue; // fit points are solver points; the curve is drawn through them
    } else if (g.type === "line") curves.push({ id: g.id, type: "line", p1_id: g.a, p2_id: g.b });
    else if (g.type === "circle") curves.push({ id: g.id, type: "circle", c_id: g.c, radius: radius(g.id) });
    else {
      const c = pos(g.c);
      const a = pos(g.a);
      const b = pos(g.b);
      const a0 = Math.atan2(a[1] - c[1], a[0] - c[0]);
      let a1 = Math.atan2(b[1] - c[1], b[0] - c[0]);
      while (a1 <= a0) a1 += Math.PI * 2;
      curves.push({ id: g.id, type: "arc", c_id: g.c, start_id: g.a, end_id: g.b, radius: Math.hypot(a[0] - c[0], a[1] - c[1]), start_angle: a0, end_angle: a1 });
      curves.push({ id: `${g.id}#rules`, type: "arc_rules", a_id: g.id });
    }
  }
  return [...REFS, ...points, ...curves];
}

interface Run {
  status: number;
  dof: number;
  conflicting: string[];
  redundant: string[];
}

function run(prims: Prim[]): Run {
  const s = gcs!;
  s.clear_data();
  s.push_primitives_and_params(prims);
  const status = s.solve();
  return { status, dof: s.gcs.dof(), conflicting: s.get_gcs_conflicting_constraints(), redundant: s.get_gcs_redundant_constraints() };
}

// ponytail: finding which geometry is fully defined costs one extra solve per point; past this many points only the whole sketch is coloured.
const PROBE_LIMIT = 80;

/** Solve a sketch's constraint-driven geometry. Undefined when it has none. */
export function solveSketch(sk: SketchFeature, ev: Evaluator): SketchSolution | undefined {
  if (!sk.geometry?.length) return undefined;
  if (!gcs) throw new Error("The sketch solver is still loading. Try again in a moment.");
  const stored = resolveGeometry(sk);
  const start = new Map<Id, Vec2>();
  const radii: Record<Id, number> = {};
  for (const g of sk.geometry) if (g.type === "point") start.set(g.id, [g.x, g.y]);
  for (const g of stored) if (g.type === "circle") radii[g.id] = g.r;

  const { prims: cons, fixed } = constraintPrims(sk, ev, (id) => radii[id] ?? 1, (id) => start.get(id) ?? [0, 0]);
  const geo = (pos: (id: Id) => Vec2, extra: Set<Id> = new Set()) =>
    geometryPrims(sk, pos, (id) => radii[id] ?? 1, new Set([...fixed, ...extra]));
  const base = run([...geo((id) => start.get(id) ?? [0, 0]), ...cons]);

  const toUser = (ids: string[]) => [...new Set(ids.map((x) => x.split("#")[0]!))].filter((x) => sk.constraints?.some((c) => c.id === x));
  const conflicting = toUser(base.conflicting);
  const redundant = toUser(base.redundant);
  const solved = (base.status === SolveStatus.Success || base.status === SolveStatus.Converged) && !base.conflicting.length;

  const points: Record<Id, Vec2> = {};
  if (solved) {
    gcs.apply_solution();
    for (const p of gcs.sketch_index.get_primitives()) {
      if (p.type === "point" && start.has(p.id)) points[p.id] = [p.x, p.y];
      if (p.type === "circle") radii[p.id] = p.radius;
    }
  } else for (const [id, p] of start) points[id] = p;

  const sol: SketchSolution = { points, radii, dof: base.dof, state: "under", defined: [], bad: [] };
  const names = (ids: string[]) => {
    const list = ids.map((id) => describeConstraint(sk.constraints!.find((c) => c.id === id)!));
    return list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}` : (list[0] ?? "");
  };
  if (conflicting.length) {
    sol.state = "over";
    sol.bad = conflicting;
    sol.message = `Over-constrained: ${names(conflicting)} can't all be true. Delete one of the red constraints.`;
    return sol;
  }
  if (!solved) {
    sol.state = "error";
    sol.message = "The sketch can't meet all its dimensions (a size may be too large or too small for the rest). Check the values.";
    return sol;
  }
  if (redundant.length) {
    sol.state = "over";
    sol.bad = redundant;
    sol.message = `${names(redundant)} ${redundant.length > 1 ? "are" : "is"} already implied by the other constraints. Delete ${redundant.length > 1 ? "them" : "it"} (shown in red).`;
  } else sol.state = base.dof === 0 ? "full" : "under";

  // Which geometry is fully defined: fixing a point that can still move lowers the freedom.
  const at = (id: Id) => points[id] ?? start.get(id) ?? [0, 0];
  const pointIds = sk.geometry.filter((g) => g.type === "point").map((g) => g.id);
  const free = new Set<Id>();
  if (base.dof > 0 && pointIds.length <= PROBE_LIMIT) {
    for (const id of pointIds) {
      if (fixed.has(id)) continue;
      if (run([...geo(at, new Set([id])), ...cons]).dof < base.dof) free.add(id);
    }
    for (const g of sk.geometry) {
      if (g.type !== "circle") continue;
      const probe = run([...geo(at), ...cons, { id: "probe", type: "circle_radius", c_id: g.id, radius: radii[g.id]! } as Prim]);
      if (probe.dof < base.dof) free.add(g.id);
    }
  } else if (base.dof > 0) pointIds.forEach((id) => !fixed.has(id) && free.add(id));
  for (const g of sk.geometry) {
    const needs = g.type === "point" ? [g.id] : g.type === "line" ? [g.a, g.b] : g.type === "arc" ? [g.a, g.b, g.c] : g.type === "spline" ? g.pts : [g.c, g.id];
    if (needs.every((x) => !free.has(x))) sol.defined.push(g.id);
  }
  return sol;
}
