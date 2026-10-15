/**
 * Sketch tool controller: turns pointer events on the sketch plane into
 * shapes. Every tool works with two clicks (or press-drag-release), snaps to
 * the grid, to existing points and to horizontal/vertical alignments, and
 * accepts typed dimensions (just start typing a number).
 */
import {
  type EntityType,
  type Evaluator,
  type Id,
  type ResolvedEntity,
  type SketchEntity,
  type Vec2,
  entityOutline,
  entitySnapPoints,
  makeEntity,
  resolveEntity,
} from "@whittle/core";
import type { SketchTool } from "../state/store";
import type { SketchPointerEvent } from "./Viewport";

export interface SnapInfo {
  p: Vec2;
  kind: "grid" | "end" | "mid" | "center" | "origin" | "align" | "free";
}

export interface DimField {
  key: "a" | "b";
  label: string;
  value: number;
  /** Anchor in sketch coordinates where the field is drawn. */
  at: Vec2;
}

export interface SketchUIState {
  preview: { pts: Vec2[]; closed: boolean }[];
  guides: [Vec2, Vec2][];
  snap: SnapInfo | null;
  dims: DimField[];
  hoverEntity: Id | null;
  cursor: Vec2 | null;
  step: number; // 0 = waiting for first point
}

export interface SketchEnv {
  pixelSize(): number;
  gridSpacing(): number;
  entities(): SketchEntity[];
  evaluator(): Evaluator;
  /** Add a shape; `select` selects it and switches back to the Select tool. */
  add(e: SketchEntity, select?: boolean): void;
  select(id: Id | null): void;
  selected(): Id | null;
  move(id: Id, dx: number, dy: number, live: boolean): void;
  emit(s: SketchUIState): void;
}

const fmt = (n: number) => String(Math.round(n * 1000) / 1000);

export class SketchController {
  private tool: SketchTool = "select";
  private points: Vec2[] = [];
  private cursor: Vec2 | null = null;
  private snap: SnapInfo | null = null;
  private guides: [Vec2, Vec2][] = [];
  private typed: { a?: number; b?: number } = {};
  private downAt: Vec2 | null = null;
  private dragging: { id: Id; last: Vec2; moved: boolean } | null = null;
  private hoverEntity: Id | null = null;
  private resolvedCache: ResolvedEntity[] = [];

  constructor(private env: SketchEnv) {}

  setTool(tool: SketchTool) {
    if (tool === this.tool) return;
    this.tool = tool;
    this.reset();
  }

  reset() {
    this.points = [];
    this.typed = {};
    this.downAt = null;
    this.dragging = null;
    this.publish();
  }

  get busy() {
    return this.points.length > 0;
  }

  /** Typed dimension from the overlay input. */
  setTyped(key: "a" | "b", value: number | undefined) {
    this.typed[key] = value;
    this.publish();
  }

  private resolved(): ResolvedEntity[] {
    const ev = this.env.evaluator();
    const out: ResolvedEntity[] = [];
    for (const e of this.env.entities()) {
      try {
        out.push(resolveEntity(e, ev));
      } catch {
        /* invalid entities are skipped for snapping */
      }
    }
    this.resolvedCache = out;
    return out;
  }

  /* ───────────────────────── Snapping ───────────────────────── */

