/** Fixes from the October 2026 code audit (docs/AUDIT.md), web side. */
import { describe, expect, it } from "vitest";
import { makeExtrude, makePrimitive, makeSketch, newDocument } from "@whittle/core";
import { deleteFeature, enterSketch, mutate, replaceDocument, setBodyOp, useApp } from "../src/state/store";
import { runDesignTool } from "../src/state/designApi";

const doc = () => useApp.getState().doc;

describe("assistant and the person's open editor (audit A-1)", () => {
  it("leaves an open sketch alone: reads work, changes wait", async () => {
    replaceDocument(newDocument("T"), null);
    const sk = makeSketch(doc(), { kind: "origin", plane: "XY", offset: "0" });
    mutate("Add sketch", (d) => void d.features.push(sk as never));
    enterSketch(sk.id, false);
    const before = useApp.getState().session;
    expect(before).toBeTruthy();
    expect((await runDesignTool("get_design", {}, { assistant: true })).error).toBeUndefined();
    const r = await runDesignTool("set_parameter", { name: "w", value: "10" }, { assistant: true });
    expect(r.error).toMatch(/finish or cancel/);
    expect(useApp.getState().session).toBe(before);
    expect(doc().parameters).toHaveLength(0);
  });

  it("undoes only its own steps", async () => {
    replaceDocument(newDocument("T"), null);
    expect((await runDesignTool("set_parameter", { name: "w", value: "10" }, { assistant: true })).error).toBeUndefined();
    mutate("Rename", (d) => void (d.name = "Mine"));
    const r = await runDesignTool("undo", {}, { assistant: true });
    expect(r.error).toMatch(/person's own/);
    expect(doc().name).toBe("Mine");
    mutate("Back", (d) => void (d.name = "T"));
  });
});

describe("body names and folders (audit W-5)", () => {
  it("keeps a body's name and colour when its step switches to Join and back", () => {
    replaceDocument(newDocument("T"), null);
    const box = makePrimitive(doc(), "box");
    mutate("Box", (d) => void d.features.push(box as never));
    const sk = makeSketch(doc(), { kind: "origin", plane: "XY", offset: "0" });
    mutate("Sketch", (d) => void d.features.push(sk as never));
    const ex = makeExtrude(doc(), sk.id, "new");
    mutate("Extrude", (d) => void d.features.push(ex as never));
    mutate("Name", (d) => void ((d.bodies[ex.id]!.name = "Lid"), (d.bodies[ex.id]!.color = "#123456")));
    setBodyOp(ex.id, "join");
    expect(doc().bodies[ex.id]).toBeUndefined();
    setBodyOp(ex.id, "new");
    expect([doc().bodies[ex.id]?.name, doc().bodies[ex.id]?.color]).toEqual(["Lid", "#123456"]);
  });
  it("takes a deleted step out of its folder", () => {
    replaceDocument(newDocument("T"), null);
    const box = makePrimitive(doc(), "box");
    mutate("Box", (d) => {
      d.features.push(box as never);
      d.folders = [{ id: "fo", name: "F", features: [box.id], open: true }] as never;
    });
    deleteFeature(box.id);
    expect(doc().folders?.[0]?.features).toEqual([]);
  });
});
