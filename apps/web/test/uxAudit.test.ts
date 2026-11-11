/** Fixes from the November 2026 user-experience audit (docs/AUDIT_UX_2026-11.md), web side. */
import { describe, expect, it } from "vitest";
import { type SketchFeature, makeFillet, makePrimitive, makeSketch, newDocument } from "@whittle/core";
import { lessonPlane, lessonProgress, untickLesson } from "../src/state/lessons";
import { beginNewFeature, commitSession, mutate, replaceDocument, undo, useApp } from "../src/state/store";

const state = () => useApp.getState();

describe("the first lesson (audit B-1, B-2)", () => {
  it("doesn't tick Start a sketch while a plane is still being picked, and asks for the flat plane", () => {
    replaceDocument(newDocument("L"), null);
    untickLesson("first");
    useApp.setState({ coach: "first", mode: { kind: "pickPlane" } });
    expect(lessonProgress(state())!.current).toBe(0);
    expect(lessonPlane(state())).toBe("XY");
    expect(lessonProgress(state())!.lesson.steps[0]!.body).toMatch(/lit up/);
  });

  it("ticks it once a sketch is on the flat plane, not on another one", () => {
    replaceDocument(newDocument("L"), null);
    untickLesson("first");
    const wrong = makeSketch(state().doc, { kind: "origin", plane: "XZ", offset: "0" }) as SketchFeature;
    mutate("Sketch", (d) => void d.features.push(wrong as never));
    useApp.setState({ coach: "first", mode: { kind: "model" } });
    expect(lessonProgress(state())!.current).toBe(0);
    expect(lessonProgress(state())!.lesson.steps[0]!.body).toMatch(/XZ plane, not the flat one/);
    const right = makeSketch(state().doc, { kind: "origin", plane: "XY", offset: "0" }) as SketchFeature;
    mutate("Sketch", (d) => void d.features.push(right as never));
    expect(lessonProgress(state())!.current).toBe(1);
    useApp.setState({ coach: false });
  });
});

describe("a step that doesn't build (audit U-12)", () => {
  it("isn't added by Enter: the person is told why, and can keep it on purpose", () => {
    replaceDocument(newDocument("F"), null);
    const box = makePrimitive(state().doc, "box");
    mutate("Box", (d) => void d.features.push(box as never));
    const fillet = makeFillet(state().doc);
    if (fillet.type === "fillet") fillet.edges = [{ bodyId: box.id, mid: [0, 0, 0], tangent: [1, 0, 0], curve: "LINE", length: 1 }];
    beginNewFeature(fillet, "New fillet");
    const doc = state().doc;
    useApp.setState({ builtDoc: doc, regen: { ...(state().regen ?? ({} as never)), status: [{ id: fillet.id, state: "error", message: "Too large", ms: 1 }] } as never });
    commitSession(true);
    expect(state().session).toBeTruthy();
    expect(state().toasts.at(-1)?.text).toMatch(/can't be built yet: Too large/);
    commitSession(true, true);
    expect(state().session).toBeNull();
    expect(state().doc.features.some((f) => f.id === fillet.id)).toBe(true);
  });
});

describe("undo past the start of a new step (audit B-12)", () => {
  it("says the step was removed", () => {
    replaceDocument(newDocument("U"), null);
    const box = makePrimitive(state().doc, "box");
    beginNewFeature(box, "New box");
    undo();
    expect(state().session).toBeNull();
    expect(state().toasts.at(-1)?.text).toMatch(/so it was removed/);
  });
});
