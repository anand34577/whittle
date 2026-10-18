/** The view on screen, for code outside it (named views) that shouldn't pull in three.js. */
export interface CameraState {
  target: [number, number, number];
  distance: number;
  theta: number;
  phi: number;
}

export const viewportRef: { current: { getCamera(): CameraState; setCamera(c: CameraState): void } | null } = { current: null };
