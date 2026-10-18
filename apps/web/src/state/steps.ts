/**
 * Timeline steps as a group: folders, and copy/paste of steps (Ctrl+C / Ctrl+V outside a sketch).
 * Pasted steps get fresh ids; links between the copied steps follow, links to other steps stay.
 */
import type { Draft } from "immer";
import { FEATURE_LABELS, type Feature, type Id, activeEnd, nextName, uid } from "@whittle/core";
import { promptDialog } from "./dialogs";
import { mutate, toast, useApp } from "./store";

/** Steps picked in the timeline (Shift/Ctrl+click adds); kept here so commands and keys can use them. */
export const timelinePick: { ids: Id[] } = { ids: [] };

/** What to act on: the picked steps, else the step behind the selection. */
function targets(): Id[] {
  const s = useApp.getState();
  if (timelinePick.ids.length) return timelinePick.ids.filter((id) => s.doc.features.some((f) => f.id === id));
  const p = s.selection[0];
  const id = p?.kind === "sketch" ? p.sketchId : p && "bodyId" in p ? p.bodyId : undefined;
  return id && s.doc.features.some((f) => f.id === id) ? [id] : [];
}

let copied: Feature[] = [];

export function copySteps() {
  const ids = targets();
  const doc = useApp.getState().doc;
  if (!ids.length) return toast("info", "Click a step in the timeline (Shift+click for more), then Ctrl+C.");
  copied = doc.features.filter((f) => ids.includes(f.id)).map((f) => structuredClone(f));
  toast("info", `Copied ${copied.length} step${copied.length > 1 ? "s" : ""}. Ctrl+V pastes them at the timeline marker.`);
}

export function pasteSteps() {
  if (!copied.length) return toast("info", "Nothing copied yet: click a step in the timeline, then Ctrl+C.");
  // ponytail: ids are random and unique, so a text swap re-points every link between the copies.
  let text = JSON.stringify(copied);
  for (const f of copied) text = text.split(f.id).join(uid(f.id.replace(/[^a-z].*$/, "") || "f"));
  const fresh = JSON.parse(text) as Feature[];
  mutate(`Paste ${fresh.length} step${fresh.length > 1 ? "s" : ""}`, (d) => {
    const at = activeEnd(d as never);
    for (const f of fresh) f.name = nextName(d as never, FEATURE_LABELS[f.type]);
    d.features.splice(at, 0, ...(fresh as Draft<Feature>[]));
    if (d.rollback !== null) d.rollback += fresh.length;
  });
}

export async function folderSteps() {
  const ids = targets();
  if (!ids.length) return toast("info", "Click the steps to group (Shift+click for more), then make the folder.");
  const name = await promptDialog({ title: "New folder", label: "Name", initial: `Folder ${(useApp.getState().doc.folders?.length ?? 0) + 1}`, confirmLabel: "Create" });
  if (!name?.trim()) return;
  mutate("New folder", (d) => {
    // A step lives in one folder: taking it from another empties that one, which then goes.
    d.folders = (d.folders ?? []).map((x) => ({ ...x, features: x.features.filter((id) => !ids.includes(id)) })).filter((x) => x.features.length);
    d.folders.push({ id: uid("fo"), name: name.trim(), features: ids, open: false });
  });
  timelinePick.ids = [];
}
