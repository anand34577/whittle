import { createRequire } from "node:module";
import { beforeAll, describe, it } from "vitest";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { type ExtrudeFeature, type FilletFeature, type SketchFeature, addChain, addConstraint, makeExtrude, makeFillet, makeSketch, newDocument, uid } from "@whittle/core";
import { Builder } from "../src/build";
import { initSolver } from "../src/solver";

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setOC(await (opencascade as any)({ locateFile: () => require.resolve("replicad-opencascadejs/wasm") }));
  await initSolver();
});

describe("probe4", () => {
  it("B solver: under / full / over / redundant / conflict", () => {
    const mk = (cons: (sk: SketchFeature, ids: string[]) => void) => {
      const doc = newDocument();
      const sk = makeSketch(doc, { kind: "origin", plane: "XY", offset: "0" }) as SketchFeature;
      sk.geometry = [];
      sk.constraints = [];
      const ids = addChain(sk, [{ p: [0, 0] }, { p: [20, 0] }, { p: [20, 10] }, { p: [0, 10] }], true);
      cons(sk, ids);
      doc.features.push(sk);
      const ex = makeExtrude(doc, sk.id) as ExtrudeFeature;
      doc.features.push(ex);
      doc.bodies[ex.id] = { name: "B", color: "#ccc", visible: true };
      const r = new Builder().regen(doc, "final");
      const s = r.sketches[0]?.solution;
      return `${s?.state} dof=${s?.dof} msg=${s?.message ?? ""} | ${r.status.map((x) => x.state).join(",")} vol=${r.bodies[0]?.volume}`;
    };
    console.log("B under:", mk(() => {}));
    console.log("B full:", mk((sk, ids) => {
      addConstraint(sk, "fixed", ["origin"].slice(0, 0).concat([sk.geometry![0]!.id]));
      addConstraint(sk, "distance", [ids[0]!], "20");
      addConstraint(sk, "distance", [ids[1]!], "10");
    }));
    console.log("B conflict:", mk((sk, ids) => {
      addConstraint(sk, "distance", [ids[0]!], "20");
      addConstraint(sk, "distance", [ids[0]!], "25");
    }));
    console.log("B redundant:", mk((sk, ids) => {
      addConstraint(sk, "distance", [ids[0]!], "20");
      addConstraint(sk, "distance", [ids[0]!], "20");
    }));
    console.log("B impossible dim:", mk((sk, ids) => {
      addConstraint(sk, "distance", [ids[0]!], "0");
    }));
  });

  it("C error propagation", () => {
    const doc = newDocument();
    const sk = makeSketch(doc, { kind: "origin", plane: "XY", offset: "0" }) as SketchFeature;
    sk.entities.push({ id: uid(), type: "rect", x: "0", y: "0", w: "width", h: "10", anchor: "center" });
    doc.parameters.push({ id: "p", name: "width", expr: "20", kind: "length" });
    const ex = makeExtrude(doc, sk.id) as ExtrudeFeature;
    doc.features.push(sk, ex);
    doc.bodies[ex.id] = { name: "B", color: "#ccc", visible: true };
    const b = new Builder();
    const body = b.regen(doc, "final").bodies[0]!;
    const f = makeFillet(doc) as FilletFeature;
    f.edges = body.edges.filter((e) => e.mid[2] > 9.9).map((e) => ({ bodyId: body.id, mid: e.mid, tangent: e.tangent, curve: e.curve, length: e.length }));
    f.radius = "2";
    doc.features.push(f);
    doc.parameters[0]!.expr = "0";
    const r = b.regen(doc, "final");
    console.log("C width=0:", r.status.map((s) => `${s.state}:${s.message ?? ""}`).join(" | "), "bodies", r.bodies.length);
    doc.parameters[0]!.expr = "oops +";
    const r2 = b.regen(doc, "final");
    console.log("C bad param:", r2.status.map((s) => `${s.state}:${s.message ?? ""}`).join(" | "));
    doc.parameters[0]!.expr = "20";
    const r3 = b.regen(doc, "final");
    console.log("C recovered:", r3.status.map((s) => s.state).join(","), "vol", r3.bodies[0]?.volume);
  });
});
