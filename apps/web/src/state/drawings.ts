/**
 * 2D drawings in and out of sketches:
 *   - export a sketch as SVG or DXF (laser cutters, CNC routers, vinyl cutters, plotters, other CAD)
 *   - import an SVG (logos, lettering, traced outlines) as editable sketch shapes
 */
import { promptDialog } from "./dialogs";
import { type Evaluator, type LengthUnit, type ResolvedEntity, lengthText, type SketchEntity, type SketchFeature, type Vec2, documentEvaluator, drawnEntities, parseDxf, entityLoops, expandSketch, resolveEntity, trim, uid } from "@whittle/core";
import { exportText } from "./files";
import { getKernel } from "./kernel";
import { simplify } from "./simplify";
export { simplify };
import { findFeature, sketchMutate, toast, useApp } from "./store";

/* ───────────────────────────── Export ───────────────────────────── */

export interface DrawingShape {
  /** Exact circle (kept as a true circle in DXF/SVG) or an outline. */
  circle?: { cx: number; cy: number; r: number };
  loop?: Vec2[];
  /** An open path or a single line: exported without closing it (audit W-14). */
  open?: boolean;
}

/** The shapes and open paths of a sketch, in millimetres (construction geometry is skipped; text is outlined by the geometry engine). */
export function sketchShapes(entities: SketchEntity[], ev: Evaluator): { shapes: DrawingShape[]; skipped: number } {
  const shapes: DrawingShape[] = [];
  let skipped = 0;
  for (const e of entities) {
    let r: ResolvedEntity;
    try {
      r = resolveEntity(e, ev);
    } catch {
      skipped++;
      continue;
    }
    // Text outlines come from the geometry engine (exportSketch adds them).
    if (r.construction || r.type === "text") continue;
    if (r.type === "circle") {
      shapes.push({ circle: { cx: r.cx, cy: r.cy, r: r.r } });
      continue;
    }
    if (r.type === "polyline" && r.open) {
      const path = entityLoops(r, 96)[0] ?? [];
      if (path.length >= 2) shapes.push({ loop: path, open: true });
      else skipped++;
      continue;
    }
    for (const loop of entityLoops(r, 96)) {
      if (loop.length >= 3) shapes.push({ loop });
      else skipped++;
    }
    if (r.type === "gear" && r.bore > 0) {
      shapes.pop(); // replace the sampled bore with an exact circle
      shapes.push({ circle: { cx: r.cx, cy: r.cy, r: r.bore / 2 } });
    }
  }
  return { shapes, skipped };
}

function bounds(shapes: DrawingShape[]): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const add = (x: number, y: number) => {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  };
  for (const s of shapes) {
    if (s.circle) {
      add(s.circle.cx - s.circle.r, s.circle.cy - s.circle.r);
      add(s.circle.cx + s.circle.r, s.circle.cy + s.circle.r);
    }
    for (const [x, y] of s.loop ?? []) add(x, y);
  }
  return Number.isFinite(x0) ? [x0, y0, x1, y1] : [0, 0, 1, 1];
}

const n = (v: number) => trim(v, 4);

