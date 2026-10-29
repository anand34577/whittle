/**
 * Reference images on sketches: place a photo or drawing on the sketch plane,
 * then make it true to size and draw over it.
 *   - Calibrate: click two points on the picture, type their real distance.
 *   - Flatten photo: click the four corners of something rectangular of known
 *     size (a sheet of A4, a credit card); the photo is un-skewed and scaled
 *     in one step, so a phone photo taken at an angle becomes a true-size plan.
 *   - Trace: turn the picture's dark (or light) shapes into editable outlines;
 *     round holes become exact circles.
 */
import { create } from "zustand";
import { LENGTH_TO_MM, type SketchEntity, lengthText, type SketchImage, type Vec2, trim, uid } from "@whittle/core";
import { promptDialog } from "./dialogs";
import { simplify } from "./simplify";
import { contours, fitCircle, grayscale, homography, otsu, signedArea, warp } from "./imageMath";
import { createSketchOn } from "./actions";
import { commitSession, findFeature, requestView, sketchMutate, toast, useApp } from "./store";

export type ImagePickKind = "calibrate" | "flatten" | "wand";

/** Points being clicked on the picture (sketch coordinates). */
export const useImagePick = create<{ kind: ImagePickKind | null; pts: Vec2[]; cursor: Vec2 | null }>(() => ({ kind: null, pts: [], cursor: null }));

const MAX_SIDE = 2400;

function activeImage(): SketchImage | undefined {
  const s = useApp.getState();
  return s.mode.kind === "sketch" ? findFeature(s.doc, s.mode.sketchId, "sketch")?.image : undefined;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("That picture couldn't be read. Try a JPEG or PNG."));
    img.src = src;
  });
}

function canvasOf(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.fillStyle = "#fff";
  g.fillRect(0, 0, w, h);
  return { c, g };
}

/** Decode, shrink to at most MAX_SIDE px and re-encode as JPEG (keeps documents small). */
async function encode(src: string, maxSide = MAX_SIDE): Promise<{ src: string; w: number; h: number; img: HTMLImageElement }> {
  const img = await loadImage(src);
  const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * k));
  const h = Math.max(1, Math.round(img.naturalHeight * k));
  const { c, g } = canvasOf(w, h);
  g.drawImage(img, 0, 0, w, h);
  return { src: c.toDataURL("image/jpeg", 0.88), w, h, img };
}

/** Sketch point → picture coordinates (0..1 across, 0..1 down). */
export function toUV(im: SketchImage, [x, y]: Vec2): Vec2 {
  const a = (-im.rotation * Math.PI) / 180;
  const dx = x - im.x;
  const dy = y - im.y;
  const lx = dx * Math.cos(a) - dy * Math.sin(a);
  const ly = dx * Math.sin(a) + dy * Math.cos(a);
  return [lx / im.width + 0.5, 0.5 - ly / (im.width * im.aspect)];
}

/** Picture coordinates → sketch point. */
export function fromUV(im: SketchImage, [u, v]: Vec2): Vec2 {
  const a = (im.rotation * Math.PI) / 180;
  const lx = (u - 0.5) * im.width;
  const ly = (0.5 - v) * im.width * im.aspect;
  return [im.x + lx * Math.cos(a) - ly * Math.sin(a), im.y + lx * Math.sin(a) + ly * Math.cos(a)];
}

export function updateImage(label: string, patch: Partial<SketchImage> | null, mergeKey?: string) {
  sketchMutate(
    label,
    (sk) => {
      if (patch === null) delete sk.image;
      else if (sk.image) Object.assign(sk.image, patch);
    },
    mergeKey,
  );
}

