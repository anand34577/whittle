/**
 * Faster `faces`, `edges`, `solids` and `wires` for every shape.
 *
 * replicad lists a shape's pieces by walking it and checking each piece against all the ones seen so far, one call
 * across the WebAssembly boundary per comparison: quadratic. A body of a few thousand faces (a pattern of filleted
 * parts, an imported assembly) took tens of seconds just to be listed. Here the pieces are bucketed by hash, so each
 * one is compared only with the few that share its hash, and the walk is linear. Same results, same order.
 * Imported for its effect: it replaces the getters on `Shape` once.
 */
import { Edge, Face, Shape, Solid, Wire, HASH_CODE_MAX, downcast, getOC } from "replicad";
import type { TopoDS_Shape } from "replicad-opencascadejs";

type Kind = "edge" | "face" | "solid" | "wire";

function* pieces(shape: TopoDS_Shape, kind: Kind): Generator<TopoDS_Shape> {
  const oc = getOC();
  const type = { edge: oc.TopAbs_ShapeEnum.TopAbs_EDGE, face: oc.TopAbs_ShapeEnum.TopAbs_FACE, solid: oc.TopAbs_ShapeEnum.TopAbs_SOLID, wire: oc.TopAbs_ShapeEnum.TopAbs_WIRE }[kind];
  const explorer = new oc.TopExp_Explorer(shape, type, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  const seen = new Map<number, TopoDS_Shape[]>();
  try {
    while (explorer.More()) {
      const item = explorer.Current();
      const hash = oc.ReplicadShapeHasher.HashCode(item, HASH_CODE_MAX);
      const bucket = seen.get(hash);
      if (!bucket) {
        seen.set(hash, [item]);
        yield downcast(item) as TopoDS_Shape;
      } else if (!bucket.some((s) => s.IsSame(item))) {
        bucket.push(item);
        yield downcast(item) as TopoDS_Shape;
      }
      explorer.Next();
    }
  } finally {
    explorer.delete();
  }
}

const list = <T>(kind: Kind, wrap: (s: never) => T) =>
  function (this: { wrapped: TopoDS_Shape }): T[] {
    return Array.from(pieces(this.wrapped, kind), (s) => wrap(s as never));
  };

for (const [name, getter] of [
  ["edges", list("edge", (s) => new Edge(s))],
  ["faces", list("face", (s) => new Face(s))],
  ["solids", list("solid", (s) => new Solid(s))],
  ["wires", list("wire", (s) => new Wire(s))],
] as const) {
  Object.defineProperty(Shape.prototype, name, { get: getter, configurable: true });
}
