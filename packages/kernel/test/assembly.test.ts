import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { type ConstructFeature, type Feature, type JointFeature, type PrimitiveFeature, type WhittleDocument, makeConstruct, makeJoint, makePrimitive, newDocument } from "@whittle/core";
import { Builder } from "../src/build";

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const wasm = require.resolve("replicad-opencascadejs/wasm");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setOC(await (opencascade as any)({ locateFile: () => wasm }));
});

function push<T extends Feature>(doc: WhittleDocument, f: T, body = false): T {
  doc.features.push(f);
  if (body) doc.bodies[f.id] = { name: f.name, color: "#ccc", visible: true };
  return f;
}
const box = (doc: WhittleDocument, at: [string, string, string] = ["0", "0", "0"]) => {
  const b = makePrimitive(doc, "box") as PrimitiveFeature;
  b.width = b.depth = b.height = "10";
  b.position = at;
  return push(doc, b, true);
};
const regen = (doc: WhittleDocument) => new Builder().regen(doc, "final");
const status = (r: ReturnType<typeof regen>, id: string) => r.status.find((s) => s.id === id)!;
const body = (r: ReturnType<typeof regen>, id: string) => r.bodies.find((b) => b.id === id)!;

function joint(doc: WhittleDocument, moving: string, kind: JointFeature["joint"], set: Partial<JointFeature> = {}) {
  const j = makeJoint(doc, moving) as JointFeature;
  j.joint = kind;
  Object.assign(j, set);
  return push(doc, j);
}

describe("more joints", () => {
  it("planar joint slides in the plane perpendicular to its axis", () => {
    const doc = newDocument();
    const a = box(doc);
    const j = joint(doc, a.id, "planar", { axis: "z", distance: "7", distance2: "3", angle: "0" });
    const r = regen(doc);
    expect(status(r, j.id).state, status(r, j.id).message).toBe("ok");
    const bb = body(r, a.id).bbox;
    // Only X and Y change: the third direction (Z) is the axis.
    expect(bb[0][2]).toBeCloseTo(0, 3);
    expect(Math.abs(bb[0][0] + 5)).toBeGreaterThan(1);
    expect(bb[0][0] + 5).not.toBeCloseTo(0, 3);
  });

  it("ball joint turns about the pivot in three directions", () => {
    const doc = newDocument();
    const a = box(doc, ["20", "0", "0"]);
    const j = joint(doc, a.id, "ball", { origin: "point", point: ["0", "0", "0"], angle: "90", angle2: "0", angle3: "0", axis: "x" });
    const r = regen(doc);
    expect(status(r, j.id).state, status(r, j.id).message).toBe("ok");
    expect(body(r, a.id).bbox[0][0]).toBeCloseTo(15, 3);
  });

  it("pin-slot turns about the pin and slides along the slot", () => {
    const doc = newDocument();
    const a = box(doc);
    const before = regen(doc).bodies[0]!.bbox[0][0];
    const j = joint(doc, a.id, "pinslot", { axis: "z", angle: "0", distance: "12" });
    const r = regen(doc);
    expect(status(r, j.id).state).toBe("ok");
    expect(Math.abs(body(r, a.id).bbox[0][0] - before)).toBeCloseTo(12, 3);
  });

  it("a joint about a construction axis uses that axis as the pivot line", () => {
    const doc = newDocument();
    const a = box(doc, ["10", "0", "0"]);
    const ax = push(doc, makeConstruct(doc, "axis2p") as ConstructFeature);
    ax.points.push([0, 0, 0], [0, 0, 1]);
    const j = joint(doc, a.id, "revolute", { axisRef: ax.id, angle: "180" });
    const r = regen(doc);
    expect(status(r, j.id).state, status(r, j.id).message).toBe("ok");
    // Half a turn about the Z axis at the origin flips the box from x = 5..15 to x = -15..-5.
    expect(body(r, a.id).bbox[1][0]).toBeCloseTo(-5, 3);
  });
});

describe("motion links, components and ground", () => {
  it("a linked joint follows its source value times the ratio", () => {
    const doc = newDocument();
    const a = box(doc);
    const b = box(doc, ["30", "0", "0"]);
    const j1 = joint(doc, a.id, "slider", { axis: "x", distance: "4" });
    const j2 = joint(doc, b.id, "slider", { axis: "x", distance: "0", link: { joint: j1.id, ratio: "-2" } });
    const r = regen(doc);
    expect(status(r, j2.id).state, status(r, j2.id).message).toBe("ok");
    expect(body(r, b.id).bbox[0][0]).toBeCloseTo(25 - 8, 3);
  });

  it("moves every body of a component together, but never a grounded one", () => {
    const doc = newDocument();
    const a = box(doc);
    const b = box(doc, ["0", "30", "0"]);
    const c = box(doc, ["0", "60", "0"]);
    doc.bodies[a.id]!.component = "arm";
    doc.bodies[b.id]!.component = "arm";
    doc.bodies[c.id]!.grounded = true;
    const j = joint(doc, a.id, "slider", { axis: "x", distance: "9" });
    let r = regen(doc);
    expect(status(r, j.id).state).toBe("ok");
    expect(body(r, a.id).bbox[0][0]).toBeCloseTo(-5 + 9, 3);
    expect(body(r, b.id).bbox[0][0]).toBeCloseTo(-5 + 9, 3);
    const g = joint(doc, c.id, "slider", { axis: "x", distance: "9" });
    r = regen(doc);
    expect(status(r, g.id).state).toBe("warning");
    expect(body(r, c.id).bbox[0][0]).toBeCloseTo(-5, 3);
  });
});

describe("inspect", () => {
  it("finds overlapping bodies and their shared volume", async () => {
    const { interference } = await import("../src/inspect");
    const doc = newDocument();
    const a = box(doc);
    const b = box(doc, ["5", "0", "0"]);
    const c = box(doc, ["40", "0", "0"]);
    const found = interference(new Builder().shapes(doc));
    expect(found).toHaveLength(1);
    expect([found[0]!.a, found[0]!.b].sort()).toEqual([a.id, b.id].sort());
    expect(found[0]!.volume).toBeCloseTo(500, 0);
    expect(c.id).toBeTruthy();
  });

  it("measures round faces and tells pockets from bosses", async () => {
    const { radii } = await import("../src/inspect");
    const doc = newDocument();
    const slab = box(doc);
    const hole = makePrimitive(doc, "cylinder") as PrimitiveFeature;
    hole.radius = "2";
    hole.height = "10";
    hole.op = "cut";
    hole.target = slab.id;
    push(doc, hole);
    const found = radii(new Builder().shapes(doc));
    expect(found).toHaveLength(1);
    expect(found[0]!.radius).toBeCloseTo(2, 3);
    expect(found[0]!.concave).toBe(true);
    const doc2 = newDocument();
    const rod = makePrimitive(doc2, "cylinder") as PrimitiveFeature;
    rod.radius = "3";
    push(doc2, rod, true);
    const rods = radii(new Builder().shapes(doc2));
    expect(rods[0]!.concave).toBe(false);
  });
});
