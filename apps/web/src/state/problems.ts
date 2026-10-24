/**
 * The design's "Problems" list, like an IDE's: what failed, what warns and what is
 * left unfinished, each with where it is and (when there is one) a one-click fix.
 */
import type { Id } from "@whittle/core";
import { activeEnd, documentEvaluator, featureValueIssues } from "@whittle/core";
import { type AppState, editFeature, mutate, updateFeature, useApp } from "./store";
import { fixInUnits } from "../ui/DragHandle";

export type Severity = "error" | "warning" | "info";

export interface Problem {
  key: string;
  severity: Severity;
  title: string;
  detail?: string;
  featureId?: Id;
  fix?: { label: string; run: () => void };
}

const RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

export function problemsOf(s: Pick<AppState, "doc" | "regen" | "session">): Problem[] {
  const { doc, regen } = s;
  const out: Problem[] = [];
  const end = activeEnd(doc);
  const name = (id: Id) => doc.features.find((f) => f.id === id)?.name ?? "A step";

  for (const st of regen?.status ?? []) {
    if (st.id === s.session?.featureId) continue; // the open feature says it in its own panel
    if (st.state !== "error" && st.state !== "warning") continue;
    const fix = st.fix;
    out.push({
      key: `st-${st.id}`,
      severity: st.state,
      title: `${name(st.id)} ${st.state === "error" ? "failed" : "needs a look"}`,
      detail: st.message,
      featureId: st.id,
      fix: fix
        ? { label: fix.label, run: () => updateFeature(st.id, fix.label, (d) => void ((d as unknown as Record<string, string>)[fix.field] = fixInUnits(fix.value, useApp.getState().doc.units))) }
        : { label: "Edit", run: () => editFeature(st.id) },
    });
  }

  const ev = documentEvaluator(doc);
  doc.features.slice(0, end).forEach((f) => {
    if (f.suppressed || f.type === "sketch" || regen?.status.some((st) => st.id === f.id && st.state === "error")) return;
    const issues = featureValueIssues(f, ev);
    if (issues.length) out.push({ key: `val-${f.id}`, severity: "error", title: `${f.name} has a value that can't work`, detail: issues.join(" "), featureId: f.id, fix: { label: "Edit", run: () => editFeature(f.id) } });
  });

  doc.features.slice(0, end).forEach((f) => {
    if (f.type !== "sketch" || f.suppressed) return;
    const sol = regen?.sketches.find((x) => x.id === f.id)?.solution;
    if (sol?.state === "over" || sol?.state === "error") {
      out.push({ key: `over-${f.id}`, severity: "error", title: `${f.name}: constraints conflict`, detail: sol.message ?? "Some constraints or dimensions fight each other. The red ones are at fault.", featureId: f.id, fix: { label: "Edit sketch", run: () => editFeature(f.id) } });
    } else if (sol?.state === "under" && sol.dof > 0 && (f.geometry?.length ?? 0) > 0) {
      out.push({ key: `dof-${f.id}`, severity: "info", title: `${f.name} can still move`, detail: `${sol.dof} way${sol.dof > 1 ? "s" : ""} to move left. Edit it and use AutoConstrain, then add dimensions, so later edits can't change it by accident.`, featureId: f.id, fix: { label: "Edit sketch", run: () => editFeature(f.id) } });
    }
    const drawn = f.entities.length + (f.geometry?.length ?? 0) > 0;
    const used = doc.features.some((g) => g.type !== "sketch" && JSON.stringify(g).includes(f.id));
    if (drawn && !used) out.push({ key: `unused-${f.id}`, severity: "info", title: `${f.name} isn't used yet`, detail: "Extrude or revolve it to make a solid, or leave it as a reference.", featureId: f.id });
  });

  const off = doc.features.filter((f) => f.suppressed);
  if (off.length) {
    out.push({
      key: "suppressed",
      severity: "info",
      title: `${off.length} step${off.length > 1 ? "s are" : " is"} turned off`,
      detail: off.map((f) => f.name).join(", "),
      featureId: off[0]!.id,
      fix: { label: "Turn on", run: () => mutate("Turn steps back on", (d) => d.features.forEach((f) => void (f.suppressed = false))) },
    });
  }
  if (doc.rollback !== null && doc.rollback < doc.features.length && !s.session?.isolated) {
    const n = doc.features.length - doc.rollback;
    out.push({ key: "rollback", severity: "warning", title: `The timeline is rolled back`, detail: `${n} later step${n > 1 ? "s are" : " is"} hidden and not built.`, fix: { label: "Go to end", run: () => mutate("Move timeline marker", (d) => void (d.rollback = null)) } });
  }
  return out.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}

/** What usually comes next for a design in this state: a command and why, at most four. */
export function nextSteps(s: Pick<AppState, "doc" | "regen">): { id: string; why: string }[] {
  const { doc } = s;
  const live = doc.features.slice(0, activeEnd(doc)).filter((f) => !f.suppressed);
  const has = (t: string) => live.some((f) => f.type === t);
  if (live.length === 0) {
    return [
      { id: "sketch", why: "Draw a shape on a plane, then pull it into 3D" },
      { id: "box", why: "Start from a ready shape and size it" },
      { id: "parts", why: "Insert a gear, bracket, knob or fastener" },
      { id: "welcome", why: "Open an editable template" },
    ];
  }
  const out: { id: string; why: string }[] = [];
  const unused = live.find((f) => f.type === "sketch" && f.entities.length + (f.geometry?.length ?? 0) > 0 && !doc.features.some((g) => g.type !== "sketch" && JSON.stringify(g).includes(f.id)));
  if (unused) out.push({ id: "extrude", why: `Pull ${unused.name} into a solid` }, { id: "revolve", why: `Spin ${unused.name} around an axis` });
  const bodies = s.regen?.bodies ?? [];
  // Rounding, hollowing and drilling need a solid; a design of surfaces only gets thicken instead.
  const solid = bodies.some((b) => b.volume > 1e-9);
  if (bodies.length > 0 && !solid) out.push({ id: "surface-thicken", why: "Give the surface a wall thickness to make it a solid" });
  if (bodies.length > 0) {
    if (solid && !has("fillet") && !has("chamfer")) out.push({ id: "fillet", why: "Round sharp edges: safer to handle and stronger" });
    if (solid && !has("shell")) out.push({ id: "shell", why: "Hollow it into a case, cup or enclosure" });
    if (solid && !has("hole")) out.push({ id: "hole", why: "Add screw holes, counterbored or countersunk" });
    if (doc.parameters.length === 0) out.push({ id: "params", why: "Name the key sizes so one change updates everything" });
    out.push({ id: "export", why: "STEP for other CAD and manufacturing, STL or 3MF for meshes and printing" });
  }
  return out.slice(0, 4);
}