/** An SVG in real millimetres (opens at true size in vector editors and laser or vinyl-cutter software). */
export function shapesToSvg(shapes: DrawingShape[], title: string): string {
  const [x0, y0, x1, y1] = bounds(shapes);
  const pad = 1;
  const w = x1 - x0 + pad * 2;
  const h = y1 - y0 + pad * 2;
  // SVG's y axis points down; the sketch's points up.
  const X = (x: number) => n(x - x0 + pad);
  const Y = (y: number) => n(y1 - y + pad);
  const body = shapes
    .map((s) =>
      s.circle
        ? `<circle cx="${X(s.circle.cx)}" cy="${Y(s.circle.cy)}" r="${n(s.circle.r)}"/>`
        : `<path d="M${s.loop!.map(([x, y]) => `${X(x)} ${Y(y)}`).join(" L")}${s.open ? "" : " Z"}"/>`,
    )
    .join("\n  ");
  const esc = title.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${n(w)}mm" height="${n(h)}mm" viewBox="0 0 ${n(w)} ${n(h)}">
  <title>${esc}</title>
  <g fill="none" stroke="#000" stroke-width="0.1" fill-rule="evenodd">
  ${body}
  </g>
</svg>
`;
}

/** A minimal ASCII DXF (R12-compatible entities, millimetres) for CAM and other CAD tools. */
export function shapesToDxf(shapes: DrawingShape[]): string {
  const out: string[] = ["0", "SECTION", "2", "HEADER", "9", "$INSUNITS", "70", "4", "9", "$MEASUREMENT", "70", "1", "0", "ENDSEC", "0", "SECTION", "2", "ENTITIES"];
  for (const s of shapes) {
    if (s.circle) {
      out.push("0", "CIRCLE", "8", "0", "10", n(s.circle.cx), "20", n(s.circle.cy), "30", "0", "40", n(s.circle.r));
      continue;
    }
    const pts = s.loop!;
    if (s.open && pts.length === 2) {
      out.push("0", "LINE", "8", "0", "10", n(pts[0]![0]), "20", n(pts[0]![1]), "30", "0", "11", n(pts[1]![0]), "21", n(pts[1]![1]), "31", "0");
      continue;
    }
    out.push("0", "POLYLINE", "8", "0", "66", "1", "70", s.open ? "0" : "1", "10", "0", "20", "0", "30", "0");
    for (const [x, y] of pts) out.push("0", "VERTEX", "8", "0", "10", n(x), "20", n(y), "30", "0");
    out.push("0", "SEQEND", "8", "0");
  }
  out.push("0", "ENDSEC", "0", "EOF");
  return out.join("\n") + "\n";
}

/** Export a sketch as SVG or DXF. */
export async function exportSketch(sketchId: string, format: "svg" | "dxf") {
  const { doc } = useApp.getState();
  const sk = findFeature(doc, sketchId, "sketch");
  if (!sk) return;
  // Constraint-driven geometry exports at its solved positions.
  const sol = useApp.getState().regen?.sketches.find((x) => x.id === sk.id)?.solution;
  const { shapes, skipped } = sketchShapes(drawnEntities(expandSketch(sk, sol).entities), documentEvaluator(doc));
  if (sk.entities.some((e) => e.type === "text" && !e.construction)) {
    try {
      const r = await getKernel().inspect(doc, "text");
      const loops = r.kind === "text" ? (r.items.find((x) => x.sketchId === sk.id)?.loops ?? []) : [];
      for (const loop of loops) shapes.push({ loop });
    } catch (e) {
      return toast("error", `The text couldn't be outlined for export: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (shapes.length === 0) return toast("info", "This sketch has nothing to export.");
  await exportText(format === "svg" ? shapesToSvg(shapes, `${doc.name} - ${sk.name}`) : shapesToDxf(shapes), `${doc.name} - ${sk.name}`, format);
  if (skipped) toast("info", `${skipped} shape${skipped > 1 ? "s" : ""} with errors or too few points couldn't be exported.`);
}

/** The sketch an export command should use: the one being edited, else the selected one. */
export function sketchForExport(): SketchFeature | undefined {
  const s = useApp.getState();
  if (s.mode.kind === "sketch") return findFeature(s.doc, s.mode.sketchId, "sketch");
  const p = s.selection.find((x) => x.kind === "sketch");
  return p?.kind === "sketch" ? findFeature(s.doc, p.sketchId, "sketch") : undefined;
}

/* ───────────────────────────── Import ───────────────────────────── */

/** Split densely sampled points into separate loops wherever the pen jumped (a new subpath). */
export function splitAtJumps(points: Vec2[], step: number): Vec2[][] {
  const loops: Vec2[][] = [];
  let cur: Vec2[] = [];
  for (const p of points) {
    const last = cur[cur.length - 1];
    if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) > step * 2.5) {
      loops.push(cur);
      cur = [];
    }
    cur.push(p);
  }
  if (cur.length) loops.push(cur);
  return loops;
}

function area(pts: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a / 2);
}

/** Turn closed loops (in SVG units, y down) into sketch outlines `width` mm wide, centered on the origin. */
/** `width` is in mm; the points are written in `units` (the document unit). */
export function loopsToEntities(loops: Vec2[][], width: number, units: LengthUnit = "mm"): SketchEntity[] {
  const all = loops.flat();
  if (all.length === 0) return [];
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const scale = width / Math.max(x1 - x0, 1e-9);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const tol = Math.max(x1 - x0, y1 - y0) * 0.0008;
  const minArea = (Math.max(x1 - x0, y1 - y0) * 0.002) ** 2;
  const out: SketchEntity[] = [];
  for (const raw of loops) {
    let loop = simplify(raw, tol);
    // Drop the duplicated closing point.
    const a = loop[0];
    const b = loop[loop.length - 1];
    if (a && b && loop.length > 3 && Math.hypot(a[0] - b[0], a[1] - b[1]) < tol * 2) loop = loop.slice(0, -1);
    if (loop.length < 3 || area(loop) < minArea) continue;
    out.push({
      id: uid("e"),
      type: "polyline",
      points: loop.map(([x, y]) => [lengthText((x - cx) * scale, units), lengthText((cy - y) * scale, units)] as [string, string]),
    });
  }
  return out;
}

