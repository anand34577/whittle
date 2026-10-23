/** Counting where a parameter is used: formulas only, never field names or words. */
import { describe, expect, it } from "vitest";
import { type Feature, type Parameter, parameterUses } from "../src";

describe("parameter usage", () => {
  const parameters: Parameter[] = [
    { id: "p1", name: "depth", expr: "10", kind: "length" },
    { id: "p2", name: "width", expr: "40", kind: "length" },
    { id: "p3", name: "half", expr: "width / 2", kind: "length" },
  ];
  const features = [
    { id: "e1", type: "extrude", name: "depth", depth: "12 mm" },
    { id: "e2", type: "extrude", name: "Extrude 2", depth: "width + 1" },
  ] as unknown as Feature[];

  it("ignores a field that only shares the parameter's name", () => {
    expect(parameterUses({ parameters, features }, "depth")).toBe(0);
  });

  it("counts features and other parameters whose formulas use it", () => {
    expect(parameterUses({ parameters, features }, "width")).toBe(2);
    expect(parameterUses({ parameters, features }, "half")).toBe(0);
  });
});
