/**
 * 2D drawing sheet of the visible bodies: front, top and right views in third-angle
 * projection plus an isometric view, hidden lines dashed, overall dimensions and a
 * title block, scaled to fit an A3 landscape sheet. Output is a plain SVG, so it
 * opens in a browser, Inkscape, Illustrator or any PDF printer.
 */
import { type Shape3D, ProjectionCamera, drawProjection, makeCompound } from "replicad";

interface View {
  key: "front" | "top" | "right" | "iso";
  label: string;
  /** SVG paths (already y-down) and their extents in model millimetres. */
  visible: string[];
  hidden: string[];
  x0: number;
  y0: number;
  w: number;
  h: number;
}

const SHEET = { w: 420, h: 297, margin: 10, title: 22 };
/** Standard drawing scales: the model-to-paper divisor, with its label. */
const SCALES: [number, string][] = [
  [0.1, "10:1"], [0.2, "5:1"], [0.5, "2:1"], [1, "1:1"], [2, "1:2"], [5, "1:5"], [10, "1:10"], [20, "1:20"], [50, "1:50"], [100, "1:100"],
];

const flat = (p: string[] | string[][]): string[] => (p as (string | string[])[]).flat();
const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);
const fmt = (n: number) => String(Math.round(n * 100) / 100);

function project(shape: Shape3D, key: View["key"], label: string): View {
  let cam: Parameters<typeof drawProjection>[1];
  if (key === "iso") {
    const c = shape.boundingBox.center;
    const iso = new ProjectionCamera([c[0] + 1000, c[1] - 1000, c[2] + 800]);
    iso.lookAt([c[0], c[1], c[2]]);
    cam = iso;
  } else cam = key;
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

export interface DrawingOptions {
  title: string;
  /** Show hidden edges as dashed lines (default true). */
  hidden?: boolean;
}

export function buildDrawingSVG(shapes: Shape3D[], opts: DrawingOptions): string {
  if (shapes.length === 0) throw new Error("There are no visible bodies to draw.");
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

  // Cells of the layout; the gap leaves room for dimensions.
  const GAP = 24;
  const col1 = front.w;
  const col2 = Math.max(right.w, iso?.w ?? 0);
  const row1 = Math.max(top.h, iso?.h ?? 0);
  const row2 = front.h;
  const availW = SHEET.w - SHEET.margin * 2;
  const availH = SHEET.h - SHEET.margin * 2 - SHEET.title;
  const fit = Math.min((availW - GAP * 3) / Math.max(col1 + col2, 1e-6), (availH - GAP * 3) / Math.max(row1 + row2, 1e-6));
  // The largest standard scale that still fits (SCALES runs from biggest to smallest).
  const [den, scaleLabel] = SCALES.find(([d]) => 1 / d <= fit) ?? SCALES[SCALES.length - 1]!;
  const s = 1 / den;

  const sw = (col1 + col2) * s + GAP;
  const sh = (row1 + row2) * s + GAP;
  const ox = SHEET.margin + (availW - sw) / 2 + GAP / 2;
  const oy = SHEET.margin + (availH - sh) / 2 + GAP / 2;

  const frontX = ox;
  const frontY = oy + row1 * s + GAP;
  const topX = ox;
  const topY = frontY - GAP - top.h * s;
  const rightX = ox + col1 * s + GAP;
  const rightY = frontY;
  const isoX = rightX;
  const isoY = oy;

  const place = (v: View, px: number, py: number) => {
    const tx = px - v.x0 * s;
    const ty = py - v.y0 * s;
    // Stroke widths are given in paper millimetres, so undo the view's scale.
    const group = (cls: string, paths: string[]) =>
      paths.length ? `<g class="${cls}" stroke-width="${fmt((cls === "vis" ? 0.35 : 0.2) / s)}"${cls === "hid" ? ` stroke-dasharray="${fmt(2 / s)} ${fmt(1.2 / s)}"` : ""} transform="translate(${fmt(tx)} ${fmt(ty)}) scale(${s})">${paths.map((d) => `<path d="${esc(d)}"/>`).join("")}</g>` : "";
    // The isometric view stays clean: hidden lines belong to the orthographic views.
    return (opts.hidden === false || v.key === "iso" ? "" : group("hid", v.hidden)) + group("vis", v.visible);
  };

  let body = place(front, frontX, frontY) + place(top, topX, topY) + place(right, rightX, rightY);
  if (iso) body += place(iso, isoX, isoY);

  const lab = (v: View, x: number, y: number) => `<text class="lbl" x="${fmt(x)}" y="${fmt(y)}">${v.label}</text>`;
  body += lab(front, frontX, frontY + front.h * s + 13);
  body += lab(top, topX, topY - 5);
  body += lab(right, rightX, rightY + right.h * s + 13);
  if (iso) body += lab(iso, isoX, isoY - 5);
  body += dimH(frontX, frontX + front.w * s, frontY + front.h * s + 2, fmt(front.w));
  body += dimV(frontY, frontY + front.h * s, frontX - 3, fmt(front.h), false);
  body += dimV(topY, topY + top.h * s, topX + top.w * s + 3, fmt(top.h), true);
  body += dimH(rightX, rightX + right.w * s, rightY + right.h * s + 2, fmt(right.w));

  const date = new Date().toISOString().slice(0, 10);
  const tb = SHEET.h - SHEET.margin - SHEET.title;
  const W = SHEET.w;
  const frame = (x: number, y: number, w: number, h: number) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" class="frame"/>`;
  const sheet =
    frame(SHEET.margin, SHEET.margin, W - SHEET.margin * 2, SHEET.h - SHEET.margin * 2) +
    frame(SHEET.margin, tb, W - SHEET.margin * 2, SHEET.title) +
    `<line x1="${W - 150}" y1="${tb}" x2="${W - 150}" y2="${SHEET.h - SHEET.margin}" class="frame"/>` +
    `<line x1="${W - 90}" y1="${tb}" x2="${W - 90}" y2="${SHEET.h - SHEET.margin}" class="frame"/>` +
    `<text x="${SHEET.margin + 4}" y="${tb + 9}" class="big">${esc(opts.title)}</text>` +
    `<text x="${SHEET.margin + 4}" y="${tb + 17}" class="sm">Drawn with Whittle · third-angle projection · dimensions in millimetres</text>` +
    `<text x="${W - 146}" y="${tb + 9}" class="sm">SCALE</text><text x="${W - 146}" y="${tb + 17}" class="big">${scaleLabel}</text>` +
    `<text x="${W - 86}" y="${tb + 9}" class="sm">DATE</text><text x="${W - 86}" y="${tb + 17}" class="big">${date}</text>`;

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${SHEET.h}mm" viewBox="0 0 ${W} ${SHEET.h}">` +
    `<defs><marker id="arr" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#222"/></marker></defs>` +
    `<style>` +
    `.vis path{fill:none;stroke:#111;stroke-linejoin:round}` +
    `.hid path{fill:none;stroke:#777}` +
    `.dim line{stroke:#222;stroke-width:.2}.dim text{font:3.2px sans-serif;fill:#111}` +
    `.frame{fill:none;stroke:#111;stroke-width:.5}.lbl{font:bold 3.6px sans-serif;fill:#111}` +
    `.big{font:bold 4.4px sans-serif;fill:#111}.sm{font:2.4px sans-serif;fill:#555}` +
    `</style><rect width="${W}" height="${SHEET.h}" fill="#fff"/>` +
    sheet +
    body +
    `</svg>\n`
  );
}
