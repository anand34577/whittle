/**
 * Tangent chains: the edges that continue smoothly from one edge, so that rounding
 * one side of a rounded rectangle takes the whole outline.
 */
import type { EdgeInfo } from "@whittle/kernel";

const NEAR = 1e-3;
/** Edges meeting at less than about 2 degrees count as continuing. */
const COS_TOL = Math.cos((2 * Math.PI) / 180);

const same = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!) < NEAR;
const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;

/** Indices of the edges tangent-continuous with `start` (including it). */
export function tangentChain(edges: EdgeInfo[], start: number): number[] {
  const seen = new Set<number>([start]);
  const queue = [start];
  while (queue.length) {
    const i = queue.pop()!;
    const a = edges[i];
    if (!a?.ends || !a.endTangents) continue;
    for (let j = 0; j < edges.length; j++) {
      if (seen.has(j)) continue;
      const b = edges[j]!;
      if (!b.ends || !b.endTangents) continue;
      let joined = false;
      for (let ea = 0; ea < 2 && !joined; ea++) {
        for (let eb = 0; eb < 2 && !joined; eb++) {
          if (same(a.ends[ea]!, b.ends[eb]!) && Math.abs(dot(a.endTangents[ea]!, b.endTangents[eb]!)) > COS_TOL) joined = true;
        }
      }
      if (joined) {
        seen.add(j);
        queue.push(j);
      }
    }
  }
  return [...seen];
}
