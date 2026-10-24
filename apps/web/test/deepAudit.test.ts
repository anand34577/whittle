/** Findings of the deep audit (October 2026): body metadata, sketch mode and the design API's settings. */
import { describe, expect, it } from "vitest";
import { type Feature, makePrimitive, makeSketch, newDocument } from "@whittle/core";
import { deleteFeature, enterSketch, mutate, replaceDocument, useApp } from "../src/state/store";
import { runDesignTool } from "../src/state/designApi";
import { copySteps, pasteSteps, timelinePick } from "../src/state/steps";

const doc = () => useApp.getState().doc;

describe("body metadata", () => {
  it("every step that makes a body gets a name and color, so it can be hidden and renamed", () => {
    replaceDocument(newDocument("T"), null);
    const rib = { id: "r1", type: "rib", name: "Rib 1", sketch: "s1", thickness: "2", depth: "5", flip: false, op: "new" } as Feature;
    const patch = { id: "sf1", type: "surface", name: "Patch 1", op: "patch", bodies: [], faces: [], edges: [] } as unknown as Feature;
    mutate("Add", (d) => void d.features.push(rib as never, patch as never));
    expect(doc().bodies.r1?.name).toBeTruthy();
    expect(doc().bodies.sf1?.name).toBeTruthy();
  });

  it("a join with nothing to join to makes the first body, and it gets metadata", () => {
    replaceDocument(newDocument("T"), null);
    const box = { ...makePrimitive(doc(), "box"), op: "join" } as Feature;
    mutate("Add", (d) => void d.features.push(box as never));
    expect(doc().bodies[box.id]).toBeDefined();
  });

  it("an opened file missing some body metadata is repaired", () => {
    const d = newDocument("Old");
    const box = makePrimitive(d, "box");
    d.features.push(box);
    replaceDocument(d, null);
    expect(doc().bodies[box.id]?.visible).toBe(true);
  });
});

describe("sketch mode", () => {
  it("deleting the sketch being edited leaves sketch mode", () => {
    replaceDocument(newDocument("T"), null);
    const sk = makeSketch(doc(), { kind: "origin", plane: "XY", offset: "0" });
    mutate("Add", (d) => void d.features.push(sk as never));
    enterSketch(sk.id, false);
    expect(useApp.getState().mode.kind).toBe("sketch");
    deleteFeature(sk.id);
    expect(useApp.getState().mode.kind).toBe("model");
    expect(doc().features).toHaveLength(0);
  });
});

describe("design API settings", () => {
  it("reads common words for an operation instead of building the wrong thing", async () => {
    replaceDocument(newDocument("T"), null);
    const r = await runDesignTool("add_feature", { type: "primitive", settings: { shape: "box", op: "add" } });
    expect(r.error).toBeUndefined();
    expect((doc().features[0] as { op: string }).op).toBe("join");
  });

  it("refuses an unknown word, a non-boolean switch and a non-list, saying what fits", async () => {
    replaceDocument(newDocument("T"), null);
    expect((await runDesignTool("add_feature", { type: "primitive", settings: { shape: "box", op: "weld" } })).error).toMatch(/op is one of new, join, cut, intersect/);
    expect((await runDesignTool("add_feature", { type: "move", settings: { copy: "yes" } })).error).toMatch(/copy is true or false/);
    expect((await runDesignTool("add_feature", { type: "combine", settings: { tools: "Body 1" } })).error).toMatch(/tools is a list/);
    expect(doc().features).toHaveLength(0);
  });

  it("knows every body finish", async () => {
    replaceDocument(newDocument("T"), null);
    await runDesignTool("add_feature", { type: "primitive", settings: { shape: "box" } });
    const body = Object.keys(doc().bodies)[0]!;
    expect((await runDesignTool("set_body_appearance", { body, finish: "brushed" })).error).toBeUndefined();
    expect(doc().bodies[body]!.look).toBe("brushed");
    expect((await runDesignTool("set_body_appearance", { body, finish: "chrome" })).error).toMatch(/finish is one of/);
  });
});

describe("pasting steps", () => {
  it("gives each pasted step its own name", () => {
    replaceDocument(newDocument("T"), null);
    const a = makePrimitive(doc(), "box");
    mutate("Add", (d) => void d.features.push(a as never));
    const b = makePrimitive(doc(), "box");
    mutate("Add", (d) => void d.features.push(b as never));
    timelinePick.ids = [a.id, b.id];
    copySteps();
    pasteSteps();
    timelinePick.ids = [];
    const names = doc().features.map((f) => f.name);
    expect(names).toHaveLength(4);
    expect(names).toEqual(["Box 1", "Box 2", "Box 3", "Box 4"]);
  });
});