/** Put a picture (data URL or blob) on the sketch being edited, or on a new sketch on the ground plane. */
export async function placeImage(source: Blob | string, name: string) {
  const s = useApp.getState();
  if (s.mode.kind !== "sketch") {
    if (s.mode.kind !== "model") return;
    if (s.session) commitSession();
    createSketchOn({ kind: "origin", plane: "XY", offset: "0" });
  }
  try {
    const url = typeof source === "string" ? source : URL.createObjectURL(source);
    const { src, w, h } = await encode(url).finally(() => typeof source !== "string" && URL.revokeObjectURL(url));
    const old = activeImage();
    sketchMutate("Add reference image", (sk) => {
      sk.image = { src, name, x: 0, y: 0, width: old?.width ?? 200, aspect: h / w, rotation: 0, opacity: 0.6 };
    });
    useApp.setState({ selectedEntity: null });
    requestView("normal");
    toast("ok", "Picture added. Next: Calibrate (two points and their real distance) or Flatten photo (four corners of a known rectangle).");
  } catch (e) {
    toast("error", e instanceof Error ? e.message : "Couldn't add that picture.");
  }
}

/** Ask for a picture file. */
export function importImage() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/png,image/jpeg,image/webp,image/gif,image/bmp";
  input.onchange = () => {
    const f = input.files?.[0];
    if (f) void placeImage(f, f.name);
  };
  input.click();
}

export function startImagePick(kind: ImagePickKind) {
  if (!activeImage()) return toast("info", "Add a picture to this sketch first (Image in the sketch toolbar, or paste / drop one).");
  useImagePick.setState({ kind, pts: [], cursor: null }); // the viewport banner says what to click
}

export function cancelImagePick() {
  useImagePick.setState({ kind: null, pts: [], cursor: null });
}

/** A click while picking. Returns true when the click was used. */
export function imagePickPointer(type: "move" | "down", p: Vec2, button: number): boolean {
  const st = useImagePick.getState();
  if (!st.kind) return false;
  if (type === "move") {
    useImagePick.setState({ cursor: p });
    return true;
  }
  if (button !== 0) return false;
  const pts = [...st.pts, p];
  const need = { calibrate: 2, flatten: 4, wand: 1 }[st.kind];
  if (pts.length < need) {
    useImagePick.setState({ pts });
    return true;
  }
  const kind = st.kind;
  cancelImagePick();
  void (kind === "calibrate" ? calibrate(pts[0]!, pts[1]!) : kind === "flatten" ? flatten(pts) : traceImage(pts[0]));
  return true;
}

const unitInfo = () => {
  const units = useApp.getState().doc.units;
  return { units, k: LENGTH_TO_MM[units] };
};

async function calibrate(a: Vec2, b: Vec2) {
  const im = activeImage();
  if (!im) return;
  const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (d < 1e-6) return toast("warn", "Pick two different points.");
  const { units, k } = unitInfo();
  const answer = await promptDialog({
    title: "Calibrate picture",
    message: `Currently ${trim(d / k, 3)} ${units} apart on the picture. The picture is scaled about the first point.`,
    label: "Real distance",
    initial: trim(d / k, 3),
    unit: units,
    type: "number",
    confirmLabel: "Scale picture",
    choices: [
      { label: "Credit card width", value: trim(85.6 / k, 3) },
      { label: "Credit card height", value: trim(53.98 / k, 3) },
      { label: "A4 short side", value: trim(210 / k, 3) },
      { label: "Ruler 100 mm", value: trim(100 / k, 3) },
    ],
    validate: (v) => (parseFloat(v) > 0 ? null : "Enter a distance greater than zero"),
  });
  if (answer === null) return;
  const s = (parseFloat(answer) * k) / d;
  updateImage("Calibrate picture", { width: im.width * s, x: a[0] + (im.x - a[0]) * s, y: a[1] + (im.y - a[1]) * s });
  toast("ok", `Picture calibrated: scaled ×${trim(s, 3)}. Draw over it, or Trace it into outlines.`);
}

const RECTS: { label: string; w: number; h: number }[] = [
  { label: "A4 paper", w: 210, h: 297 },
  { label: "US Letter", w: 215.9, h: 279.4 },
  { label: "A3 paper", w: 297, h: 420 },
  { label: "Credit card", w: 85.6, h: 53.98 },
];

/** Picture pixel coordinates of a sketch point. */
const toPx = (im: SketchImage, p: Vec2, iw: number, ih: number): Vec2 => {
  const [u, v] = toUV(im, p);
  return [u * iw, v * ih];
};

