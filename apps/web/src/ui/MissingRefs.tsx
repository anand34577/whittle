/**
 * When an upstream change breaks what a feature was attached to, show where it
 * used to be as a red ghost on the canvas. Click a ghost
 * to let it go; click a new edge or face in the model to replace it.
 */
import type { EdgeRef, Feature, FaceRef, Vec3 } from "@whittle/core";
import type { RegenResult } from "@whittle/kernel";
import { updateFeature } from "../state/store";
import type { Viewport } from "../viewport/Viewport";
import { Icon } from "./icons";

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/** The kernel's own test for "still the same thing" (kernel refs.ts `jumpOk`): size within 4x, moved at most 3x its size. */
const plausible = (now: number, was: number, moved: number, size: number) => {
  const [lo, hi] = [Math.min(now, was), Math.max(now, was)];
  return !(lo > 0 && hi / lo > 4) && moved <= 3 * size;
};

interface Ghost {
  at: Vec3;
  kind: "edge" | "face";
  drop: () => void;
}

function ghostsFor(f: Feature, regen: RegenResult | null): Ghost[] {
  const bodies = regen?.pickBodies ?? regen?.bodies ?? [];
  const out: Ghost[] = [];
  const edges = (list: EdgeRef[], remove: (keep: EdgeRef[]) => void) => {
    for (const r of list) {
      // Matched the way the kernel re-finds it, not "any parallel edge" (audit UI-3: on a box that is every edge).
      const found = bodies
        .find((b) => b.id === r.bodyId)
        ?.edges.some((e) => e.curve === r.curve && Math.abs(dot(e.tangent, r.tangent)) > 0.999 && plausible(e.length, r.length, dist(e.mid, r.mid), Math.max(e.length, r.length)));
      if (!found) out.push({ at: r.mid, kind: "edge", drop: () => remove(list.filter((x) => x !== r)) });
    }
  };
  const faces = (list: FaceRef[], remove: (keep: FaceRef[]) => void) => {
    for (const r of list) {
      const found = bodies
        .find((b) => b.id === r.bodyId)
        ?.faces.some((x) => x.surface === r.surface && dot(x.normal, r.normal) > 0.999 && plausible(x.area, r.area, dist(x.center, r.center), Math.sqrt(Math.max(x.area, r.area))));
      if (!found) out.push({ at: r.center, kind: "face", drop: () => remove(list.filter((x) => x !== r)) });
    }
  };
  const label = "Drop missing " + f.name;
  if (f.type === "fillet" || f.type === "chamfer")
    edges(f.edges, (keep) => updateFeature(f.id, label, (d) => void ((d.type === "fillet" || d.type === "chamfer") && (d.edges = keep))));
  if (f.type === "shell" || f.type === "draft" || f.type === "offsetFace")
    faces(f.faces, (keep) => updateFeature(f.id, label, (d) => void ((d.type === "shell" || d.type === "draft" || d.type === "offsetFace") && (d.faces = keep))));
  return out;
}

export function MissingRefs({ vp, feature, regen }: { vp: Viewport | null; feature: Feature | undefined; regen: RegenResult | null }) {
  if (!vp || !feature) return null;
  const ghosts = ghostsFor(feature, regen);
  if (!ghosts.length) return null;
  return (
    <>
      <div className="viewport__banner" role="status">
        <Icon name="warning" size={16} /> {ghosts.length} missing {ghosts[0]!.kind}
        {ghosts.length > 1 ? "s" : ""}: shown in red where {ghosts.length > 1 ? "they" : "it"} used to be. Click a red mark to drop it, or pick a new one in the model.
      </div>
      {ghosts.map((g, i) => {
        const p = vp.worldToScreen(g.at);
        return (
          <button key={i} type="button" className="ghost-ref" style={{ left: p[0], top: p[1] }} title="Missing: click to drop it from this feature" aria-label={`Missing ${g.kind}: drop it`} onPointerDown={(e) => e.stopPropagation()} onClick={g.drop}>
            ✕
          </button>
        );
      })}
    </>
  );
}
