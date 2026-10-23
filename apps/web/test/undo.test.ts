/** Undo and redo of design edits (the store and the design API), from the October 2026 audit. */
import { describe, expect, it } from "vitest";
import { makeExtrude, makePrimitive, makeSketch, newDocument } from "@whittle/core";
import { beginNewFeature, cancelSession, commitSession, deleteFeature, editFeature, history, moveFeature, mutate, redo, replaceDocument, undo, updateFeature, useApp } from "../src/state/store";
import { runDesignTool } from "../src/state/designApi";

const doc = () => useApp.getState().doc;

describe("undo and redo", () => {
  it("every design API tool can be undone and redone exactly", async () => {
    replaceDocument(newDocument("T"), null);
    const steps: [string, Record<string, unknown>][] = [
      ["set_parameter", { name: "w", value: 20 }],
      ["add_sketch", { shapes: [{ type: "rect", width: "w", height: 10 }] }],
      ["add_feature", { type: "extrude", settings: { sketch: "Sketch 1", distance: 5 } }],
      ["add_feature", { type: "primitive", settings: { shape: "cylinder", radius: 4, height: 8, op: "join" } }],
      ["update_feature", { feature: "Extrude 1", settings: { distance: 7 } }],
      ["set_body_appearance", { body: "Body 1", color: "#112233", name: "Plate" }],
      ["update_feature", { feature: "Cylinder 1", suppressed: true }],
      ["delete_feature", { feature: "Cylinder 1" }],
    ];
    const snaps = [doc()];
    for (const [name, input] of steps) {
      const r = await runDesignTool(name, input);
      expect(r.error, `${name}: ${JSON.stringify(r)}`).toBeUndefined();
      snaps.push(doc());
    }
    for (let i = steps.length - 1; i >= 0; i--) {
      undo();
      expect(doc(), `undo of ${steps[i]![0]}`).toEqual(snaps[i]);
    }
    expect(history.canUndo).toBe(false);
    for (let i = 0; i < steps.length; i++) {
      redo();
      expect(doc(), `redo of ${steps[i]![0]}`).toEqual(snaps[i + 1]);
    }
  });

  it("a feature dialog is one undo step; cancelling leaves nothing behind", () => {
    replaceDocument(newDocument("T"), null);
    const sk = makeSketch(doc(), { kind: "origin", plane: "XY", offset: "0" });
    beginNewFeature(sk, "New Sketch");
    mutate("Add shape", (x) => void (x.features[0] as unknown as { entities: unknown[] }).entities.push({ id: "e1", type: "circle", cx: "0", cy: "0", r: "5" }));
    commitSession();
    expect(doc().features.length).toBe(1);
    expect(history.undoLabel).toBe("New Sketch");
    undo();
    expect(doc().features.length).toBe(0);
    redo();
    expect(doc().features.length).toBe(1);

    beginNewFeature(makeExtrude(doc(), sk.id), "New Extrude");
    cancelSession();
    expect(doc().features.length).toBe(1);
  });

  it("reordering and deleting steps undo, and bodies come back with their features", () => {
    replaceDocument(newDocument("T"), null);
    const a = makePrimitive(doc(), "box");
    const b = makePrimitive(doc(), "cylinder");
    beginNewFeature(a, "a");
    commitSession();
    beginNewFeature(b, "b");
    commitSession();
    const order = () => doc().features.map((f) => f.id);
    const o0 = order();
    moveFeature(1, 0);
    expect(order()).toEqual([o0[1], o0[0]]);
    undo();
    expect(order()).toEqual(o0);
    deleteFeature(b.id);
    expect(order()).toEqual([a.id]);
    undo();
    expect(order()).toEqual(o0);
    expect(Object.keys(doc().bodies).sort()).toEqual([a.id, b.id].sort());
  });

  it("deleting a step while another step's editor is open can't be brought back by Cancel", () => {
    replaceDocument(newDocument("T"), null);
    const a = makePrimitive(doc(), "box");
    const b = makePrimitive(doc(), "cylinder");
    beginNewFeature(a, "a");
    commitSession();
    beginNewFeature(b, "b");
    commitSession();
    editFeature(a.id);
    deleteFeature(b.id);
    cancelSession();
    expect(doc().features.map((f) => f.id)).toEqual([a.id]);
  });

  it("moving a step while an unfinished new step is open moves the step that was picked", () => {
    replaceDocument(newDocument("T"), null);
    const a = makePrimitive(doc(), "box");
    const b = makePrimitive(doc(), "cylinder");
    beginNewFeature(a, "a");
    commitSession();
    beginNewFeature(b, "b");
    commitSession();
    const c = makePrimitive(doc(), "sphere");
    mutate("roll back", (d) => void (d.rollback = 0));
    beginNewFeature(c, "c"); // inserted first, at the marker
    mutate("roll forward", (d) => void (d.rollback = null));
    // The kernel reports it as still waiting for picks, so committing drops it.
    useApp.setState({ builtDoc: doc(), regen: { status: [{ id: c.id, state: "incomplete" }] } as never });
    expect(doc().features.map((f) => f.id)).toEqual([c.id, a.id, b.id]);
    moveFeature(2, 1); // b before a, as seen with c in the timeline
    expect(doc().features.map((f) => f.id)).toEqual([b.id, a.id]);
  });

  it("an edit that changes nothing is not an undo step", async () => {
    replaceDocument(newDocument("T"), null);
    const p = makePrimitive(doc(), "box");
    beginNewFeature(p, "New box");
    commitSession();
    const label = history.undoLabel;
    const before = doc();
    await new Promise((r) => setTimeout(r, 5)); // the old behaviour stamped a new time, so it needed the clock to move
    updateFeature(p.id, "same value", (f) => void ((f as unknown as { width: string }).width = (f as unknown as { width: string }).width));
    expect(history.undoLabel).toBe(label);
    expect(doc()).toBe(before);
    updateFeature(p.id, "real change", (f) => void ((f as unknown as { width: string }).width = "41"));
    expect(history.undoLabel).toBe("real change");
  });
});
