/**
 * 2D drawing sheet of the visible bodies: front, top and right views (third- or first-angle
 * projection) plus an isometric view, hidden lines dashed, overall dimensions, an optional
 * section view and parts list, and a title block, on an A4 to A1 sheet at a standard scale.
 * Output is a plain SVG, so it opens in a browser, any vector editor or any PDF printer.
 */
import { type Shape3D, ProjectionCamera, drawProjection, makeBox, makeCompound } from "replicad";
import type { DrawingSettings } from "./protocol";
import { faceInfo } from "./refs";

interface View {
  key: "front" | "top" | "right" | "iso" | "section";
  label: string;
  /** SVG paths (already y-down) and their extents in model millimetres. */
  visible: string[];
  hidden: string[];
  /** The cut faces of a section view, filled with hatching. */
  cut?: string[];
  x0: number;
  y0: number;
  w: number;
  h: number;
}

/** Sheet sizes in millimetres (landscape). */
const SHEETS: Record<NonNullable<DrawingSettings["sheet"]>, [number, number]> = { A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594] };
const MARGIN = 10;
const TITLE = 22;
const ROW = 5;
/** Standard drawing scales: the model-to-paper divisor, biggest first. */
const SCALES = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100];

const flat = (p: string[] | string[][]): string[] => (p as (string | string[])[]).flat();
const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);
const fmt = (n: number) => String(Math.round(n * 100) / 100);
/** "2:1", "1:5", "1:1". */
export const scaleLabel = (den: number) => (den >= 1 ? `1:${fmt(den)}` : `${fmt(1 / den)}:1`);

function project(shape: Shape3D, key: View["key"], label: string): View {
  let cam: Parameters<typeof drawProjection>[1];
  if (key === "iso") {
    const c = shape.boundingBox.center;
    const iso = new ProjectionCamera([c[0] + 1000, c[1] - 1000, c[2] + 800]);
    iso.lookAt([c[0], c[1], c[2]]);
    cam = iso;
  } else cam = key === "section" ? "front" : key;
  const { visible, hidden } = drawProjection(shape, cam);
  const [[xa, ya], [xb, yb]] = visible.boundingBox.bounds;
  return {
    key,
    label,
    visible: flat(visible.toSVGPaths()),
    hidden: flat(hidden.toSVGPaths()),
    x0: xa,
    y0: -yb,
    w: xb - xa,
    h: yb - ya,
  };
}

/** One closed SVG path for a flat face lying in the section plane: every wire sampled, on the front view's axes (x, -z). */
function facePath(face: ReturnType<Shape3D["faces"]["at"]> & object): string {
  const inner = face.clone().innerWires();
  const loops = [face.clone().outerWire(), ...inner];
  return loops
    .map((w) => {
      const pts: [number, number][] = [];
      for (const e of w.edges) {
        const n = e.geomType === "LINE" ? 1 : 48;
        const seg: [number, number][] = [];
        for (let i = 0; i <= n; i++) {
          const p = e.pointAt(i / n);
          seg.push([p.x, -p.z]);
        }
        // Edges come in any direction: join each to the end of the path so far.
        const end = pts[pts.length - 1];
        if (end && Math.hypot(seg[0]![0] - end[0], seg[0]![1] - end[1]) > Math.hypot(seg[n]![0] - end[0], seg[n]![1] - end[1])) seg.reverse();
        pts.push(...(end ? seg.slice(1) : seg));
      }
      return "M" + pts.map(([x, y]) => `${fmt(x)} ${fmt(y)}`).join(" L") + " Z";
    })
    .join(" ");
}

/**
 * The front view of the part cut through its middle (the near half removed), with the cut faces
 * outlined for hatching; null when the part has nothing to cut.
 */
function sectionView(all: Shape3D): { view: View; mid: number } | null {
  const [lo, hi] = all.boundingBox.bounds;
  const mid = (lo[1] + hi[1]) / 2;
  if (hi[1] - lo[1] < 1e-6) return null;
  const half = all.clone().cut(makeBox([lo[0] - 1, lo[1] - 1, lo[2] - 1], [hi[0] + 1, mid, hi[2] + 1])) as Shape3D;
  const view = project(half, "section", "SECTION A-A");
  const cutFaces = half.faces.filter((f) => {
    if (f.geomType !== "PLANE") return false;
    const i = faceInfo(f);
    return Math.abs(i.center[1] - mid) < 1e-4 && i.normal[1] < -0.99;
  });
  if (cutFaces.length) view.cut = cutFaces.map(facePath);
  return { view, mid };
}

