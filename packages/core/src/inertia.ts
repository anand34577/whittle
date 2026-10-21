/**
 * Mass properties: the inertia tensor of a body, several bodies together (parallel-axis theorem) and its principal moments.
 * A tensor is [Ixx, Iyy, Izz, Ixy, Iyz, Izx] about a point, in mass × length², with the products of inertia
 * signed as in the usual symmetric matrix (Ixy = -∫xy dm).
 */
import type { Vec3 } from "./model";

export type Inertia = [number, number, number, number, number, number];

export interface MassBody {
  mass: number;
  /** Center of mass. */
  com: Vec3;
  /** Tensor about this body's own center of mass. */
  inertia: Inertia;
}

/** One tensor moved from the body's own center of mass to `to` (Huygens-Steiner, in three dimensions). */
export function shiftInertia(i: Inertia, mass: number, from: Vec3, to: Vec3): Inertia {
  const d: Vec3 = [from[0] - to[0], from[1] - to[1], from[2] - to[2]];
  const dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  return [
    i[0] + mass * (dd - d[0] * d[0]),
    i[1] + mass * (dd - d[1] * d[1]),
    i[2] + mass * (dd - d[2] * d[2]),
    i[3] - mass * d[0] * d[1],
    i[4] - mass * d[1] * d[2],
    i[5] - mass * d[2] * d[0],
  ];
}

/** Several bodies as one: total mass, the joint center of mass and the tensor about it. */
export function combineBodies(bodies: MassBody[]): MassBody | null {
  const mass = bodies.reduce((a, b) => a + b.mass, 0);
  if (!(mass > 0)) return null;
  const com: Vec3 = [0, 1, 2].map((k) => bodies.reduce((a, b) => a + b.com[k]! * b.mass, 0) / mass) as Vec3;
  let total: Inertia = [0, 0, 0, 0, 0, 0];
  for (const b of bodies) {
    const s = shiftInertia(b.inertia, b.mass, b.com, com);
    total = total.map((v, k) => v + s[k]!) as Inertia;
  }
  return { mass, com, inertia: total };
}

/** The three principal moments (smallest first) of a tensor, by Jacobi rotations. */
export function principalMoments(i: Inertia): Vec3 {
  const a = [
    [i[0], i[3], i[5]],
    [i[3], i[1], i[4]],
    [i[5], i[4], i[2]],
  ];
  for (let sweep = 0; sweep < 32; sweep++) {
    const off = Math.abs(a[0]![1]!) + Math.abs(a[0]![2]!) + Math.abs(a[1]![2]!);
    const diag = Math.abs(a[0]![0]!) + Math.abs(a[1]![1]!) + Math.abs(a[2]![2]!);
    if (off <= 1e-14 * (diag || 1)) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]] as const) {
      const apq = a[p]![q]!;
      if (Math.abs(apq) < 1e-300) continue;
      const theta = (a[q]![q]! - a[p]![p]!) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k]![p]!;
        const akq = a[k]![q]!;
        a[k]![p] = c * akp - s * akq;
        a[k]![q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p]![k]!;
        const aqk = a[q]![k]!;
        a[p]![k] = c * apk - s * aqk;
        a[q]![k] = s * apk + c * aqk;
      }
    }
  }
  return ([a[0]![0]!, a[1]![1]!, a[2]![2]!] as Vec3).sort((x, y) => x - y) as Vec3;
}
