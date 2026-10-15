/**
 * Sketch tool controller: turns pointer events on the sketch plane into
 * shapes. Every tool works with two clicks (or press-drag-release), snaps to
 * the grid, to existing points and to horizontal/vertical alignments, and
 * accepts typed dimensions (just start typing a number).
 */
import {
  type EntityType,
  type Evaluator,
  type GeomResolved,
  type Id,
  type ResolvedEntity,
  type SketchEntity,
  type Vec2,
  arcPoints,
  entityOutline,
  entitySnapPoints,
  geomOutline,
  makeEntity,
  polylinePath,
  resolveEntity,
} from "@whittle/core";
import type { SketchTool } from "../state/store";
import type { SketchPointerEvent } from "./Viewport";

export interface SnapInfo {
  p: Vec2;
  kind: "grid" | "end" | "mid" | "center" | "origin" | "align" | "free";
  /** The solver point (or "origin") snapped to: new geometry joins it instead of just touching it. */
  ref?: Id;
}

/** Tools that draw constraint-driven geometry. */
const GEOM_TOOLS = new Set<SketchTool>(["segment", "arc", "pcircle"]);

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
  /** Constraint-driven geometry of the open sketch, at its solved positions. */
  geometry(): GeomResolved[];
  addLines(pts: (Vec2 | Id)[], closed: boolean): void;
  addArc(a: Vec2 | Id, b: Vec2 | Id, through: Vec2): void;
  addCircle(c: Vec2 | Id, r: number): void;
  trim(id: Id, p: Vec2): void;
  extend(id: Id, p: Vec2): void;
  /** Select geometry (null clears); `additive` adds to / removes from the selection. */
  selectGeom(id: Id | null, additive: boolean): void;
  selectedGeom(): Id[];
  moveGeom(ids: Id[], dx: number, dy: number): void;
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
  private dragging: { id: Id; last: Vec2; moved: boolean; geom?: Id[] } | null = null;
  /** Solver points the placed points snapped to (parallel to `points`). */
  private refs: (Id | undefined)[] = [];
  private hoverEntity: Id | null = null;
  private resolvedCache: ResolvedEntity[] = [];
  /** Outline/path tools: "arc" points (parallel to `points`), arc mode, and an arc's end awaiting its middle. */
  private arcFlags: boolean[] = [];
  private arcMode = false;
  private arcEnd: Vec2 | null = null;

  constructor(private env: SketchEnv) {}

  setTool(tool: SketchTool) {
    if (tool === this.tool) return;
    this.tool = tool;
    this.reset();
  }

  reset() {
    this.points = [];
    this.refs = [];
    this.arcFlags = [];
    this.arcMode = false;
    this.arcEnd = null;
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
    const cands: SnapInfo[] = [{ p: [0, 0], kind: "origin", ref: "origin" }];
    // Solver points first, so geometry joins them rather than just landing on them.
    const moving = new Set(this.dragging?.geom ?? []);
    for (const g of this.env.geometry()) {
      if (g.type === "point" && !moving.has(g.id)) cands.push({ p: g.p, kind: g.construction ? "center" : "end", ref: g.id });
      if (g.type === "line" && !moving.has(g.id)) cands.push({ p: [(g.a[0] + g.b[0]) / 2, (g.a[1] + g.b[1]) / 2], kind: "mid" });
    }
    for (const r of this.resolved()) {
      if (this.dragging && r.id === this.dragging.id) continue;
      for (const s of entitySnapPoints(r)) cands.push({ p: s.p, kind: s.kind });
    }
    this.points.forEach((p, i) => cands.push({ p, kind: "end", ref: this.refs[i] }));
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
      case "pcircle":
      case "gear":
      case "polygon": {
        const r = t.a !== undefined ? (this.tool === "polygon" ? t.a : t.a / 2) : null;
        if (r === null) return b;
        const ang = Math.atan2(b[1] - a[1], b[0] - a[0]) || 0;
        return [a[0] + r * Math.cos(ang), a[1] + r * Math.sin(ang)];
      }
      case "slot":
      case "segment":
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
    if (this.tool === "segment") return [{ pts: [...this.points, this.secondPoint(this.points[this.points.length - 1]!, c)], closed: false }];
    if (this.tool === "pcircle") {
      const r = Math.hypot(this.secondPoint(a, c)[0] - a[0], this.secondPoint(a, c)[1] - a[1]);
      return r > 0 ? [{ pts: geomOutline({ id: "", type: "circle", c: a, r, construction: false }), closed: true }] : [];
    }
    if (this.tool === "arc") {
      if (this.points.length === 1) return [{ pts: [a, c], closed: false }];
      return [{ pts: [...arcPoints(a, c, this.points[1]!, 32), this.points[1]!], closed: false }];
    }
    if (this.multi) {
      const last = this.points[this.points.length - 1]!;
      const done = polylinePath(this.points, this.arcFlags, false);
      const next = this.arcEnd ? polylinePath([last, c, this.arcEnd], [false, true, false], false) : [last, this.secondPoint(last, c)];
      return [{ pts: [...done, ...next.slice(1)], closed: false }];
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
    const a = this.multi || this.tool === "segment" ? this.points[this.points.length - 1]! : this.points[0]!;
    const b = this.secondPoint(a, c);
    switch (this.tool) {
      case "rect":
        return [
          { key: "a", label: "W", value: Math.abs(b[0] - a[0]), at: [(a[0] + b[0]) / 2, Math.min(a[1], b[1])] },
          { key: "b", label: "H", value: Math.abs(b[1] - a[1]), at: [Math.max(a[0], b[0]), (a[1] + b[1]) / 2] },
        ];
      case "circle":
      case "pcircle":
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
      case "segment":
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
        e.points = this.points.map(([x, y], i) => (this.arcFlags[i] ? [fmt(x), fmt(y), "arc"] : [fmt(x), fmt(y)]));
        if (open) e.open = true;
      }
      this.env.add(e);
    }
    this.points = [];
    this.arcFlags = [];
    this.arcEnd = null;
    this.typed = {};
  }

  /** Outline/path in arc mode: the first click sets the arc's end, the second a point on the arc. */
  private arcClick(p: Vec2, first: Vec2 | undefined, nearFirst: boolean) {
    if (!this.arcEnd) {
      this.arcEnd = nearFirst && this.tool === "polyline" && this.points.length >= 2 ? first! : p;
      return;
    }
    const closing = this.arcEnd === first;
    this.points.push(p);
    this.arcFlags.push(true);
    if (closing) return this.commitPolyline();
    this.points.push(this.arcEnd);
    this.arcFlags.push(false);
    this.arcEnd = null;
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

  /** Constraint-driven geometry under the pointer: points first, then curves (and the origin and axes). */
  private geomAt(p: Vec2, curvesOnly = false): Id | null {
    const tol = 7 * this.env.pixelSize();
    const geo = this.env.geometry();
    const near = (q: Vec2) => Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (!curvesOnly) {
      let best: { d: number; id: Id } | null = near([0, 0]) < tol ? { d: near([0, 0]), id: "origin" } : null;
      for (const g of geo) if (g.type === "point" && near(g.p) < (best?.d ?? tol)) best = { d: near(g.p), id: g.id };
      if (best) return best.id;
    }
    let best: { d: number; id: Id } | null = null;
    for (const g of geo) {
      if (g.type === "point") continue;
      const pts = geomOutline(g, 96);
      for (let i = 0; i + 1 < pts.length; i++) {
        const d = segDist(p, pts[i]!, pts[i + 1]!);
        if (d < tol && (!best || d < best.d)) best = { d, id: g.id };
      }
    }
    if (best || curvesOnly) return best?.id ?? null;
    if (Math.abs(p[1]) < tol) return "xaxis";
    if (Math.abs(p[0]) < tol) return "yaxis";
    return null;
  }

  /** A click with the Line, Arc or Circle tool. */
  private geomClick() {
    const c = this.cursor!;
    const ref = this.snap?.ref;
    const tol = 10 * this.env.pixelSize();
    const near = (p: Vec2 | undefined) => !!p && Math.hypot(p[0] - c[0], p[1] - c[1]) < tol;
    const typed = this.typed.a !== undefined || this.typed.b !== undefined;
    if (this.tool === "segment") {
      const n = this.points.length;
      // Clicking the first point closes the outline; clicking the last point again finishes an open chain.
      if (n >= 3 && near(this.points[0])) return this.commitSegments(true);
      if (n >= 2 && near(this.points[n - 1])) return this.commitSegments(false);
      this.points.push(n ? this.secondPoint(this.points[n - 1]!, c) : c);
      this.refs.push(typed ? undefined : ref);
      this.typed = {};
      return;
    }
    const p = this.points.length ? this.secondPoint(this.points[0]!, c) : c;
    this.points.push(p);
    this.refs.push(typed ? undefined : ref);
    const at = (i: number) => this.refs[i] ?? this.points[i]!;
    if (this.tool === "pcircle" && this.points.length === 2) {
      this.env.addCircle(at(0), Math.hypot(p[0] - this.points[0]![0], p[1] - this.points[0]![1]));
      this.reset();
    } else if (this.tool === "arc" && this.points.length === 3) {
      // Start, end, then a point the arc passes through.
      this.env.addArc(at(0), at(1), this.points[2]!);
      this.reset();
    }
    this.typed = {};
  }

  private commitSegments(closed: boolean) {
    if (this.points.length >= 2) this.env.addLines(this.points.map((p, i) => this.refs[i] ?? p), closed && this.points.length >= 3);
    this.reset();
  }

  pointer(e: SketchPointerEvent) {
    if (e.type === "leave") {
      this.cursor = null;
      this.publish();
      return;
    }
    if (this.tool === "select") return this.selectPointer(e);
    if (this.tool === "trim" || this.tool === "extend") {
      this.cursor = e.p;
      this.snap = null;
      const hit = this.geomAt(e.p, true);
      this.hoverEntity = hit;
      if (e.type === "down" && hit) this.env[this.tool](hit, e.p);
      this.publish();
      return;
    }
    this.snap = this.snapPoint(e.p, e.alt);
    this.cursor = this.snap.p;
    if (GEOM_TOOLS.has(this.tool)) {
      if (e.type === "down") this.geomClick();
      this.publish();
      return;
    }

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
        if (this.arcMode && this.points.length) {
          this.arcClick(this.cursor, first, near(first));
        } else if ((this.tool === "polyline" && this.points.length >= 3 && near(first)) || (this.tool === "path" && this.points.length >= 2 && near(last))) {
          this.commitPolyline();
        } else {
          const last = this.points[this.points.length - 1];
          const p = last ? this.secondPoint(last, this.cursor) : this.cursor;
          this.points.push(p);
          this.arcFlags.push(false);
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
      if (this.dragging?.geom) {
        // Solver geometry moves freely; the constraints decide where it settles.
        const dx = e.p[0] - this.dragging.last[0];
        const dy = e.p[1] - this.dragging.last[1];
        if (Math.hypot(dx, dy) > 2 * this.env.pixelSize() || this.dragging.moved) {
          this.env.moveGeom(this.dragging.geom, dx, dy);
          this.dragging.last = e.p;
          this.dragging.moved = true;
        }
      } else if (this.dragging) {
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
        this.hoverEntity = this.geomAt(e.p) ?? this.entityAt(e.p);
      }
    } else if (e.type === "down") {
      const g = this.geomAt(e.p);
      if (g) {
        const sel = this.env.selectedGeom();
        // Pressing on something already selected keeps the selection, so several items drag together.
        if (e.shift || !sel.includes(g)) this.env.selectGeom(g, e.shift);
        this.env.select(null);
        const moving = this.env.selectedGeom().includes(g) && !e.shift ? this.env.selectedGeom() : [g];
        if (!["origin", "xaxis", "yaxis"].includes(g)) this.dragging = { id: g, last: e.p, moved: false, geom: moving };
        this.publish();
        return;
      }
      const hit = this.entityAt(e.p);
      this.env.select(hit);
      if (!e.shift || hit) this.env.selectGeom(null, false);
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
    // A toggles arcs while drawing an outline or path (the A shortcut picks the Path tool otherwise).
    if (this.multi && this.points.length && e.key.toLowerCase() === "a" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      this.arcMode = !this.arcMode;
      if (!this.arcMode) this.arcEnd = null;
      this.publish();
      return true;
    }
    if (this.tool === "segment" && this.points.length && (e.key === "Escape" || e.key === "Enter")) {
      this.commitSegments(false);
      return true;
    }
    if (GEOM_TOOLS.has(this.tool) && this.points.length && (e.key === "Escape" || e.key === "Backspace")) {
      if (e.key === "Escape") this.reset();
      else {
        this.points.pop();
        this.refs.pop();
        this.publish();
      }
      return true;
    }
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
      if (this.arcEnd) this.arcEnd = null;
      else {
        this.points.pop();
        this.arcFlags.pop();
        // An arc's middle point goes with its end.
        if (this.arcFlags[this.arcFlags.length - 1]) {
          this.points.pop();
          this.arcFlags.pop();
        }
      }
      this.publish();
      return true;
    }
    return false;
  }
}
function segDist(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(a[0] + dx * t - p[0], a[1] + dy * t - p[1]);
}
