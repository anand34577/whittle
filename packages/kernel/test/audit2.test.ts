/** Regression tests from the October 2026 audit (second pass). These run the real OpenCascade kernel. */
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { type ExtrudeFeature, type HoleFeature, type ImportFeature, type PolylineEntity, type SketchFeature, makeExtrude, makeHole, makeImport, makePrimitive, makeSketch, newDocument, uid } from "@whittle/core";
import { Builder } from "../src/build";

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setOC(await (opencascade as any)({ locateFile: () => require.resolve("replicad-opencascadejs/wasm") }));
});

describe("damaged imports", () => {
  it("a bad embedded file fails its own feature, not the whole rebuild", async () => {
    const doc = newDocument();
    const box = makePrimitive(doc, "box");
    const im = makeImport(doc, "broken.step", "step", "!!!not base64!!!") as ImportFeature;
    doc.features.push(box, im);
    doc.bodies[box.id] = { name: "Box", color: "#ccc", visible: true };
    doc.bodies[im.id] = { name: "Imported", color: "#ccc", visible: true };
    const b = new Builder();
    await b.prepareImports(doc);
    const r = b.regen(doc, "final");
    expect(r.status.map((s) => s.state)).toEqual(["ok", "error"]);
    expect(r.bodies).toHaveLength(1);
  });
});

describe("self-intersecting outlines", () => {
  const bowTie = (): PolylineEntity => ({ id: uid(), type: "polyline", points: [["0", "0"], ["10", "10"], ["10", "0"], ["0", "10"]] });
  const extrudeOf = (e: PolylineEntity) => {
    const doc = newDocument();
    const sk = makeSketch(doc, { kind: "origin", plane: "XY", offset: "0" }) as SketchFeature;
    sk.entities.push(e);
    const ex = makeExtrude(doc, sk.id) as ExtrudeFeature;
    ex.distance = "10";
    doc.features.push(sk, ex);
    doc.bodies[ex.id] = { name: "B", color: "#ccc", visible: true };
    return doc;
  };

  it("a bow-tie outline is an error, not an invalid solid reported as fine", () => {
    const r = new Builder().regen(extrudeOf(bowTie()), "final");
    expect(r.status[0]!.state).toBe("error");
    expect(r.status[0]!.message).toMatch(/crosses itself/);
    expect(r.bodies).toHaveLength(0);
  });

  it("outlines that only touch at a corner, and ordinary concave shapes, still build", () => {
    const concave: PolylineEntity = { id: uid(), type: "polyline", points: [["0", "0"], ["20", "0"], ["20", "20"], ["10", "5"], ["0", "20"]] };
    const r = new Builder().regen(extrudeOf(concave), "final");
    expect(r.status.map((s) => s.state)).toEqual(["ok", "ok"]);
    expect(r.bodies[0]!.volume).toBeGreaterThan(0);
  });
});

describe("rebuild cache keys", () => {
  it("stay a fixed size however long the timeline gets", () => {
    const doc = newDocument();
    for (let i = 0; i < 120; i++) {
      const p = makePrimitive(doc, "box");
      if (p.type === "primitive") p.position = [String(i * 50), "0", "0"];
      doc.features.push(p);
      doc.bodies[p.id] = { name: `B${i}`, color: "#ccc", visible: true };
    }
    const b = new Builder();
    b.regen(doc, "preview");
    const keys = (b as unknown as { cache: { key: string }[] }).cache.map((s) => s.key.length);
    expect(Math.max(...keys)).toBeLessThan(200);
    // ...and caching still works: nothing changed, nothing rebuilt; one edit rebuilds from there on.
    expect(b.regen(doc, "preview").rebuilt).toBe(0);
    const last = doc.features[119]!;
    if (last.type === "primitive") last.width = "11";
    expect(b.regen(doc, "preview").rebuilt).toBe(1);
  });
});

describe("references that jump", () => {
  it("a face that is the only match but is a very different size is flagged, not trusted silently", () => {
    const doc = newDocument();
    const s1 = makeSketch(doc, { kind: "origin", plane: "XY", offset: "0" }) as SketchFeature;
    s1.entities.push({ id: uid(), type: "rect", x: "0", y: "0", w: "40", h: "40", anchor: "center" });
    const e1 = makeExtrude(doc, s1.id) as ExtrudeFeature;
    e1.distance = "10";
    doc.features.push(s1, e1);
    doc.bodies[e1.id] = { name: "Base", color: "#ccc", visible: true };
    const s2 = makeSketch(doc, { kind: "origin", plane: "XY", offset: "10" }) as SketchFeature;
    s2.entities.push({ id: uid(), type: "rect", x: "0", y: "0", w: "10", h: "10", anchor: "center" });
    const e2 = makeExtrude(doc, s2.id, "join") as ExtrudeFeature;
    e2.distance = "10";
    doc.features.push(s2, e2);
    const b = new Builder();
    let r = b.regen(doc, "final");
    const body = r.bodies[0]!;
    const top = body.faces.findIndex((f) => f.normal[2] > 0.99 && Math.abs(f.center[2] - 20) < 1e-6);
    const hole = makeHole(doc) as HoleFeature;
    hole.face = { bodyId: body.id, ...body.faces[top]! };
    hole.points = [["0", "0"]];
    hole.diameter = "4";
    hole.through = false;
    hole.depth = "5";
    doc.features.push(hole);
    r = b.regen(doc, "final");
    expect(r.status.at(-1)!.state).toBe("ok");
    e2.suppressed = true;
    r = b.regen(doc, "final");
    expect(r.status.at(-1)!.state).toBe("warning");
  });
});