function dimH(x1: number, x2: number, y: number, text: string): string {
  const mid = (x1 + x2) / 2;
  return (
    `<g class="dim"><line x1="${fmt(x1)}" y1="${fmt(y - 2)}" x2="${fmt(x1)}" y2="${fmt(y + 3)}"/>` +
    `<line x1="${fmt(x2)}" y1="${fmt(y - 2)}" x2="${fmt(x2)}" y2="${fmt(y + 3)}"/>` +
    `<line x1="${fmt(x1)}" y1="${fmt(y + 2)}" x2="${fmt(x2)}" y2="${fmt(y + 2)}" marker-start="url(#arr)" marker-end="url(#arr)"/>` +
    `<text x="${fmt(mid)}" y="${fmt(y + 6.2)}" text-anchor="middle">${esc(text)}</text></g>`
  );
}

function dimV(y1: number, y2: number, x: number, text: string, right: boolean): string {
  const d = right ? 1 : -1;
  const mid = (y1 + y2) / 2;
  return (
    `<g class="dim"><line x1="${fmt(x - d * 2)}" y1="${fmt(y1)}" x2="${fmt(x + d * 3)}" y2="${fmt(y1)}"/>` +
    `<line x1="${fmt(x - d * 2)}" y1="${fmt(y2)}" x2="${fmt(x + d * 3)}" y2="${fmt(y2)}"/>` +
    `<line x1="${fmt(x + d * 2)}" y1="${fmt(y1)}" x2="${fmt(x + d * 2)}" y2="${fmt(y2)}" marker-start="url(#arr)" marker-end="url(#arr)"/>` +
    `<text transform="translate(${fmt(x + d * 2 + (right ? 4.2 : -1.2))} ${fmt(mid)}) rotate(-90)" text-anchor="middle">${esc(text)}</text></g>`
  );
}

export interface DrawingOptions extends Omit<DrawingSettings, "parts"> {
  title: string;
  /** For the parts list: each body's name, volume (mm³) and material. */
  parts?: { name: string; volume: number; material?: string }[];
}

/** Where a view goes: the grid cell it sits in and how it lines up inside it. */
interface Cell {
  view: View;
  col: number;
  row: number;
  h: "left" | "right";
  v: "top" | "bottom";
}

