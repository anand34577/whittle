/** Orientation cube: an HTML/CSS 3D cube that mirrors the camera. Click a face to look at it. */
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

const faceMatrix = (f: (typeof FACES)[number]) =>
  `matrix3d(${[...f.r, 0, ...f.u.map((x) => -x), 0, ...f.n, 0, ...f.n.map((x) => x * H), 1].join(",")})`;

export function OrientationCube({ viewport, tick }: { viewport: Viewport | null; tick: { subscribe: (fn: () => void) => () => void } }) {
  const cube = useRef<HTMLDivElement>(null);

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
    <div className="orientcube" aria-label="Orientation cube">
      <div className="orientcube__stage">
        <div className="orientcube__cube" ref={cube}>
          {FACES.map((f) => (
            <button
              key={f.id}
              className="orientcube__face"
              style={{ transform: faceMatrix(f), width: H * 2, height: H * 2, left: -H, top: -H }}
              onClick={() => viewport?.viewTo(f.id)}
              title={`Look at ${f.label.toLowerCase()}`}
            >
              {f.label}
            </button>
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