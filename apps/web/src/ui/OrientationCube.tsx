/**
 * Orientation cube: an HTML/CSS 3D cube that mirrors the camera. Click a face, an edge or a corner to look from
 * there, or drag it to turn the view.
 */
import { useEffect, useRef } from "react";
import type { CubeView, Viewport } from "../viewport/Viewport";

const H = 30; // half size in px

const FACES: { id: CubeView; label: string; n: number[]; r: number[]; u: number[] }[] = [
  { id: "front", label: "FRONT", n: [0, -1, 0], r: [1, 0, 0], u: [0, 0, 1] },
  { id: "back", label: "BACK", n: [0, 1, 0], r: [-1, 0, 0], u: [0, 0, 1] },
  { id: "right", label: "RIGHT", n: [1, 0, 0], r: [0, 1, 0], u: [0, 0, 1] },
  { id: "left", label: "LEFT", n: [-1, 0, 0], r: [0, -1, 0], u: [0, 0, 1] },
  { id: "top", label: "TOP", n: [0, 0, 1], r: [1, 0, 0], u: [0, 1, 0] },
  { id: "bottom", label: "BOTTOM", n: [0, 0, -1], r: [1, 0, 0], u: [0, -1, 0] },
];

const NAMES: [number[], string][] = [
  [[0, -1, 0], "front"],
  [[0, 1, 0], "back"],
  [[1, 0, 0], "right"],
  [[-1, 0, 0], "left"],
  [[0, 0, 1], "top"],
  [[0, 0, -1], "bottom"],
];
/** "top front right" for a corner direction, and so on. */
const nameOf = (d: number[]) =>
  NAMES.filter(([n]) => n.some((x, i) => x !== 0 && x === d[i]))
    .map(([, s]) => s)
    .sort((a, b) => ["top", "bottom", "front", "back", "left", "right"].indexOf(a) - ["top", "bottom", "front", "back", "left", "right"].indexOf(b))
    .join(" ");

const faceMatrix = (f: (typeof FACES)[number]) =>
  `matrix3d(${[...f.r, 0, ...f.u.map((x) => -x), 0, ...f.n, 0, ...f.n.map((x) => x * H), 1].join(",")})`;

/** A face's 3 x 3 hot zones, top row first: corners, edges and the face itself. */
const zones = (f: (typeof FACES)[number]) =>
  [1, 0, -1].flatMap((v) => [-1, 0, 1].map((c) => ({ c, v, dir: f.n.map((x, i) => x + c * f.r[i]! + v * f.u[i]!) })));

export function OrientationCube({ viewport, tick }: { viewport: Viewport | null; tick: { subscribe: (fn: () => void) => () => void } }) {
  const cube = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  useEffect(() => {
    const update = () => {
      if (!viewport || !cube.current) return;
      viewport.camera.updateMatrixWorld();
      const e = viewport.camera.matrixWorldInverse.elements;
      const m = [e[0], -e[1]!, e[2], 0, e[4], -e[5]!, e[6], 0, e[8], -e[9]!, e[10], 0, 0, 0, 0, 1];
      cube.current.style.transform = `matrix3d(${m.join(",")})`;
    };
    update();
    return tick.subscribe(update);
  }, [viewport, tick]);

  return (
    <div
      className="orientcube"
      aria-label="Orientation cube"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        drag.current = { x: e.clientX, y: e.clientY, moved: false };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || !viewport) return;
        const dx = e.clientX - d.x;
        const dy = e.clientY - d.y;
        if (!d.moved && Math.hypot(dx, dy) < 4) return;
        if (!d.moved) e.currentTarget.setPointerCapture(e.pointerId);
        d.moved = true;
        d.x = e.clientX;
        d.y = e.clientY;
        viewport.orbitBy(dx * 1.6, dy * 1.6);
      }}
      onPointerUp={() => setTimeout(() => (drag.current = null))}
      onPointerCancel={() => (drag.current = null)}
      onClickCapture={(e) => {
        // The end of a drag isn't a click on whatever zone it ended over.
        if (drag.current?.moved) e.stopPropagation();
      }}
    >
      <div className="orientcube__stage">
        <div className="orientcube__cube" ref={cube}>
          {FACES.map((f) => (
            <div key={f.id} className="orientcube__face" data-face={f.id} style={{ transform: faceMatrix(f), width: H * 2, height: H * 2, left: -H, top: -H }}>
              {zones(f).map(({ c, v, dir }) => {
                const face = c === 0 && v === 0;
                return (
                  <button
                    key={`${c}${v}`}
                    className={`orientcube__zone ${face ? "orientcube__zone--face" : ""}`}
                    onClick={() => (face ? viewport?.viewTo(f.id) : viewport?.viewDirection(dir as [number, number, number]))}
                    title={`Look from the ${nameOf(dir)}`}
                    aria-label={`Look from the ${nameOf(dir)}`}
                  >
                    {face && f.label}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <button className="orientcube__home" onClick={() => viewport?.viewTo("home")} title="Home view (H)" aria-label="Home view">
        <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3.5 9.5 L10 3.8 L16.5 9.5" />
          <path d="M5.5 8 V16.5 H14.5 V8" />
        </svg>
      </button>
    </div>
  );
}