  private snapPoint(raw: Vec2, free: boolean): SnapInfo {
    if (free) return { p: raw, kind: "free" };
    const px = this.env.pixelSize();
    const tol = 10 * px;
    let best: SnapInfo | null = null;
    let bestD = tol;
    const cands: SnapInfo[] = [{ p: [0, 0], kind: "origin" }];
    for (const r of this.resolved()) {
      if (this.dragging && r.id === this.dragging.id) continue;
      for (const s of entitySnapPoints(r)) cands.push({ p: s.p, kind: s.kind });
    }
    for (const p of this.points) cands.push({ p, kind: "end" });
    for (const c of cands) {
      const d = Math.hypot(c.p[0] - raw[0], c.p[1] - raw[1]);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    this.guides = [];
    if (best) return best;

    // Horizontal / vertical alignment with existing points, otherwise the grid.
    const atol = 6 * px;
    const alignX = cands.find((c) => Math.abs(c.p[0] - raw[0]) < atol);
    const alignY = cands.find((c) => Math.abs(c.p[1] - raw[1]) < atol);
    const g = this.env.gridSpacing() / 2;
    const x = alignX ? alignX.p[0] : Math.round(raw[0] / g) * g;
    const y = alignY ? alignY.p[1] : Math.round(raw[1] / g) * g;
    if (alignX) this.guides.push([alignX.p, [x, y]]);
    if (alignY) this.guides.push([alignY.p, [x, y]]);
    return { p: [x, y], kind: alignX || alignY ? "align" : "grid" };
  }

  /* ───────────────────────── Shape construction ───────────────────────── */

  /** The second point, adjusted by any typed dimensions. */
  private secondPoint(a: Vec2, b: Vec2): Vec2 {
    const t = this.typed;
    switch (this.tool) {
      case "rect": {
        const sx = Math.sign(b[0] - a[0]) || 1;
        const sy = Math.sign(b[1] - a[1]) || 1;
        return [t.a !== undefined ? a[0] + sx * t.a : b[0], t.b !== undefined ? a[1] + sy * t.b : b[1]];
      }
      case "ellipse": {
        const sx = Math.sign(b[0] - a[0]) || 1;
        const sy = Math.sign(b[1] - a[1]) || 1;
        return [t.a !== undefined ? a[0] + sx * t.a : b[0], t.b !== undefined ? a[1] + sy * t.b : b[1]];
      }
      case "circle":
      case "gear":
      case "polygon": {
        const r = t.a !== undefined ? (this.tool === "polygon" ? t.a : t.a / 2) : null;
        if (r === null) return b;
        const ang = Math.atan2(b[1] - a[1], b[0] - a[0]) || 0;
        return [a[0] + r * Math.cos(ang), a[1] + r * Math.sin(ang)];
      }
      case "slot":
      case "path":
      case "polyline": {
        if (t.a === undefined && t.b === undefined) return b;
        const len = t.a ?? Math.hypot(b[0] - a[0], b[1] - a[1]);
        const ang = t.b !== undefined ? (t.b * Math.PI) / 180 : Math.atan2(b[1] - a[1], b[0] - a[0]);
        return [a[0] + len * Math.cos(ang), a[1] + len * Math.sin(ang)];
      }
      default:
        return b;
    }
  }

  private previewShapes(): { pts: Vec2[]; closed: boolean }[] {
    const c = this.cursor;
    if (!c || this.points.length === 0 || this.tool === "select" || this.tool === "text") return [];
    const a = this.points[0]!;
    if (this.multi) {
      const last = this.points[this.points.length - 1]!;
      return [{ pts: [...this.points, this.secondPoint(last, c)], closed: false }];
    }
    const b = this.secondPoint(a, c);
    const e = makeEntity(this.tool as EntityType, a, b);
    try {
      return [{ pts: entityOutline(resolveEntity(e, this.env.evaluator())), closed: true }];
    } catch {
      return [];
    }
  }

  private dims(): DimField[] {
    const c = this.cursor;
    if (!c || this.points.length === 0) return [];
    const a = this.multi ? this.points[this.points.length - 1]! : this.points[0]!;
    const b = this.secondPoint(a, c);
    switch (this.tool) {
      case "rect":
        return [
          { key: "a", label: "W", value: Math.abs(b[0] - a[0]), at: [(a[0] + b[0]) / 2, Math.min(a[1], b[1])] },
          { key: "b", label: "H", value: Math.abs(b[1] - a[1]), at: [Math.max(a[0], b[0]), (a[1] + b[1]) / 2] },
        ];
      case "circle":
        return [{ key: "a", label: "\u00d8", value: 2 * Math.hypot(b[0] - a[0], b[1] - a[1]), at: b }];
      case "gear":
        return [{ key: "a", label: "Pitch Ø", value: 2 * Math.hypot(b[0] - a[0], b[1] - a[1]), at: b }];
      case "ellipse":
        return [
          { key: "a", label: "RX", value: Math.abs(b[0] - a[0]), at: [(a[0] + b[0]) / 2, a[1]] },
          { key: "b", label: "RY", value: Math.abs(b[1] - a[1]), at: [a[0], (a[1] + b[1]) / 2] },
        ];
      case "polygon":
        return [{ key: "a", label: "R", value: Math.hypot(b[0] - a[0], b[1] - a[1]), at: b }];
      case "slot":
      case "path":
      case "polyline": {
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const ang = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
        return [
          { key: "a", label: "L", value: len, at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] },
          { key: "b", label: "\u2220", value: ang, at: b },
        ];
      }
      default:
        return [];
    }
  }

  private publish() {
    this.env.emit({
      preview: this.previewShapes(),
      guides: this.guides,
      snap: this.tool === "select" && !this.dragging ? null : this.snap,
      dims: this.dims(),
      hoverEntity: this.hoverEntity,
      cursor: this.cursor,
      step: this.points.length,
    });
  }

  private commitTwoPoint(b: Vec2) {
    const a = this.points[0]!;
    const end = this.secondPoint(a, b);
    if (Math.hypot(end[0] - a[0], end[1] - a[1]) < 1e-6) return;
    if ((this.tool === "rect" || this.tool === "ellipse") && (Math.abs(end[0] - a[0]) < 1e-6 || Math.abs(end[1] - a[1]) < 1e-6)) return;
    if (this.tool === "select" || this.multi || this.tool === "text") return;
    this.env.add(makeEntity(this.tool as EntityType, a, end));
    this.points = [];
    this.typed = {};
  }

  /** Tools that place many points (outlines and open paths). */
  private get multi() {
    return this.tool === "polyline" || this.tool === "path";
  }