async function flatten(clicked: Vec2[]) {
  const im = activeImage();
  if (!im) return;
  const { units, k } = unitInfo();
  const answer = await promptDialog({
    title: "Flatten photo",
    message: "Size of the rectangle you clicked (first edge × second edge). The photo is straightened and scaled to it, centred on the origin.",
    label: "Width × height",
    initial: `${trim(210 / k, 3)} x ${trim(297 / k, 3)}`,
    unit: units,
    confirmLabel: "Flatten",
    choices: RECTS.map((r) => ({ label: r.label, value: `${trim(r.w / k, 3)} x ${trim(r.h / k, 3)}` })),
    validate: (v) => (/^\s*[\d.]+\s*[x×*]\s*[\d.]+\s*$/i.test(v) && parseFloat(v) > 0 ? null : "Enter two sizes, like 210 x 297"),
  });
  if (answer === null) return;
  const [rw, rh] = answer.split(/[x×*]/i).map((x) => parseFloat(x) * k) as [number, number];
  try {
    const img = await loadImage(im.src);
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    let quad = clicked.map((p) => toPx(im, p, iw, ih));
    // Clicked anticlockwise on screen? Walk the other way so the result isn't mirrored.
    if (signedArea(quad) < 0) quad = [quad[0]!, quad[3]!, quad[2]!, quad[1]!];
    // Match the typed sizes to the clicked edges (A4 "210 × 297" works whichever way the sheet lies).
    const e1 = Math.hypot(quad[1]![0] - quad[0]![0], quad[1]![1] - quad[0]![1]) + Math.hypot(quad[2]![0] - quad[3]![0], quad[2]![1] - quad[3]![1]);
    const e2 = Math.hypot(quad[2]![0] - quad[1]![0], quad[2]![1] - quad[1]![1]) + Math.hypot(quad[3]![0] - quad[0]![0], quad[3]![1] - quad[0]![1]);
    const [W, Hh] = e1 >= e2 === rw >= rh ? [rw, rh] : [rh, rw];
    // Output: the rectangle plus a margin around it, at about the photo's own resolution.
    const m = Math.max(W, Hh) * 0.25;
    const pxPerMm = Math.min(Math.max(e1, e2) / 2 / Math.max(W, Hh), MAX_SIDE / (Math.max(W, Hh) + 2 * m));
    const ow = Math.round((W + 2 * m) * pxPerMm);
    const oh = Math.round((Hh + 2 * m) * pxPerMm);
    const rect: Vec2[] = [[m, m], [m + W, m], [m + W, m + Hh], [m, m + Hh]].map(([x, y]) => [x! * pxPerMm, y! * pxPerMm]);
    const H = homography(rect, quad);
    if (!H) return toast("warn", "Those corners don't make a rectangle. Click four corners in order around it.");
    const { c, g } = canvasOf(iw, ih);
    g.drawImage(img, 0, 0);
    const out = warp(g.getImageData(0, 0, iw, ih), H, ow, oh);
    const dst = canvasOf(ow, oh);
    dst.g.putImageData(new ImageData(out.data as Uint8ClampedArray<ArrayBuffer>, ow, oh), 0, 0);
    c.width = 0;
    updateImage("Flatten photo", { src: dst.c.toDataURL("image/jpeg", 0.88), width: W + 2 * m, aspect: oh / ow, x: 0, y: 0, rotation: 0 });
    toast("ok", `Photo flattened to true size (${trim(W / k, 2)} × ${trim(Hh / k, 2)} ${units}). Draw over it, or Trace it.`);
  } catch (e) {
    toast("error", e instanceof Error ? e.message : "Couldn't flatten that photo.");
  }
}

