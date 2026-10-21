/** The view on screen, for code outside it (named views) that shouldn't pull in three.js. */
export interface CameraState {
  target: [number, number, number];
  distance: number;
  theta: number;
  phi: number;
}

export const viewportRef: {
  current: {
    getCamera(): CameraState;
    setCamera(c: CameraState): void;
    /** Where a point of the open sketch is on the canvas (CSS px), or null outside a sketch. */
    sketchToScreen(p: [number, number]): [number, number] | null;
  } | null;
} = { current: null };

/**
 * After a long press opens a menu under the finger, lifting the finger makes the browser click whatever is there (the
 * menu's own centre). Clicks before `until` (a time from performance.now()) are to be ignored.
 */
export const touchGuard = { until: 0 };