const CSS_MM: Record<string, number> = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6 };

/**
 * Millimetres per SVG user unit, from the root's width and viewBox, for an SVG saved at a real size (like Whittle's own export).
 * Pixel and unitless sizes say nothing about the real size, so they give undefined.
 */
export function svgMmPerUnit(width: string | null, viewBox: string | null): number | undefined {
  const m = /^\s*([\d.]+(?:e[-+]?\d+)?)\s*(mm|cm|in|pt|pc)\s*$/i.exec(width ?? "");
  if (!m) return undefined;
  const mm = Number.parseFloat(m[1]!) * CSS_MM[m[2]!.toLowerCase()]!;
  const vb = (viewBox ?? "").trim().split(/[\s,]+/).map(Number);
  // With no viewBox, a user unit is a CSS pixel whatever the width says.
  if (!(vb.length === 4 && vb[2]! > 0)) return 25.4 / 96;
  return mm > 0 ? mm / vb[2]! : undefined;
}

/** Read an SVG file's closed shapes as dense point loops in the SVG's own units (needs a DOM). */
function svgLoops(text: string): { loops: Vec2[][]; mmPerUnit?: number } {
  const parsed = new DOMParser().parseFromString(text, "image/svg+xml");
  const root = parsed.documentElement;
  if (root.nodeName !== "svg" || parsed.querySelector("parsererror")) throw new Error("That isn't a readable SVG file.");
  // Geometry APIs need a rendered element: mount it invisibly for a moment.
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-10000px;top:0;width:1000px;height:1000px;visibility:hidden;pointer-events:none";
  const svg = document.importNode(root, true) as unknown as SVGSVGElement;
  // Only the outlines are wanted: drop anything that could run code or fetch something once it is mounted.
  // <style> too: while mounted its rules would apply to the whole page, and url() would fetch from anywhere (audit A-3).
  for (const s of svg.querySelectorAll("script, style, foreignObject, image, iframe, object, embed, audio, video, animate, set, animateMotion, animateTransform")) s.remove();
  for (const el of [svg, ...svg.querySelectorAll("*")]) {
    for (const a of [...el.attributes]) {
      if (/^on/i.test(a.name) || (/^(xlink:)?href$/i.test(a.name) && !a.value.trim().startsWith("#"))) el.removeAttribute(a.name);
      else if (a.name === "style" && /url\s*\(|@import|expression\s*\(/i.test(a.value)) el.removeAttribute(a.name);
    }
  }
  const mmPerUnit = svgMmPerUnit(root.getAttribute("width"), root.getAttribute("viewBox"));
  host.appendChild(svg);
  document.body.appendChild(host);
  try {
    const rootInv = svg.getScreenCTM()?.inverse();
    const loops: Vec2[][] = [];
    const shapes = svg.querySelectorAll<SVGGeometryElement>("path, polygon, rect, circle, ellipse, polyline");
    let budget = 60000;
    for (const el of shapes) {
      if (el.closest("defs, clipPath, mask, symbol, marker, pattern")) continue;
      const total = el.getTotalLength();
      if (!(total > 0)) continue;
      const box = el.getBBox();
      const step = Math.max(total / 4000, Math.max(box.width, box.height) / 600, 1e-6);
      const count = Math.min(Math.ceil(total / step), budget);
      budget -= count;
      const m = rootInv && el.getScreenCTM() ? rootInv.multiply(el.getScreenCTM()!) : null;
      const pts: Vec2[] = [];
      for (let i = 0; i <= count; i++) {
        const p = el.getPointAtLength((total * i) / count);
        const q = m ? p.matrixTransform(m) : p;
        pts.push([q.x, q.y]);
      }
      const scale = m ? Math.hypot(m.a, m.b) : 1;
      loops.push(...splitAtJumps(pts, (scale * total) / Math.max(count, 1)));
      if (budget <= 0) break;
    }
    return { loops, ...(mmPerUnit ? { mmPerUnit } : {}) };
  } finally {
    host.remove();
  }
}

/** Ask for an SVG file and add its shapes to the sketch being edited. */
export function importSvgIntoSketch() {
  const s = useApp.getState();
  if (s.mode.kind !== "sketch") return toast("info", "Open a sketch first, then import an SVG into it.");
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".svg,image/svg+xml";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const { loops, mmPerUnit } = svgLoops(await file.text());
      // A drawing saved at a real size (millimetres, inches...) starts at that size; one in pixels is scaled to 50 mm.
      const xs = loops.flat().map((p) => p[0]);
      const natural = mmPerUnit && xs.length ? (Math.max(...xs) - Math.min(...xs)) * mmPerUnit : 0;
      const answer = await promptDialog({
        title: `Import ${file.name}`,
        message: natural > 0 ? "The artwork keeps its proportions and starts at the size it was drawn. Shapes inside shapes become holes." : "The artwork keeps its proportions. Shapes inside shapes become holes.",
        label: "Width",
        initial: natural > 0 ? trim(natural, 2) : "50",
        unit: "mm",
        type: "number",
        confirmLabel: "Import",
        validate: (v) => (parseFloat(v) > 0 ? null : "Enter a width greater than zero"),
      });
      if (answer === null) return;
      // The width is asked in mm; the shapes are written in the document unit.
      const entities = loopsToEntities(loops, parseFloat(answer), useApp.getState().doc.units);
      if (entities.length === 0) return toast("warn", "No closed shapes were found in that SVG. Convert strokes and text to paths first.");
      sketchMutate(`Import ${file.name}`, (sk) => {
        for (const e of entities) sk.entities.push(e as never);
      });
      useApp.setState({ selectedEntity: null });
      toast("ok", `Added ${entities.length} shape${entities.length > 1 ? "s" : ""} from ${file.name}. Shapes inside shapes become holes.`);
    } catch (e) {
      toast("error", e instanceof Error ? e.message : "Couldn't read that SVG.");
    }
  };
  input.click();
}