export function buildDrawingSVG(shapes: Shape3D[], opts: DrawingOptions): string {
  if (shapes.length === 0) throw new Error("There are no visible bodies to draw.");
  const [W, H] = SHEETS[opts.sheet ?? "A3"];
  const first = opts.angle === "first";
  const all = shapes.length === 1 ? shapes[0]! : (makeCompound(shapes.map((s) => s.clone())) as Shape3D);
  const front = project(all, "front", "FRONT");
  const top = project(all, "top", "TOP");
  const right = project(all, "right", "RIGHT");
  let iso: View | null = null;
  try {
    iso = project(all, "iso", "ISOMETRIC");
  } catch {
    iso = null;
  }
  let section: { view: View; mid: number } | null = null;
  if (opts.section) {
    try {
      section = sectionView(all);
    } catch {
      section = null;
    }
    if (!section) throw new Error("This part can't be cut for a section view.");
  }

  // A grid of cells; the gap leaves room for dimensions.
  // Third angle: the top view sits above the front and the right view to its right. First angle: the other way round.
  const cells: Cell[] = first
    ? [
        { view: front, col: 1, row: 0, h: "left", v: "top" },
        { view: right, col: 0, row: 0, h: "right", v: "top" },
        { view: top, col: 1, row: 1, h: "left", v: "top" },
        ...(iso ? [{ view: iso, col: 0, row: 1, h: "left", v: "top" } as Cell] : []),
        ...(section ? [{ view: section.view, col: 2, row: 0, h: "left", v: "top" } as Cell] : []),
      ]
    : [
        { view: top, col: 0, row: 0, h: "left", v: "bottom" },
        { view: front, col: 0, row: 1, h: "left", v: "top" },
        { view: right, col: 1, row: 1, h: "left", v: "top" },
        ...(iso ? [{ view: iso, col: 1, row: 0, h: "left", v: "top" } as Cell] : []),
        ...(section ? [{ view: section.view, col: 2, row: 1, h: "left", v: "top" } as Cell] : []),
      ];
  const cols = Math.max(...cells.map((c) => c.col)) + 1;
  const colW = Array.from({ length: cols }, (_, i) => Math.max(0, ...cells.filter((c) => c.col === i).map((c) => c.view.w)));
  const rowH = [0, 1].map((r) => Math.max(0, ...cells.filter((c) => c.row === r).map((c) => c.view.h)));
  const GAP = 24;

  const bomRows = opts.parts?.length ? opts.parts.length + 1 : 0;
  const bomH = bomRows ? bomRows * ROW + 4 : 0;
  const availW = W - MARGIN * 2;
  const availH = H - MARGIN * 2 - TITLE - bomH;
  const sumW = colW.reduce((a, b) => a + b, 0);
  const sumH = rowH[0]! + rowH[1]!;
  const fit = Math.min((availW - GAP * (cols + 1)) / Math.max(sumW, 1e-6), (availH - GAP * 3) / Math.max(sumH, 1e-6));
  // A scale asked for is used as it is; otherwise the largest standard scale that still fits.
  const den = opts.scale && opts.scale > 0 ? opts.scale : (SCALES.find((d) => 1 / d <= fit) ?? SCALES[SCALES.length - 1]!);
  const s = 1 / den;

  const sw = sumW * s + GAP * (cols - 1);
  const sh = sumH * s + GAP;
  const ox = MARGIN + (availW - sw) / 2;
  const oy = MARGIN + (availH - sh) / 2;
  const colX = (c: number) => ox + colW.slice(0, c).reduce((a, b) => a + b * s + GAP, 0);
  const rowY = (r: number) => oy + (r === 0 ? 0 : rowH[0]! * s + GAP);

  const pos = new Map<View, [number, number]>();
  for (const c of cells) {
    const x = colX(c.col) + (c.h === "right" ? (colW[c.col]! - c.view.w) * s : 0);
    const y = rowY(c.row) + (c.v === "bottom" ? (rowH[c.row]! - c.view.h) * s : 0);
    pos.set(c.view, [x, y]);
  }

  const place = (v: View) => {
    const [px, py] = pos.get(v)!;
    const tx = px - v.x0 * s;
    const ty = py - v.y0 * s;
    const tf = `transform="translate(${fmt(tx)} ${fmt(ty)}) scale(${s})"`;
    // Stroke widths are given in paper millimetres, so undo the view's scale.
    const group = (cls: string, paths: string[], extra = "") =>
      paths.length ? `<g class="${cls}" stroke-width="${fmt((cls === "vis" ? 0.35 : 0.2) / s)}"${extra} ${tf}>${paths.map((d) => `<path d="${esc(d)}"${cls === "cut" ? ' fill="url(#hatch)" fill-rule="evenodd" stroke="none"' : ""}/>`).join("")}</g>` : "";
    // The isometric view stays clean: hidden lines belong to the orthographic views.
    const hid = opts.hidden === false || v.key === "iso" ? "" : group("hid", v.hidden, ` stroke-dasharray="${fmt(2 / s)} ${fmt(1.2 / s)}"`);
    return (v.cut ? group("cut", v.cut) : "") + hid + group("vis", v.visible);
  };

  let body = cells.map((c) => place(c.view)).join("");
  const at = (v: View) => pos.get(v)!;
  for (const c of cells) {
    const [x, y] = at(c.view);
    // Labels go under a view, except the top view's (above it).
    body += `<text class="lbl" x="${fmt(x)}" y="${fmt(c.view.key === "top" ? y - 5 : y + c.view.h * s + 13)}">${c.view.label}</text>`;
  }
  // Overall dimensions: the front view's width and height, the top view's depth and the right view's depth.
  const [fx, fy] = at(front);
  const [tx0, ty0] = at(top);
  const [rx, ry] = at(right);
  body += dimH(fx, fx + front.w * s, fy + front.h * s + 2, fmt(front.w));
  body += dimV(fy, fy + front.h * s, fx - 3, fmt(front.h), false);
  body += dimV(ty0, ty0 + top.h * s, tx0 + top.w * s + 3, fmt(top.h), true);
  body += dimH(rx, rx + right.w * s, ry + right.h * s + 2, fmt(right.w));

  // The cutting plane on the top view: a chain line across it, lettered at both ends.
  if (section) {
    const yy = ty0 + (-section.mid - top.y0) * s;
    body +=
      `<line x1="${fmt(tx0 - 6)}" y1="${fmt(yy)}" x2="${fmt(tx0 + top.w * s + 12)}" y2="${fmt(yy)}" class="cutline"/>` +
      `<text class="lbl" x="${fmt(tx0 - 9)}" y="${fmt(yy + 1.2)}">A</text><text class="lbl" x="${fmt(tx0 + top.w * s + 14)}" y="${fmt(yy + 1.2)}">A</text>`;
  }

  const date = new Date().toISOString().slice(0, 10);
  const tb = H - MARGIN - TITLE;
  const frame = (x: number, y: number, w: number, h: number) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" class="frame"/>`;
  const sheet =
    frame(MARGIN, MARGIN, W - MARGIN * 2, H - MARGIN * 2) +
    frame(MARGIN, tb, W - MARGIN * 2, TITLE) +
    `<line x1="${W - 150}" y1="${tb}" x2="${W - 150}" y2="${H - MARGIN}" class="frame"/>` +
    `<line x1="${W - 90}" y1="${tb}" x2="${W - 90}" y2="${H - MARGIN}" class="frame"/>` +
    `<text x="${MARGIN + 4}" y="${tb + 9}" class="big">${esc(opts.title)}</text>` +
    `<text x="${MARGIN + 4}" y="${tb + 17}" class="sm">Drawn with Whittle · ${first ? "first" : "third"}-angle projection · dimensions in millimetres</text>` +
    `<text x="${W - 146}" y="${tb + 9}" class="sm">SCALE</text><text x="${W - 146}" y="${tb + 17}" class="big">${scaleLabel(den)}</text>` +
    `<text x="${W - 86}" y="${tb + 9}" class="sm">DATE</text><text x="${W - 86}" y="${tb + 17}" class="big">${date}</text>`;

  // The parts list sits just above the title block, at the right.
  let bom = "";
  if (opts.parts?.length) {
    const widths = [8, 60, 24, 24];
    const bw = widths.reduce((a, b) => a + b, 0);
    const bx = W - MARGIN - bw;
    const by = tb - bomRows * ROW;
    const head = ["#", "PART", "VOLUME cm³", "MATERIAL"];
    const rows = [head, ...opts.parts.map((p, i) => [String(i + 1), p.name, fmt(p.volume / 1000), p.material ?? "-"])];
    bom += frame(bx, by, bw, bomRows * ROW);
    rows.forEach((r, i) => {
      let x = bx;
      r.forEach((cell, j) => {
        bom += `<text x="${fmt(x + 1.5)}" y="${fmt(by + i * ROW + 3.5)}" class="${i === 0 ? "sm" : "cell"}">${esc(cell.length > 30 ? cell.slice(0, 29) + "…" : cell)}</text>`;
        x += widths[j]!;
      });
      if (i > 0) bom += `<line x1="${bx}" y1="${by + i * ROW}" x2="${bx + bw}" y2="${by + i * ROW}" class="rule"/>`;
    });
  }

  const hatch = 2 / s;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}">` +
    `<defs><marker id="arr" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#222"/></marker>` +
    `<pattern id="hatch" width="${fmt(hatch)}" height="${fmt(hatch)}" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="${fmt(hatch)}" stroke="#444" stroke-width="${fmt(0.18 / s)}"/></pattern></defs>` +
    `<style>` +
    `.vis path{fill:none;stroke:#111;stroke-linejoin:round}` +
    `.hid path{fill:none;stroke:#777}` +
    `.dim line{stroke:#222;stroke-width:.2}.dim text{font:3.2px sans-serif;fill:#111}` +
    `.cutline{stroke:#111;stroke-width:.35;stroke-dasharray:6 1.5 1 1.5}.rule{stroke:#111;stroke-width:.2}` +
    `.frame{fill:none;stroke:#111;stroke-width:.5}.lbl{font:bold 3.6px sans-serif;fill:#111}` +
    `.big{font:bold 4.4px sans-serif;fill:#111}.sm{font:2.4px sans-serif;fill:#555}.cell{font:2.8px sans-serif;fill:#111}` +
    `</style><rect width="${W}" height="${H}" fill="#fff"/>` +
    sheet +
    body +
    bom +
    `</svg>\n`
  );
}