  private commitPolyline() {
    const open = this.tool === "path";
    if (this.points.length >= (open ? 2 : 3)) {
      const e = makeEntity("polyline", this.points[0]!, this.points[1]!);
      if (e.type === "polyline") {
        e.points = this.points.map(([x, y]) => [fmt(x), fmt(y)]);
        if (open) e.open = true;
      }
      this.env.add(e);
    }
    this.points = [];
    this.typed = {};
  }

  /* ───────────────────────── Events ───────────────────────── */

  private entityAt(p: Vec2): Id | null {
    const tol = 7 * this.env.pixelSize();
    let best: { d: number; id: Id } | null = null;
    for (const r of this.resolvedCache.length ? this.resolvedCache : this.resolved()) {
      const pts = entityOutline(r, 48);
      const segs = r.type === "polyline" && r.open ? pts.length - 1 : pts.length;
      for (let i = 0; i < segs; i++) {
        const a = pts[i]!;
        const b = pts[(i + 1) % pts.length]!;
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const l2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
        const d = Math.hypot(a[0] + dx * t - p[0], a[1] + dy * t - p[1]);
        if (d < tol && (!best || d < best.d)) best = { d, id: r.id };
      }
    }
    return best?.id ?? null;
  }

  pointer(e: SketchPointerEvent) {
    if (e.type === "leave") {
      this.cursor = null;
      this.publish();
      return;
    }
    if (this.tool === "select") return this.selectPointer(e);
    this.snap = this.snapPoint(e.p, e.alt);
    this.cursor = this.snap.p;

    if (e.type === "down") {
      this.downAt = this.cursor;
      if (this.tool === "text") {
        // One click places the text; the panel then asks what it says.
        const size = Math.max(1, Math.round(this.env.gridSpacing()));
        const t = makeEntity("text", this.cursor, [this.cursor[0], this.cursor[1] + size]);
        this.env.add(t, true);
        this.publish();
        return;
      }
      if (this.multi) {
        const first = this.points[0];
        const last = this.points[this.points.length - 1];
        const tol = 10 * this.env.pixelSize();
        const near = (p: Vec2 | undefined) => !!p && Math.hypot(p[0] - this.cursor![0], p[1] - this.cursor![1]) < tol;
        // Outlines close on their first point; paths finish when the last point is clicked again.
        if ((this.tool === "polyline" && this.points.length >= 3 && near(first)) || (this.tool === "path" && this.points.length >= 2 && near(last))) {
          this.commitPolyline();
        } else {
          const last = this.points[this.points.length - 1];
          const p = last ? this.secondPoint(last, this.cursor) : this.cursor;
          this.points.push(p);
          this.typed = {};
        }
      } else if (this.points.length === 0) {
        this.points = [this.cursor];
      } else {
        this.commitTwoPoint(this.cursor);
      }
    } else if (e.type === "up") {
      // Press-drag-release also works for two-point tools.
      const d = this.downAt;
      if (d && !this.multi && this.points.length === 1) {
        const moved = Math.hypot(d[0] - this.cursor[0], d[1] - this.cursor[1]) > 4 * this.env.pixelSize();
        if (moved) this.commitTwoPoint(this.cursor);
      }
      this.downAt = null;
    }
    this.publish();
  }

  private selectPointer(e: SketchPointerEvent) {
    this.cursor = e.p;
    if (e.type === "move") {
      if (this.dragging) {
        this.snap = this.snapPoint(e.p, e.alt);
        const p = this.snap.p;
        const dx = p[0] - this.dragging.last[0];
        const dy = p[1] - this.dragging.last[1];
        if (dx || dy) {
          this.env.move(this.dragging.id, dx, dy, true);
          this.dragging.last = p;
          this.dragging.moved = true;
        }
      } else {
        this.resolvedCache = [];
        this.hoverEntity = this.entityAt(e.p);
      }
    } else if (e.type === "down") {
      const hit = this.entityAt(e.p);
      this.env.select(hit);
      if (hit) {
        const s = this.snapPoint(e.p, true);
        this.dragging = { id: hit, last: s.p, moved: false };
      }
    } else if (e.type === "up") {
      this.dragging = null;
      this.resolvedCache = [];
    }
    this.publish();
  }

  /** Keyboard while sketching. Returns true when handled. */
  key(e: KeyboardEvent): boolean {
    if (e.key === "Escape") {
      if (this.points.length) {
        if (this.multi && this.points.length >= (this.tool === "path" ? 2 : 3)) this.commitPolyline();
        else this.reset();
        this.publish();
        return true;
      }
      return false;
    }
    if (e.key === "Enter" && this.multi && this.points.length >= (this.tool === "path" ? 2 : 3)) {
      this.commitPolyline();
      this.publish();
      return true;
    }
    if (e.key === "Enter" && this.points.length === 1 && this.cursor && !this.multi) {
      this.commitTwoPoint(this.cursor);
      this.publish();
      return true;
    }
    if (e.key === "Backspace" && this.multi && this.points.length) {
      this.points.pop();
      this.publish();
      return true;
    }
    return false;
  }
}