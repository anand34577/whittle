/** Parameter tables in and out: Whittle's own CSV export and plain spreadsheets. */
import { describe, expect, it } from "vitest";
import { type Parameter, mergeParameterCsv, parseCsv } from "../src";

describe("parameter CSV import", () => {
  it("parses quotes, doubled quotes and both line endings", () => {
    expect(parseCsv('a,"b, c","say ""hi"""\r\nd,e\n')).toEqual([["a", "b, c", 'say "hi"'], ["d", "e"]]);
  });

  it("updates existing parameters by name, adds new ones and skips bad rows", () => {
    const params: Parameter[] = [{ id: "p1", name: "width", expr: "40", kind: "length" }];
    let n = 0;
    const csv = "Name,Formula,Kind,Value,Note\nwidth,60,length,60 mm,outer\nangle,30,angle,30°,\n2bad,5,length,,\nempty,,length,,";
    const r = mergeParameterCsv(params, csv, () => `n${++n}`);
    expect(r).toEqual({ updated: ["width"], added: ["angle"], skipped: ["2bad", "empty"] });
    expect(params).toEqual([
      { id: "p1", name: "width", expr: "60", kind: "length", comment: "outer" },
      { id: "n1", name: "angle", expr: "30", kind: "angle" },
    ]);
  });

  it("reads a sheet with just Name and Value columns", () => {
    const params: Parameter[] = [];
    mergeParameterCsv(params, "name;value\nwall;2.5", () => "x");
    expect(params[0]).toMatchObject({ name: "wall", expr: "2.5", kind: "length" });
  });
});