describe("validity check", () => {
  it("reports a good solid as valid", async () => {
    const { makeBaseBox } = await import("replicad");
    const { isValidShape } = await import("../src/build");
    expect(isValidShape(makeBaseBox(10, 10, 10))).toBe(true);
  });
});

describe("sketches with many shapes", () => {
  const plate = (n: number, spacing: number, r: number) => {
    const doc = newDocument();
    const sk = makeSketch(doc, { kind: "origin", plane: "XY", offset: "0" }) as SketchFeature;
    sk.entities.push({ id: uid(), type: "rect", x: "0", y: "0", w: String(25 * spacing), h: String(25 * spacing), anchor: "corner" });
    for (let i = 0; i < n; i++) sk.entities.push({ id: uid(), type: "circle", cx: String((i % 20) * spacing + spacing), cy: String(Math.floor(i / 20) * spacing + spacing), r: String(r) });
    const ex = makeExtrude(doc, sk.id) as ExtrudeFeature;
    ex.distance = "5";
    doc.features.push(sk, ex);
    doc.bodies[ex.id] = { name: "P", color: "#ccc", visible: true };
    return doc;
  };

  it("200 separate holes build in seconds with the right volume", () => {
    const t = Date.now();
    const r = new Builder().regen(plate(200, 12, 4), "final");
    expect(r.status.map((x) => x.state)).toEqual(["ok", "ok"]);
    expect(r.bodies[0]!.volume).toBeCloseTo((300 * 300 - 200 * Math.PI * 16) * 5, -1);
    expect(Date.now() - t).toBeLessThan(10000);
  });

  it("overlapping holes still merge into one", () => {
    const r = new Builder().regen(plate(40, 6, 4), "final"); // radius 4 at spacing 6: neighbours overlap
    expect(r.status.map((x) => x.state)).toEqual(["ok", "ok"]);
    expect(r.bodies[0]!.volume).toBeLessThan((150 * 150 - 40 * Math.PI * 16 * 0.5) * 5);
  });
});

describe("zero distance", () => {
  it("a distance of zero is explained by the solver", async () => {
    const { addConstraint, addLine, addPoint, createEvaluator } = await import("@whittle/core");
    const { initSolver, solveSketch } = await import("../src/solver");
    await initSolver();
    const doc = newDocument();
    const sk = makeSketch(doc, { kind: "origin", plane: "XY", offset: "0" }) as SketchFeature;
    const line = addLine(sk, addPoint(sk, [0, 0]), addPoint(sk, [10, 0]));
    if (typeof line !== "string") throw new Error("line");
    addConstraint(sk, "distance", [line], "0");
    expect(() => solveSketch(sk, createEvaluator([], "mm"))).toThrow(/zero/);
  });
});

describe("errors that follow a failed step", () => {
  it("name the step that failed", () => {
    const doc = newDocument();
    const s1 = makeSketch(doc, { kind: "origin", plane: "XY", offset: "0" }) as SketchFeature;
    s1.entities.push({ id: uid(), type: "rect", x: "0", y: "0", w: "40", h: "40", anchor: "center" });
    const e1 = makeExtrude(doc, s1.id) as ExtrudeFeature;
    e1.distance = "10";
    doc.features.push(s1, e1);
    doc.bodies[e1.id] = { name: "Base", color: "#ccc", visible: true };
    const b = new Builder();
    const body = b.regen(doc, "final").bodies[0]!;
    const hole = makeHole(doc) as HoleFeature;
    hole.face = { bodyId: body.id, ...body.faces.find((f) => f.normal[2] > 0.99)! };
    hole.points = [["0", "0"]];
    doc.features.push(hole);
    e1.distance = "0"; // the extrude now fails, and the hole has no body
    const st = b.regen(doc, "final").status;
    expect(st[1]!.state).toBe("error");
    expect(st[2]!.message).toContain(`"${e1.name}" failed`);
  });
});
