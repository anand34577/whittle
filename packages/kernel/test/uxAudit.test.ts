/** Geometry tests for the November 2026 user-experience audit (real OpenCascade in Node). */
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { type Feature, type PrimitiveFeature, type SketchEntity, type SketchFeature, type WhittleDocument, makeExtrude, makePrimitive, makeSketch, newDocument, uid } from "@whittle/core";
import { Builder } from "../src/build";

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const wasm = require.resolve("replicad-opencascadejs/wasm");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setOC(await (opencascade as any)({ locateFile: () => wasm }));
});

function push(doc: WhittleDocument, f: Feature, body = false) {
  doc.features.push(f);
  if (body) doc.bodies[f.id] = { name: f.name, color: "#ccc", visible: true };
  return f;
}

/** A plate sketch: the rectangle plus four corner circles at ±(w/2 - 8), ±(17). */
function plate(w: number, mode?: "subtract"): WhittleDocument {
  const doc = newDocument();
  const sk = makeSketch(doc, { kind: "origin", plane: "XY", offset: "0" }) as SketchFeature;
  const entities: SketchEntity[] = [{ id: uid(), type: "rect", x: "0", y: "0", w: String(w), h: "50", anchor: "center" }];
  for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) entities.push({ id: uid(), type: "circle", cx: String(sx! * (w / 2 - 8)), cy: String(sy! * 17), r: "2.75", ...(mode ? { mode } : {}) });
  sk.entities.push(...entities);
  push(doc, sk);
  push(doc, makeExtrude(doc, sk.id), true);
  return doc;
}

describe("a size change that moves holes out of their plate (audit U-1)", () => {
  it("builds cleanly while the holes are inside", () => {
    const r = new Builder().regen(plate(80, "subtract"), "final");
    expect(r.status.map((s) => s.state)).toEqual(["ok", "ok"]);
  });

  it("warns when shapes set to Hole fall outside and cut nothing", () => {
    const r = new Builder().regen(plate(5, "subtract"), "final");
    const sketch = r.status[0]!;
    expect(sketch.state).toBe("warning");
    expect(sketch.message).toMatch(/4 holes lie outside the outline/);
    expect(r.bodies[0]!.volume).toBeCloseTo(5 * 50 * 10, 0); // the plate alone: no pegs
  });

  it("notes when automatic shapes outside the outline become separate solid pieces", () => {
    const r = new Builder().regen(plate(5), "final");
    const ex = r.status[1]!;
    expect(ex.state).toBe("ok"); // a traced logo is several pieces on purpose: a note, not a warning
    expect(ex.note).toMatch(/5 separate pieces/);
  });
});

describe("a fillet far too large (audit U-13)", () => {
  it("still suggests a size that fits", () => {
    const doc = newDocument();
    const box = push(doc, makePrimitive(doc, "box"), true) as PrimitiveFeature;
    box.height = "4";
    const b = new Builder().regen(doc, "final").bodies[0]!;
    const top = b.edges.filter((e) => Math.abs(e.mid[2] - 4) < 1e-6);
    push(doc, { id: uid(), type: "fillet", name: "F", edges: top.map((e) => ({ bodyId: box.id, ...e })), radius: "50" } as Feature);
    const st = new Builder().regen(doc, "final").status[1]!;
    expect(st.state).toBe("error");
    expect(st.fix?.field).toBe("radius");
    expect(parseFloat(st.fix!.value)).toBeGreaterThan(0.5);
    expect(parseFloat(st.fix!.value)).toBeLessThan(4);
  });
});
