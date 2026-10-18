/** The Problems list and next-step suggestions follow the design's state. */
import { describe, expect, it } from "vitest";
import { makeExtrude, makeSketch, newDocument } from "@whittle/core";
import { nextSteps, problemsOf } from "../src/state/problems";

const rect = { id: "r1", type: "rect", center: ["0", "0"], width: "20", height: "10" };

describe("assistance", () => {
  it("an empty design suggests ways in and has no problems", () => {
    const doc = newDocument("T");
    expect(problemsOf({ doc, regen: null, session: null })).toEqual([]);
    expect(nextSteps({ doc, regen: null }).map((x) => x.id)).toEqual(["sketch", "box", "parts", "welcome"]);
  });

  it("an unused sketch is noted and extruding it is suggested; using it clears both", () => {
    const doc = newDocument("T");
    const sk = makeSketch(doc, { kind: "origin", plane: "XY", offset: "0" });
    (sk as { entities: unknown[] }).entities = [rect];
    doc.features.push(sk);
    expect(problemsOf({ doc, regen: null, session: null }).map((p) => p.key)).toEqual([`unused-${sk.id}`]);
    expect(nextSteps({ doc, regen: null })[0]?.id).toBe("extrude");
    doc.features.push(makeExtrude(doc, sk.id));
    expect(problemsOf({ doc, regen: null, session: null })).toEqual([]);
  });

  it("failures come first, then warnings, then notes, each with a fix", () => {
    const doc = newDocument("T");
    const sk = makeSketch(doc, { kind: "origin", plane: "XY", offset: "0" });
    const ex = makeExtrude(doc, sk.id);
    ex.suppressed = true;
    doc.features.push(sk, ex);
    doc.rollback = 1;
    const regen = { seq: 1, bodies: [], sketches: [], planes: [], status: [{ id: sk.id, state: "error" as const, message: "Broken" }] };
    const list = problemsOf({ doc, regen, session: null });
    expect(list.map((p) => p.severity)).toEqual(["error", "warning", "info"]);
    expect(list.every((p) => p.fix)).toBe(true);
  });
});