/** Turn the picture's shapes into sketch outlines (and circles); with `seed`, only the area around that point. */
export async function traceImage(seed?: Vec2) {
  const im = activeImage();
  if (!im) return toast("info", "Add a picture to this sketch first.");
  try {
    const img = await loadImage(im.src);
    const k = Math.min(1, 900 / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(2, Math.round(img.naturalWidth * k));
    const h = Math.max(2, Math.round(img.naturalHeight * k));
    const { c, g } = canvasOf(w, h);
    g.filter = "blur(0.6px)"; // ponytail: light blur instead of a denoise pass; enough for photos of parts on paper
    g.drawImage(img, 0, 0, w, h);
    const gray = grayscale(g.getImageData(0, 0, w, h));
    c.width = 0;
    const thr = otsu(gray);
    // Trace whichever side the border isn't: dark parts on light paper, or light parts on a dark table.
    let border = 0;
    for (let x = 0; x < w; x++) border += gray[x]! + gray[(h - 1) * w + x]!;
    for (let y = 0; y < h; y++) border += gray[y * w]! + gray[y * w + w - 1]!;
    const darkInside = border / (2 * (w + h)) > thr;
    let field = darkInside ? Float32Array.from(gray, (v) => 255 - v) : Float32Array.from(gray);
    const T = darkInside ? 255 - thr : thr;
    if (seed) {
      // Magic wand: flood-fill the clicked side of the threshold, then trace only that area.
      const [u, v] = toUV(im, seed);
      const sx = Math.floor(u * w);
      const sy = Math.floor(v * h);
      if (sx < 0 || sy < 0 || sx >= w || sy >= h) return toast("info", "Click on the picture.");
      const s0 = sy * w + sx;
      if (field[s0]! <= T) field = field.map((f) => 2 * T - f); // clicked a light area: trace that instead
      const inArea = new Uint8Array(w * h);
      const stack = [s0];
      inArea[s0] = 1;
      while (stack.length) {
        const i = stack.pop()!;
        const x = i % w;
        for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
          if (j >= 0 && j < w * h && !inArea[j] && field[j]! > T) {
            inArea[j] = 1;
            stack.push(j);
          }
        }
      }
      field = field.map((f, i) => (inArea[i] ? f : Math.min(f, T - 1)));
    }
    const loops = contours(field, w, h, T);
    const minArea = Math.max(12, w * h * 0.0002);
    const kept = loops.map((l) => ({ l, a: Math.abs(signedArea(l)) })).filter((x) => x.a >= minArea).sort((a, b) => b.a - a.a);
    const cap = 150;
    const mmPerPx = im.width / w;
    const toSketch = ([x, y]: Vec2): Vec2 => fromUV(im, [x / w, y / h]);
    // Picture positions are in mm; sketch fields are in the document unit.
    const { units } = unitInfo();
    const n = (mm: number) => lengthText(mm, units);
    const entities: SketchEntity[] = [];
    for (const { l } of kept.slice(0, cap)) {
      const circ = fitCircle(l, 0.025);
      if (circ) {
        const [cx, cy] = toSketch([circ.cx, circ.cy]);
        entities.push({ id: uid("e"), type: "circle", cx: n(cx), cy: n(cy), r: n(circ.r * mmPerPx) });
        continue;
      }
      const pts = simplify([...l, l[0]!], 0.7).slice(0, -1);
      if (pts.length < 3) continue;
      entities.push({ id: uid("e"), type: "polyline", points: pts.map((p) => toSketch(p).map(n) as [string, string]) });
    }
    if (!entities.length) return toast("warn", "No clear shapes found. Use a photo with good contrast against the background.");
    sketchMutate(`Trace ${im.name}`, (sk) => {
      for (const e of entities) sk.entities.push(e as never);
    });
    useApp.setState({ selectedEntity: null });
    const circles = entities.filter((e) => e.type === "circle").length;
    toast(
      "ok",
      `Traced ${entities.length} shape${entities.length === 1 ? "" : "s"}${circles ? ` (${circles} exact circle${circles === 1 ? "" : "s"})` : ""}${kept.length > cap ? `; kept the ${cap} largest` : ""}. Shapes inside shapes become holes.`,
    );
  } catch (e) {
    toast("error", e instanceof Error ? e.message : "Couldn't trace that picture.");
  }
}