const UNIT_NAMES: Record<number, string> = { 1: "millimetres", 10: "centimetres", 1000: "metres", 25.4: "inches", 304.8: "feet", 914.4: "yards", 0.0254: "thousandths of an inch", 0.001: "micrometres", 100: "decimetres" };

/** Ask for a DXF file and add its lines, arcs, circles and outlines to the sketch being edited. */
export function importDxfIntoSketch() {
  const s = useApp.getState();
  if (s.mode.kind !== "sketch") return toast("info", "Open a sketch first, then import a DXF into it.");
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".dxf";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const dxf = parseDxf(await file.text());
      if (!dxf.loops.length && !dxf.circles.length) return toast("warn", "No lines, arcs, circles or outlines were found in that DXF.");
      const answer = await promptDialog({
        title: `Import ${file.name}`,
        // The file's own unit, when its header gives one, is the starting answer.
        message: dxf.mmPerUnit
          ? `The file says it was drawn in ${UNIT_NAMES[dxf.mmPerUnit] ?? "its own units"}, so the scale is set to match. Change it if the import comes out the wrong size.`
          : "Scale of the drawing: 1 if it is in millimetres, 25.4 if it is in inches.",
        label: "Scale",
        initial: String(dxf.mmPerUnit ?? 1),
        type: "number",
        confirmLabel: "Import",
        validate: (v) => (parseFloat(v) > 0 ? null : "Enter a number greater than zero"),
      });
      if (answer === null) return;
      // The scale gives mm per drawing unit; the shapes are written in the document unit.
      const k = parseFloat(answer);
      const len = (mm: number) => lengthText(mm, useApp.getState().doc.units, 4);
      const entities: SketchEntity[] = [
        ...dxf.circles.map((c) => ({ id: uid("e"), type: "circle" as const, cx: len(c.c[0] * k), cy: len(c.c[1] * k), r: len(c.r * k) })),
        ...dxf.loops
          .filter((l) => l.pts.length >= (l.closed ? 3 : 2))
          .map((l) => ({ id: uid("e"), type: "polyline" as const, points: l.pts.map(([x, y]) => [len(x * k), len(y * k)] as [string, string]), ...(l.closed ? {} : { open: true }) })),
      ];
      sketchMutate(`Import ${file.name}`, (sk) => {
        for (const e of entities) sk.entities.push(e as never);
      });
      useApp.setState({ selectedEntity: null });
      toast("ok", `Added ${entities.length} shape${entities.length > 1 ? "s" : ""} from ${file.name}.${dxf.skipped.length ? ` Skipped: ${dxf.skipped.join(", ")}.` : ""}`);
    } catch (e) {
      toast("error", e instanceof Error ? e.message : "Couldn't read that DXF.");
    }
  };
  input.click();
}
