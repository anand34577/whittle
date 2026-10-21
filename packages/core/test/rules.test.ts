import { describe, expect, it } from "vitest";
import { createEvaluator, featureValueIssues, type Feature } from "../src";

const ev = createEvaluator([], "mm");
const f = (o: object) => o as unknown as Feature;

describe("featureValueIssues", () => {
  it("accepts sensible values", () => {
    expect(featureValueIssues(f({ type: "fillet", radius: "2" }), ev)).toEqual([]);
    expect(featureValueIssues(f({ type: "pattern", count: "4" }), ev)).toEqual([]);
    expect(featureValueIssues(f({ type: "revolve", angle: "360" }), ev)).toEqual([]);
  });

  it("refuses values that can't make a solid, saying why", () => {
    expect(featureValueIssues(f({ type: "fillet", radius: "0" }), ev)[0]).toMatch(/Radius must be greater than zero/);
    expect(featureValueIssues(f({ type: "shell", thickness: "-1" }), ev)).toHaveLength(1);
    expect(featureValueIssues(f({ type: "pattern", count: "0" }), ev)).toHaveLength(1);
    expect(featureValueIssues(f({ type: "revolve", angle: "400" }), ev)[0]).toMatch(/360/);
    expect(featureValueIssues(f({ type: "draft", angle: "90" }), ev)).toHaveLength(1);
    expect(featureValueIssues(f({ type: "extrude", extent: "one", distance: "0" }), ev)).toHaveLength(1);
  });

  it("ignores fields a mode doesn't use and reports formula errors", () => {
    expect(featureValueIssues(f({ type: "extrude", extent: "through", distance: "0" }), ev)).toEqual([]);
    expect(featureValueIssues(f({ type: "hole", through: true, diameter: "5", depth: "0" }), ev)).toEqual([]);
    expect(featureValueIssues(f({ type: "fillet", radius: "nope" }), ev)[0]).toMatch(/^Radius:/);
  });
});
