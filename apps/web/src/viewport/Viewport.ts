/**
 * The viewport engine: plain, imperative Three.js (no React in the render
 * loop). React talks to it through a narrow API and callbacks.
 *
 * - Z-up world, turntable navigation that never rolls the horizon.
 * - Renders on demand only (idle = 0% GPU).
 * - Picking: raycast for faces, screen-space distance for edges (with
 *   occlusion test), so edges are easy to hit even when thin.
 */
import { type CameraState, touchGuard, viewportRef } from "./current";
import * as THREE from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { BodyMeta, Id, OriginPlane, SketchImage, Vec2, Vec3 } from "@whittle/core";
import type { BodyResult, SketchFrame } from "@whittle/kernel";
import type { Pick, ViewSettings } from "../state/store";
import { lookById } from "./looks";
import { VIEWPORT_THEMES, type ViewportTheme } from "./theme";
import { type NavPreset, navAction } from "../state/prefs";

/** Same thing picked, wherever on it the click landed. */
const samePick = (a: Pick, b: Pick) => JSON.stringify({ ...a, at: 0 }) === JSON.stringify({ ...b, at: 0 });

export type CubeView = "front" | "back" | "left" | "right" | "top" | "bottom" | "iso";

export interface PickFilter {
  faces: boolean;
  edges: boolean;
  planes: boolean;
  sketches: boolean;
}

export interface SketchDrawable {
  id: Id;
  frame: SketchFrame;
  active: boolean;
  /** Triangles of the solid regions (world space), drawn as a soft fill. */
  fill?: Float32Array;
  /** Each enclosed area on its own, pickable as a profile; `at` is a point inside it (sketch coordinates). */
  regions?: { fill: Float32Array; selected: boolean; hovered: boolean }[];
  /** The profile of the feature being edited: its areas show and pick through the bodies in front. */
  profile?: boolean;
  shapes: { id: Id; pts: Vec2[]; closed: boolean; construction: boolean; selected: boolean; hovered: boolean; tone?: SketchTone }[];
  /** Solver points of the sketch being edited. */
  markers?: { p: Vec2; tone: SketchTone; selected: boolean; hovered: boolean }[];
}

/** How well constraint-driven geometry is defined: can still move, fully defined, or in a conflict. */
export type SketchTone = "free" | "defined" | "bad";

export interface SketchPointerEvent {
  type: "move" | "down" | "up" | "leave";
  p: Vec2;
  button: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  screen: Vec2;
  /** The pointer in window coordinates (for picking the 3D model under it). */
  client: Vec2;
}

export interface ViewportCallbacks {
  onHover(p: Pick | null): void;
  onClick(p: Pick | null, additive: boolean): void;
  onDoubleClick(p: Pick | null): void;
  onSketchPointer(e: SketchPointerEvent): void;
  onCamera(): void;
  /** Right-click without dragging: open the radial menu. */
  onContext(p: Pick | null, screen: Vec2): void;
  /** Rubber-band selection finished: what was inside (drag right) or touched (drag left). */
  onBoxSelect?(picks: Pick[], additive: boolean): void;
}

interface BodyView {
  id: Id;
  data: BodyResult;
  mesh: THREE.Mesh;
  edges: LineSegments2;
  /** Section-view cap: back faces drawn flat so cut bodies look solid. */
  cap?: THREE.Mesh;
  visible: boolean;
}

const OVERHANG_COS = Math.cos((45 * Math.PI) / 180);
const DRAFT_NONE = (0.1 * Math.PI) / 180;
const DRAFT_LOW = (1 * Math.PI) / 180;

/**
 * Zebra stripes: replace the lit color with black and white bands of the
 * reflected view direction. Smooth (tangent / curvature continuous) joins
 * show unbroken stripes; kinks show as jumps.
 */
function zebra(mat: THREE.MeshStandardMaterial) {
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <dithering_fragment>",
      `#include <dithering_fragment>
      vec3 zr = reflect(normalize(vViewPosition), normalize(normal));
      float zs = step(0.5, fract(atan(zr.y, zr.x) * 3.0));
      gl_FragColor.rgb = mix(vec3(0.06), vec3(0.94), zs);`,
    );
  };
  mat.customProgramCacheKey = () => "zebra";
}

const tmpV = new THREE.Vector3();

/** Preview tints for the feature being edited, by its body operation. */
const GHOST_COLORS: Record<string, string> = { new: "#3d8bfd", join: "#2fbf71", cut: "#e5484d", intersect: "#f5a524" };
const ease = (t: number) => 1 - Math.pow(1 - t, 3);

/** Turntable orbit around world Z. Represents any view, including top/bottom. */
class Turntable {
  target = new THREE.Vector3();
  distance = 300;
  theta = -Math.PI / 4; // azimuth around Z
  phi = Math.PI / 3; // polar angle from +Z

  apply(camera: THREE.PerspectiveCamera, ortho?: THREE.OrthographicCamera) {
    const sp = Math.sin(this.phi);
    const cp = Math.cos(this.phi);
    const ct = Math.cos(this.theta);
    const st = Math.sin(this.theta);
    camera.position.set(this.target.x + this.distance * sp * ct, this.target.y + this.distance * sp * st, this.target.z + this.distance * cp);
    camera.up.set(-cp * ct, -cp * st, sp);
    camera.lookAt(this.target);
    camera.near = Math.max(0.01, this.distance / 2000);
    camera.far = this.distance * 200;
    camera.updateProjectionMatrix();
    if (ortho) {
      // Same framing as the perspective view at the target distance.
      const h = this.distance * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      const w = h * camera.aspect;
      ortho.left = -w;
      ortho.right = w;
      ortho.top = h;
      ortho.bottom = -h;
      ortho.position.copy(camera.position);
      ortho.up.copy(camera.up);
      ortho.lookAt(this.target);
      ortho.near = -this.distance * 50;
      ortho.far = this.distance * 200;
      ortho.updateProjectionMatrix();
    }
  }

  /** View direction (from target to camera) to theta/phi; `up` disambiguates top/bottom views. */
  static anglesFor(dir: THREE.Vector3, up?: THREE.Vector3): { theta: number; phi: number } {
    const d = dir.clone().normalize();
    const phi = Math.acos(THREE.MathUtils.clamp(d.z, -1, 1));
    let theta: number;
    if (Math.abs(Math.sin(phi)) < 1e-4) {
      // Looking straight along Z: choose theta so that the camera "up" matches.
      const u = up ?? new THREE.Vector3(0, 1, 0);
      const cp = Math.cos(phi);
      theta = Math.atan2(-u.y / cp, -u.x / cp);
    } else theta = Math.atan2(d.y, d.x);
    return { theta, phi };
  }
}

export class Viewport {
  readonly renderer: THREE.WebGLRenderer;
  private persp = new THREE.PerspectiveCamera(32, 1, 0.1, 100000);
  private orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 100000);
  private view: ViewSettings = { display: "edges", section: null, analysis: null, grid: true, ortho: false };
  private lastBodies: { list: BodyResult[]; meta: Record<Id, BodyMeta> } = { list: [], meta: {} };
  private measureGroup = new THREE.Group();
  private flagGroup = new THREE.Group();
  private fillGroup = new THREE.Group();
  private shadow: THREE.Mesh;
  private clip = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private scene = new THREE.Scene();
  private orbit = new Turntable();
  private theme: ViewportTheme = VIEWPORT_THEMES.graphite;
  private bodies = new Map<Id, BodyView>();
  private pickBodies: BodyView[] = [];
  private world = new THREE.Group();
  private overlay = new THREE.Group();
  private sketchGroup = new THREE.Group();
  private imageGroup = new THREE.Group();
  private textures = new Map<string, THREE.Texture>();
  private previewGroup = new THREE.Group();
  private highlightGroup = new THREE.Group();
  private grid = new THREE.Group();
  /** World Z, drawn with the grid while modelling (in a sketch the grid's own axes take over). */
  private axisZ = new THREE.Group();
  private planes = new THREE.Group();
  /** User-made construction planes: always shown faintly, pickable when choosing a sketch plane. */
  private cplanes = new THREE.Group();
  /** Key light above and left of the camera, and a soft fill from the camera: faces read apart at any angle. */
  private headlight = new THREE.DirectionalLight(0xffffff, 1.9);
  private fill = new THREE.DirectionalLight(0xffffff, 0.55);
  private hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.3);
  private raycaster = new THREE.Raycaster();
  private lineMaterials = new Set<LineMaterial>();
  private frame = 0;
  private gridStep = 0;
  private sketchFrame: SketchFrame | null = null;
  private filter: PickFilter = { faces: true, edges: true, planes: false, sketches: true };
  private sketchHit: { id: Id; pts: Vec3[][] }[] = [];
  /** Pickable sketch areas (profiles). */
  private regionMeshes: THREE.Mesh[] = [];
  private anim: { from: Turntable; to: Turntable; t0: number; dur: number } | null = null;
  private drag: { x: number; y: number; button: number; moved: boolean; mode: "orbit" | "pan" | "zoom" | "none" } | null = null;
  private nav: NavPreset = "whittle";
  private invertZoom = false;
  private lastHoverKey = "";
  private resizeObs: ResizeObserver;
  private disposed = false;
  private size = new THREE.Vector2(1, 1);
  private sceneRadius = 100;

  /** The active camera (perspective or orthographic). */
  get camera(): THREE.PerspectiveCamera | THREE.OrthographicCamera {
    return this.view.ortho ? this.orthoCam : this.persp;
  }

  private applyOrbit() {
    this.orbit.apply(this.persp, this.orthoCam);
  }

  constructor(
    private container: HTMLElement,
    private cb: ViewportCallbacks,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.localClippingEnabled = true;
    this.shadow = this.makeShadow();
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.className = "viewport-canvas";
    this.renderer.domElement.tabIndex = 0;
    this.renderer.domElement.setAttribute("role", "application");
    this.renderer.domElement.setAttribute("aria-label", "3D model. Drag to orbit, scroll or pinch to zoom, right-drag or two fingers to pan.");

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    // The room is built Y-up; turn it so its ceiling lights sit above a Z-up model, not behind it.
    this.scene.environmentRotation.set(Math.PI / 2, 0, 0);

    this.persp.up.set(0, 0, 1);
    this.scene.add(this.shadow, this.imageGroup, this.world, this.fillGroup, this.sketchGroup, this.previewGroup, this.overlay, this.highlightGroup, this.measureGroup, this.flagGroup, this.grid, this.axisZ, this.planes, this.cplanes, this.hemi, this.persp, this.orthoCam);
    // Each light rides with its camera and aims at the camera itself, so its offset is a direction in view space.
    // (A light's target is the world origin unless it's parented too, which makes every light a plain headlight.)
    const rig = (cam: THREE.Camera, key: THREE.DirectionalLight, fill: THREE.DirectionalLight) => {
      key.position.set(-0.8, 0.85, 0.6);
      fill.position.set(0.2, -0.1, 1);
      cam.add(key, key.target, fill, fill.target);
    };
    rig(this.persp, this.headlight, this.fill);
    rig(this.orthoCam, this.headlight.clone(), this.fill.clone());
    this.grid.matrixAutoUpdate = false;
    this.planes.visible = false;
    this.setTheme("graphite");

    this.orbit.distance = 320;
    this.applyOrbit();

    const el = this.renderer.domElement;
    el.addEventListener("pointerdown", this.onPointerDown);
    el.addEventListener("pointermove", this.onPointerMove);
    el.addEventListener("pointerup", this.onPointerUp);
    el.addEventListener("pointercancel", this.onPointerCancel);
    el.style.touchAction = "none"; // fingers navigate the model; the page never scrolls or zooms under them
    el.addEventListener("pointerleave", this.onPointerLeave);
    el.addEventListener("wheel", this.onWheel, { passive: false });
    el.addEventListener("dblclick", this.onDblClick);
    el.addEventListener("contextmenu", (e) => e.preventDefault());

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(container);
    this.resize();
    viewportRef.current = this;
  }

  /** The camera as plain numbers: what a named view stores. */
  getCamera(): CameraState {
    return { target: this.orbit.target.toArray() as [number, number, number], distance: this.orbit.distance, theta: this.orbit.theta, phi: this.orbit.phi };
  }

  setCamera(c: CameraState) {
    const to = new Turntable();
    to.target.fromArray(c.target);
    to.distance = c.distance;
    to.theta = c.theta;
    to.phi = c.phi;
    this.animateTo(to);
  }

  dispose() {
    if (viewportRef.current === this) viewportRef.current = null;
    this.disposed = true;
    this.resizeObs.disconnect();
    cancelAnimationFrame(this.frame);
    // Free everything on the graphics card, not just the renderer: bodies, overlays, and the lighting textures.
    for (const child of [...this.scene.children]) this.disposeObject(child);
    this.scene.environment?.dispose();
    if (this.scene.background instanceof THREE.Texture) this.scene.background.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }

  /* ───────────────────────── Rendering ───────────────────────── */

  invalidate = () => {
    if (this.frame || this.disposed) return;
    this.frame = requestAnimationFrame(this.render);
  };

  private render = () => {
    this.frame = 0;
    if (this.anim) {
      const t = Math.min(1, (performance.now() - this.anim.t0) / this.anim.dur);
      const k = ease(t);
      const { from, to } = this.anim;
      this.orbit.target.lerpVectors(from.target, to.target, k);
      this.orbit.distance = from.distance + (to.distance - from.distance) * k;
      this.orbit.theta = from.theta + (to.theta - from.theta) * k;
      this.orbit.phi = from.phi + (to.phi - from.phi) * k;
      if (t >= 1) this.anim = null;
      this.applyOrbit();
      this.cb.onCamera();
      this.invalidate();
    }
    this.updateGrid();
    this.renderer.render(this.scene, this.camera);
  };

  private resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.size.set(w, h);
    this.renderer.setSize(w, h, false);
    this.persp.aspect = w / h;
    this.applyOrbit();
    for (const m of this.lineMaterials) m.resolution.set(w, h);
    this.invalidate();
  }

  /** Mouse mapping (see navAction) and wheel direction. */
  setNavigation(preset: NavPreset, invertZoom: boolean) {
    this.nav = preset;
    this.invertZoom = invertZoom;
  }

  setTheme(name: keyof typeof VIEWPORT_THEMES) {
    this.theme = VIEWPORT_THEMES[name];
    const c = document.createElement("canvas");
    c.width = 2;
    c.height = 256;
    const g = c.getContext("2d")!;
    const grad = g.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, this.theme.bgTop);
    grad.addColorStop(1, this.theme.bgBottom);
    g.fillStyle = grad;
    g.fillRect(0, 0, 2, 256);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    (this.scene.background as THREE.Texture | null)?.dispose();
    this.scene.background = tex;
    this.scene.environmentIntensity = this.theme.envIntensity;
    this.hemi.color.set(name === "paper" || name === "daylight" ? "#ffffff" : "#f4efe6");
    this.hemi.groundColor.set(name === "paper" || name === "daylight" ? "#b9b2a5" : "#3b3833");
    for (const b of this.bodies.values()) (b.edges.material as LineMaterial).color.set(this.theme.edge);
    (this.shadow.material as THREE.MeshBasicMaterial).opacity = name === "paper" || name === "daylight" ? 0.22 : 0.5;
    this.gridStep = 0;
    this.buildPlanes();
    this.invalidate();
  }

  private lineMat(color: string, width: number, opts: Partial<{ dashed: boolean; opacity: number; depthTest: boolean }> = {}) {
    const m = new LineMaterial({
      color: new THREE.Color(color).getHex(),
      linewidth: width,
      dashed: opts.dashed ?? false,
      dashSize: 3,
      gapSize: 2,
      transparent: (opts.opacity ?? 1) < 1,
      opacity: opts.opacity ?? 1,
      depthTest: opts.depthTest ?? true,
    });
    m.resolution.set(this.size.x, this.size.y);
    this.lineMaterials.add(m);
    return m;
  }

  private disposeObject(o: THREE.Object3D, keepGeometry = false) {
    o.traverse((x) => {
      const any = x as THREE.Mesh;
      // Face highlights borrow the body's position buffer: detach it so disposing them doesn't drop it from the GPU.
      if (x.userData.sharedPosition) any.geometry.deleteAttribute("position");
      if (!keepGeometry) any.geometry?.dispose();
      const mats = Array.isArray(any.material) ? any.material : any.material ? [any.material] : [];
      for (const m of mats) {
        if (m instanceof LineMaterial) this.lineMaterials.delete(m);
        m.dispose();
      }
    });
  }

  private clearGroup(g: THREE.Group) {
    for (const c of [...g.children]) {
      this.disposeObject(c, c.userData.sharedGeometry === true);
      g.remove(c);
    }
  }

  /* ───────────────────────── Grid & planes ───────────────────────── */

  private updateGrid() {
    const dist = this.orbit.distance;
    const raw = dist / 18;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = raw / pow >= 5 ? pow * 5 : raw / pow >= 2 ? pow * 2 : pow;
    if (step === this.gridStep) return;
    this.gridStep = step;
    this.clearGroup(this.grid);
    const n = 60;
    const minor: number[] = [];
    const major: number[] = [];
    const ext = n * step;
    for (let i = -n; i <= n; i++) {
      if (i === 0) continue;
      const arr = i % 5 === 0 ? major : minor;
      arr.push(-ext, i * step, 0, ext, i * step, 0, i * step, -ext, 0, i * step, ext, 0);
    }
    const mk = (pos: number[], color: string, opacity: number) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false, toneMapped: false });
      const l = new THREE.LineSegments(geo, mat);
      l.renderOrder = -1;
      l.raycast = () => {};
      return l;
    };
    this.grid.add(mk(minor, this.theme.gridMinor, 0.9), mk(major, this.theme.gridMajor, 1));
    this.grid.add(mk([-ext, 0, 0, ext, 0, 0], this.theme.axisX, 1), mk([0, -ext, 0, 0, ext, 0], this.theme.axisY, 1));
    this.clearGroup(this.axisZ);
    // A short stub up from the origin: enough to show which way is up without running through the model.
    this.axisZ.add(mk([0, 0, 0, 0, 0, step * 5], this.theme.axisZ, 1));
  }

  /** "Up" is shown on an empty scene only: once there is a model, a line through it is just clutter. */
  private syncAxisZ(frame = this.sketchFrame) {
    this.axisZ.visible = this.view.grid && !frame && ![...this.bodies.values()].some((b) => b.visible);
  }

  private setGridFrame(frame: SketchFrame | null) {
    const m = new THREE.Matrix4();
    if (frame) {
      m.makeBasis(new THREE.Vector3(...frame.xDir), new THREE.Vector3(...frame.yDir), new THREE.Vector3(...frame.normal));
      m.setPosition(...frame.origin);
    }
    this.grid.matrix.copy(m);
    this.grid.matrixWorldNeedsUpdate = true;
    this.syncAxisZ(frame);
  }

  private buildPlanes() {
    this.clearGroup(this.planes);
    const s = Math.max(40, this.sceneRadius * 0.9);
    const defs: { plane: OriginPlane; view: string; normal: THREE.Vector3; up: THREE.Vector3 }[] = [
      { plane: "XY", view: "Top", normal: new THREE.Vector3(0, 0, 1), up: new THREE.Vector3(0, 1, 0) },
      { plane: "XZ", view: "Front", normal: new THREE.Vector3(0, -1, 0), up: new THREE.Vector3(0, 0, 1) },
      { plane: "YZ", view: "Right", normal: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 0, 1) },
    ];
    for (const d of defs) {
      const geo = new THREE.PlaneGeometry(s, s);
      const mat = new THREE.MeshBasicMaterial({ color: this.theme.plane, transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false });
      const mesh = new THREE.Mesh(geo, mat);
      const x = new THREE.Vector3().crossVectors(d.up, d.normal);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.makeBasis(x, d.up, d.normal);
      // Offset each plane so its corner sits at the origin.
      mesh.matrix.setPosition(x.clone().multiplyScalar(s / 2).add(d.up.clone().multiplyScalar(s / 2)));
      mesh.userData.plane = d.plane;
      const border = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: this.theme.plane, transparent: true, opacity: 0.55 }));
      border.raycast = () => {};
      mesh.add(border);
      // Name each plane on the canvas, so "XZ" and "Front" connect without reading the tree.
      const label = this.textSprite(`${d.plane} · ${d.view}`, this.theme.plane);
      label.position.set(s * 0.32, s * 0.42, 0);
      mesh.add(label);
      this.planes.add(mesh);
    }
  }

  /** A small screen-sized text tag (always faces the camera). */
  private textSprite(text: string, color: string): THREE.Sprite {
    const c = document.createElement("canvas");
    const px = 28;
    const g = c.getContext("2d")!;
    g.font = `600 ${px}px "IBM Plex Sans", system-ui, sans-serif`;
    c.width = Math.ceil(g.measureText(text).width) + 24;
    c.height = px + 16;
    g.font = `600 ${px}px "IBM Plex Sans", system-ui, sans-serif`;
    // A dark pill with white text reads on every theme; the plane's colour is the pill's outline.
    g.fillStyle = "rgba(14,22,34,0.86)";
    g.beginPath();
    g.roundRect(0, 0, c.width, c.height, 8);
    g.fill();
    g.strokeStyle = color;
    g.lineWidth = 3;
    g.stroke();
    g.fillStyle = "#f4f7fb";
    g.textBaseline = "middle";
    g.fillText(text, 12, c.height / 2 + 1);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, sizeAttenuation: false, toneMapped: false }));
    const h = 0.017;
    sprite.scale.set((h * c.width) / c.height, h, 1);
    sprite.renderOrder = 30;
    sprite.raycast = () => {};
    return sprite;
  }

  setConstructionPlanes(frames: SketchFrame[]) {
    this.clearGroup(this.cplanes);
    const s = Math.max(30, this.sceneRadius * 0.5);
    for (const f of frames) {
      if (f.kind === "curve") {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(f.line ?? new Float32Array(0), 3));
        const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: this.theme.sketch, depthTest: false }));
        lines.raycast = () => {};
        lines.renderOrder = 5;
        this.cplanes.add(lines);
        continue;
      }
      if (f.kind === "axis") {
        const o = new THREE.Vector3(...f.origin);
        const d = new THREE.Vector3(...f.normal).multiplyScalar(s * 0.8);
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([o.clone().sub(d), o.clone().add(d)]), new THREE.LineDashedMaterial({ color: this.theme.plane, dashSize: s * 0.03, gapSize: s * 0.02, transparent: true, opacity: 0.9, depthTest: false }));
        line.computeLineDistances();
        line.raycast = () => {};
        line.renderOrder = 5;
        this.cplanes.add(line);
        continue;
      }
      if (f.kind === "point") {
        const pts = new THREE.Points(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...f.origin)]), new THREE.PointsMaterial({ color: this.theme.plane, size: 9, sizeAttenuation: false, depthTest: false }));
        pts.raycast = () => {};
        pts.renderOrder = 5;
        this.cplanes.add(pts);
        continue;
      }
      const geo = new THREE.PlaneGeometry(s, s);
      const mat = new THREE.MeshBasicMaterial({ color: this.theme.plane, transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.makeBasis(new THREE.Vector3(...f.xDir), new THREE.Vector3(...f.yDir), new THREE.Vector3(...f.normal));
      mesh.matrix.setPosition(...f.origin);
      mesh.userData.cplane = f.id;
      const border = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: this.theme.plane, transparent: true, opacity: 0.6 }));
      border.raycast = () => {};
      mesh.add(border);
      this.cplanes.add(mesh);
    }
    this.invalidate();
  }

  setPlanesVisible(v: boolean) {
    if (this.planes.visible !== v) {
      this.planes.visible = v;
      this.invalidate();
    }
  }

  /* ───────────────────────── Bodies ───────────────────────── */

  private makeBodyView(b: BodyResult, color: string, overlay: boolean, lookId?: string, bodyOpacity?: number): BodyView {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(b.positions, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(b.normals, 3));
    geo.setIndex(new THREE.BufferAttribute(b.indices, 1));
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    const look = lookById(lookId);
    const v = this.view;
    const section = !overlay && !!v.section;
    const clipping = section ? [this.clip] : [];
    const xray = !overlay && v.display === "xray";
    const base = bodyOpacity ?? look.opacity;
    const opacity = xray ? Math.min(0.28, base) : base;
    const analysis = overlay ? null : v.analysis;
    const tinted = analysis === "overhang" || analysis === "draft" || analysis === "curvature" || analysis === "access";
    if (tinted) geo.setAttribute("color", this.analysisColors(b, color, analysis));
    const mat = new THREE.MeshStandardMaterial({
      color: tinted ? "#ffffff" : color,
      vertexColors: tinted,
      roughness: look.roughness,
      metalness: look.metalness,
      transparent: opacity < 1,
      opacity,
      depthWrite: opacity >= 1,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
      side: section ? THREE.FrontSide : THREE.DoubleSide,
      clippingPlanes: clipping,
    });
    // A material's own reflection strength only counts with its own map (the scene's comes with the scene's strength).
    if (look.reflect) {
      mat.envMap = this.scene.environment;
      mat.envMapRotation.copy(this.scene.environmentRotation);
      mat.envMapIntensity = look.reflect * this.theme.envIntensity;
    }
    if (analysis === "zebra") zebra(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.bodyId = b.id;
    const egeo = new LineSegmentsGeometry();
    egeo.setPositions(b.edgePositions.length ? b.edgePositions : new Float32Array(6));
    const edgeMat = overlay
      ? this.lineMat(this.theme.edge, 1.2, { opacity: 0.6 }) // the normal edge colour: the light overlay tone vanished on light bodies
      : this.lineMat(v.display === "wire" ? this.theme.sketch : this.theme.edge, v.display === "wire" ? 1.4 : 1.15);
    edgeMat.clippingPlanes = clipping;
    const edges = new LineSegments2(egeo, edgeMat);
    edges.raycast = () => {};
    let cap: THREE.Mesh | undefined;
    if (overlay) {
      mesh.visible = false;
      edges.renderOrder = 5;
    } else {
      if (v.display === "wire") mat.visible = false;
      if (v.display === "shaded") edges.visible = false;
      if (section) {
        const capMat = new THREE.MeshBasicMaterial({ color: this.theme.accent, side: THREE.BackSide, clippingPlanes: clipping, toneMapped: false });
        cap = new THREE.Mesh(geo, capMat);
        cap.userData.sharedGeometry = true;
        cap.raycast = () => {};
      }
    }
    return { id: b.id, data: b, mesh, edges, cap, visible: true };
  }

  /**
   * Per-vertex analysis colors.
   * overhang: faces pointing down steeper than 45 degrees (off the bed) turn red.
   * draft: walls along the pull (Z) with under 0.1 degrees of draft are red,
   * under 1 degree amber, everything that releases cleanly green.
   */
  private analysisColors(b: BodyResult, color: string, kind: "overhang" | "draft" | "curvature" | "access"): THREE.BufferAttribute {
    if (kind === "curvature") return this.curvatureColors(b);
    if (kind === "access") return this.accessColors(b, color);
    const base = new THREE.Color(color);
    const warn = new THREE.Color("#e2553f");
    const amber = new THREE.Color("#e6a23c");
    const good = new THREE.Color("#4fb36b");
    const n = b.normals;
    const p = b.positions;
    const bed = b.bbox[0][2] + 0.05;
    const out = new Float32Array(n.length);
    for (let i = 0; i < n.length; i += 3) {
      let c = base;
      if (kind === "overhang") c = n[i + 2]! < -OVERHANG_COS && p[i + 2]! > bed ? warn : base;
      else {
        const draft = Math.abs(Math.asin(Math.max(-1, Math.min(1, n[i + 2]!))));
        c = draft < DRAFT_NONE ? warn : draft < DRAFT_LOW ? amber : good;
      }
      out[i] = c.r;
      out[i + 1] = c.g;
      out[i + 2] = c.b;
    }
    return new THREE.BufferAttribute(out, 3);
  }

  /** Mean-curvature heat map: blue is flat, red is tight (per vertex, from how fast the normal turns along each edge). */
  private curvatureColors(b: BodyResult): THREE.BufferAttribute {
    const n = b.normals;
    const p = b.positions;
    const idx = b.indices;
    const k = new Float32Array(n.length / 3);
    const diag = Math.hypot(b.bbox[1][0] - b.bbox[0][0], b.bbox[1][1] - b.bbox[0][1], b.bbox[1][2] - b.bbox[0][2]) || 1;
    for (let t = 0; t + 2 < idx.length; t += 3) {
      for (let e = 0; e < 3; e++) {
        const i = idx[t + e]!;
        const j = idx[t + ((e + 1) % 3)]!;
        const len = Math.hypot(p[i * 3]! - p[j * 3]!, p[i * 3 + 1]! - p[j * 3 + 1]!, p[i * 3 + 2]! - p[j * 3 + 2]!);
        if (len < 1e-9) continue;
        const turn = Math.hypot(n[i * 3]! - n[j * 3]!, n[i * 3 + 1]! - n[j * 3 + 1]!, n[i * 3 + 2]! - n[j * 3 + 2]!) / len;
        k[i] = Math.max(k[i]!, turn);
        k[j] = Math.max(k[j]!, turn);
      }
    }
    const out = new Float32Array(n.length);
    const c = new THREE.Color();
    for (let v = 0; v < k.length; v++) {
      const s = Math.min(1, (k[v]! * diag) / 8);
      c.setHSL((1 - s) * 0.66, 0.85, 0.5);
      out[v * 3] = c.r;
      out[v * 3 + 1] = c.g;
      out[v * 3 + 2] = c.b;
    }
    return new THREE.BufferAttribute(out, 3);
  }

  /** Reach from above (a 3-axis tool): vertices with something higher above them are shaded red. */
  private accessColors(b: BodyResult, color: string): THREE.BufferAttribute {
    const p = b.positions;
    const idx = b.indices;
    const N = 192;
    const [lo, hi] = b.bbox;
    const sx = (N - 1) / Math.max(1e-9, hi[0] - lo[0]);
    const sy = (N - 1) / Math.max(1e-9, hi[1] - lo[1]);
    const top = new Float32Array(N * N).fill(-Infinity);
    for (let t = 0; t + 2 < idx.length; t += 3) {
      const v = [idx[t]! * 3, idx[t + 1]! * 3, idx[t + 2]! * 3];
      const px = v.map((o) => (p[o]! - lo[0]) * sx);
      const py = v.map((o) => (p[o + 1]! - lo[1]) * sy);
      const x0 = Math.max(0, Math.floor(Math.min(...px)));
      const x1 = Math.min(N - 1, Math.ceil(Math.max(...px)));
      const y0 = Math.max(0, Math.floor(Math.min(...py)));
      const y1 = Math.min(N - 1, Math.ceil(Math.max(...py)));
      const den = (py[1]! - py[2]!) * (px[0]! - px[2]!) + (px[2]! - px[1]!) * (py[0]! - py[2]!);
      if (Math.abs(den) < 1e-12) continue;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const a = ((py[1]! - py[2]!) * (x - px[2]!) + (px[2]! - px[1]!) * (y - py[2]!)) / den;
          const c = ((py[2]! - py[0]!) * (x - px[2]!) + (px[0]! - px[2]!) * (y - py[2]!)) / den;
          const d = 1 - a - c;
          if (a < -0.02 || c < -0.02 || d < -0.02) continue;
          const z = a * p[v[0]! + 2]! + c * p[v[1]! + 2]! + d * p[v[2]! + 2]!;
          if (z > top[y * N + x]!) top[y * N + x] = z;
        }
      }
    }
    const base = new THREE.Color(color);
    const hidden = new THREE.Color("#e2553f");
    const out = new Float32Array(p.length);
    const tol = (hi[2] - lo[2]) * 0.01 + 0.05;
    for (let i = 0; i < p.length; i += 3) {
      const x = Math.min(N - 1, Math.max(0, Math.round((p[i]! - lo[0]) * sx)));
      const y = Math.min(N - 1, Math.max(0, Math.round((p[i + 1]! - lo[1]) * sy)));
      // Walls parallel to the tool (normal sideways) are reachable by its flank; up-facing surfaces need clear air above, down-facing ones can't be reached.
      const nz = b.normals[i + 2]!;
      const reach = Math.abs(nz) < 0.05 ? true : nz < 0 ? false : p[i + 2]! >= top[y * N + x]! - tol;
      const c = reach ? base : hidden;
      out[i] = c.r;
      out[i + 1] = c.g;
      out[i + 2] = c.b;
    }
    return new THREE.BufferAttribute(out, 3);
  }

  /** Red boxes around overlaps found by the interference check. */
  setFlags(boxes: [number[], number[]][]) {
    this.clearGroup(this.flagGroup);
    for (const [lo, hi] of boxes) {
      const geo = new THREE.BoxGeometry(Math.max(0.2, hi[0]! - lo[0]!), Math.max(0.2, hi[1]! - lo[1]!), Math.max(0.2, hi[2]! - lo[2]!));
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: "#e2553f", transparent: true, opacity: 0.35, depthTest: false }));
      mesh.position.set((lo[0]! + hi[0]!) / 2, (lo[1]! + hi[1]!) / 2, (lo[2]! + hi[2]!) / 2);
      mesh.raycast = () => {};
      mesh.renderOrder = 6;
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: "#e2553f", depthTest: false }));
      edges.position.copy(mesh.position);
      edges.raycast = () => {};
      edges.renderOrder = 7;
      this.flagGroup.add(mesh, edges);
    }
    this.invalidate();
  }

  private dropView(v: BodyView, parent: THREE.Group) {
    parent.remove(v.mesh, v.edges);
    this.disposeObject(v.mesh);
    this.disposeObject(v.edges);
    if (v.cap) {
      parent.remove(v.cap);
      this.disposeObject(v.cap, true);
    }
  }

  setBodies(list: BodyResult[], meta: Record<Id, BodyMeta>) {
    this.lastBodies = { list, meta };
    for (const v of this.bodies.values()) this.dropView(v, this.world);
    this.bodies.clear();
    for (const b of list) {
      const m = meta[b.id];
      const v = this.makeBodyView(b, m?.color ?? "#b7bfc9", false, m?.look, m?.opacity);
      v.visible = m?.visible !== false;
      if (!v.visible) v.mesh.visible = v.edges.visible = false;
      this.bodies.set(b.id, v);
      this.world.add(v.mesh, v.edges);
      if (v.cap) {
        v.cap.visible = v.visible;
        this.world.add(v.cap);
      }
    }
    this.applyExplode();
    if (this.sketchFrame) this.setSketchFrame(this.sketchFrame);
    this.updateSceneRadius();
    this.invalidate();
  }

  /**
   * Exploded view: every component (bodies sharing a component move together) slides straight out
   * from the middle of the assembly. Only the display moves; picking is paused meanwhile.
   */
  private applyExplode() {
    const k = this.view.explode ?? 0;
    const { list, meta } = this.lastBodies;
    const groups = new Map<string, BodyResult[]>();
    for (const b of list) {
      const key = meta[b.id]?.component || b.id;
      groups.set(key, [...(groups.get(key) ?? []), b]);
    }
    const box = new THREE.Box3();
    const centers = new Map<string, THREE.Vector3>();
    for (const [key, members] of groups) {
      const gb = new THREE.Box3();
      for (const b of members) gb.union(new THREE.Box3(new THREE.Vector3(...b.bbox[0]), new THREE.Vector3(...b.bbox[1])));
      box.union(gb);
      centers.set(key, gb.getCenter(new THREE.Vector3()));
    }
    const mid = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
    const span = box.isEmpty() ? 0 : box.getSize(new THREE.Vector3()).length();
    let n = 0;
    const offsets = new Map<string, THREE.Vector3>();
    for (const [key, c] of centers) {
      const dir = c.clone().sub(mid);
      // Parts sitting at the centre (a shaft through a housing) lift straight up, one level each.
      if (dir.length() < span * 0.02) dir.set(0, 0, span * 0.25 * (1 + n++));
      offsets.set(key, dir.multiplyScalar(k * 1.2));
    }
    for (const v of this.bodies.values()) {
      const key = meta[v.id]?.component || v.id;
      const o = offsets.get(key) ?? new THREE.Vector3();
      v.mesh.position.copy(o);
      v.edges.position.copy(o);
      v.cap?.position.copy(o);
    }
  }

  /** Display settings: style, section, print check, grid, projection. */
  setView(v: ViewSettings) {
    const prev = this.view;
    this.view = v;
    if (v.section) {
      const n = new THREE.Vector3();
      n[v.section.axis] = 1;
      if (v.section.flip) n.negate();
      const p = new THREE.Vector3();
      p[v.section.axis] = v.section.offset;
      this.clip.setFromNormalAndCoplanarPoint(n, p);
    }
    const rebuild =
      prev.display !== v.display || !!prev.section !== !!v.section || prev.analysis !== v.analysis;
    if (rebuild) this.setBodies(this.lastBodies.list, this.lastBodies.meta);
    else if ((prev.explode ?? 0) !== (v.explode ?? 0)) this.applyExplode();
    this.grid.visible = v.grid;
    this.syncAxisZ();
    if (prev.ortho !== v.ortho) {
      this.applyOrbit();
      this.cb.onCamera();
    }
    this.invalidate();
  }

  /** The section plane's span along its axis (for the slider). */
  sectionRange(axis: "x" | "y" | "z"): [number, number] {
    const box = this.sceneBox();
    const i = axis === "x" ? "x" : axis === "y" ? "y" : "z";
    return [box.min[i], box.max[i]];
  }

  private makeShadow(): THREE.Mesh {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d")!;
    const grad = g.createRadialGradient(64, 64, 4, 64, 64, 64);
    grad.addColorStop(0, "rgba(0,0,0,0.75)");
    grad.addColorStop(0.45, "rgba(0,0,0,0.32)");
    grad.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.5, toneMapped: false }));
    m.renderOrder = -2;
    m.raycast = () => {};
    m.visible = false;
    return m;
  }

  private updateShadow() {
    const box = new THREE.Box3();
    for (const v of this.bodies.values()) if (v.visible && v.mesh.geometry.boundingBox) box.union(v.mesh.geometry.boundingBox);
    if (box.isEmpty()) {
      this.shadow.visible = false;
      return;
    }
    const size = box.getSize(new THREE.Vector3());
    this.shadow.visible = true;
    this.shadow.scale.set(size.x * 1.7 + 6, size.y * 1.7 + 6, 1);
    this.shadow.position.set((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, box.min.z - Math.max(0.02, size.z * 0.002));
  }

  /** The measure tool's dimension line (or nothing). */
  setMeasure(segment: [Vec3, Vec3] | null) {
    this.clearGroup(this.measureGroup);
    if (segment) {
      const geo = new LineSegmentsGeometry();
      geo.setPositions([...segment[0], ...segment[1]]);
      const line = new LineSegments2(geo, this.lineMat(this.theme.select, 2.2, { depthTest: false }));
      line.renderOrder = 20;
      this.measureGroup.add(line);
      const r = this.orbit.distance * 0.006;
      for (const p of segment) {
        const dot = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 8), new THREE.MeshBasicMaterial({ color: this.theme.select, depthTest: false, toneMapped: false }));
        dot.position.set(...p);
        dot.renderOrder = 21;
        this.measureGroup.add(dot);
      }
    }
    this.invalidate();
  }

  private ghost: THREE.Mesh | null = null;

  /**
   * The feature being edited, tinted by what it does, as in other CAD tools: blue makes a
   * new body, green joins, red cuts away, amber keeps only the overlap.
   */
  setGhost(b: BodyResult | undefined, op?: string) {
    if (this.ghost) {
      this.overlay.remove(this.ghost);
      this.disposeObject(this.ghost);
      this.ghost = null;
    }
    if (b) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(b.positions, 3));
      geo.setAttribute("normal", new THREE.BufferAttribute(b.normals, 3));
      geo.setIndex(new THREE.BufferAttribute(b.indices, 1));
      const color = GHOST_COLORS[op ?? "cut"] ?? GHOST_COLORS.cut!;
      // Pulled toward the camera so it wins over the body faces it shares (an added volume is part of the body).
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
      this.ghost = new THREE.Mesh(geo, mat);
      this.ghost.raycast = () => {};
      this.ghost.renderOrder = 5;
      this.overlay.add(this.ghost);
    }
    this.invalidate();
  }

  /** Bodies used for picking while a feature previews (shown as an edge overlay only). */
  setPickBodies(list: BodyResult[] | undefined, faint = false) {
    for (const v of this.pickBodies) this.dropView(v, this.overlay);
    this.pickBodies = [];
    for (const b of list ?? []) {
      const v = this.makeBodyView(b, "#ffffff", true);
      // Edges that the feature rounds away must stay clickable and seen; otherwise the old outline only reads as a seam.
      if (faint) v.edges.material.opacity = 0.18;
      this.pickBodies.push(v);
      this.overlay.add(v.mesh, v.edges);
    }
    this.invalidate();
  }

  private updateSceneRadius() {
    const box = new THREE.Box3();
    for (const v of this.bodies.values()) if (v.visible && v.mesh.geometry.boundingBox) box.union(v.mesh.geometry.boundingBox);
    const r = box.isEmpty() ? 60 : box.getBoundingSphere(new THREE.Sphere()).radius;
    this.updateShadow();
    this.syncAxisZ();
    if (Math.abs(r - this.sceneRadius) / this.sceneRadius > 0.25) {
      this.sceneRadius = r;
      this.buildPlanes();
    }
  }

  /* ───────────────────────── Highlights ───────────────────────── */

  setHighlights(items: { pick: Pick; style: "hover" | "select" | "ref" }[]) {
    this.clearGroup(this.highlightGroup);
    for (const { pick, style } of items) {
      const color = style === "hover" ? this.theme.hover : this.theme.select;
      if (pick.kind === "face" || pick.kind === "edge" || pick.kind === "body") {
        const v = this.findBody(pick.bodyId, this.pickBodies.length > 0);
        if (!v) continue;
        if (pick.kind === "face") {
          const start = v.data.faceRanges[pick.index * 2];
          const count = v.data.faceRanges[pick.index * 2 + 1];
          if (start === undefined || count === undefined) continue;
          const geo = new THREE.BufferGeometry();
          geo.setAttribute("position", v.mesh.geometry.getAttribute("position"));
          geo.setIndex(new THREE.BufferAttribute(v.data.indices.slice(start, start + count), 1));
          const mat = new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: style === "hover" ? 0.35 : 0.55,
            depthWrite: false,
            // Kept out of tone mapping, which greys a light tint on a light body until it hardly shows.
            toneMapped: false,
            depthTest: this.pickBodies.length === 0,
            side: THREE.DoubleSide,
            polygonOffset: true,
            polygonOffsetFactor: -1,
            polygonOffsetUnits: -1,
          });
          const m = new THREE.Mesh(geo, mat);
          m.userData.sharedPosition = true;
          m.raycast = () => {};
          m.renderOrder = 9;
          this.highlightGroup.add(m);
        } else if (pick.kind === "edge") {
          const s = v.data.edgeRanges[pick.index * 2];
          const c = v.data.edgeRanges[pick.index * 2 + 1];
          if (s === undefined || c === undefined) continue;
          const geo = new LineSegmentsGeometry();
          geo.setPositions(v.data.edgePositions.slice(s * 3, (s + c) * 3));
          const line = new LineSegments2(geo, this.lineMat(color, style === "hover" ? 3 : 3.5, { depthTest: false }));
          line.renderOrder = 10;
          line.raycast = () => {};
          this.highlightGroup.add(line);
        } else {
          const geo = new LineSegmentsGeometry();
          geo.setPositions(v.data.edgePositions);
          const line = new LineSegments2(geo, this.lineMat(color, 2.4));
          line.raycast = () => {};
          this.highlightGroup.add(line);
        }
      } else if (pick.kind === "plane") {
        const mesh = this.planes.children.find((c) => c.userData.plane === pick.plane) as THREE.Mesh | undefined;
        if (mesh) {
          const m = new THREE.Mesh(mesh.geometry, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.32, side: THREE.DoubleSide, depthWrite: false, toneMapped: false }));
          m.userData.sharedGeometry = true;
          m.matrixAutoUpdate = false;
          m.matrix.copy(mesh.matrix);
          m.raycast = () => {};
          this.highlightGroup.add(m);
        }
      }
    }
    this.invalidate();
  }

  private findBody(id: Id, preferPick: boolean): BodyView | undefined {
    if (preferPick) {
      const p = this.pickBodies.find((b) => b.id === id);
      if (p) return p;
    }
    return this.bodies.get(id);
  }

  /* ───────────────────────── Sketches ───────────────────────── */

  private segments(pts: Vec3[], closed: boolean): number[] {
    const seg: number[] = [];
    const n = closed ? pts.length : pts.length - 1;
    for (let i = 0; i < n; i++) seg.push(...pts[i]!, ...pts[(i + 1) % pts.length]!);
    return seg;
  }

  setSketches(list: SketchDrawable[]) {
    this.clearGroup(this.sketchGroup);
    this.clearGroup(this.fillGroup);
    this.sketchHit = [];
    this.regionMeshes = [];
    for (const s of list) {
      s.regions?.forEach((r, index) => {
        if (r.fill.length < 9) return;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(r.fill, 3));
        const lit = r.selected || r.hovered;
        const mat = new THREE.MeshBasicMaterial({
          color: r.selected ? this.theme.select : this.theme.hover,
          transparent: true,
          opacity: r.selected ? (r.hovered ? 0.5 : 0.38) : lit ? 0.24 : s.profile ? 0.06 : 0,
          side: THREE.DoubleSide,
          depthWrite: false,
          depthTest: !s.profile,
          polygonOffset: true,
          polygonOffsetFactor: -3,
          polygonOffsetUnits: -3,
          toneMapped: false,
        });
        const m = new THREE.Mesh(geo, mat);
        m.renderOrder = s.profile ? 9 : 3;
        m.userData = { sketchId: s.id, region: index, frame: s.frame, profile: !!s.profile };
        this.fillGroup.add(m);
        this.regionMeshes.push(m);
      });
      if (s.fill && s.fill.length >= 9) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(s.fill, 3));
        const mat = new THREE.MeshBasicMaterial({
          color: this.theme.accent,
          transparent: true,
          opacity: s.active ? 0.16 : 0.1,
          side: THREE.DoubleSide,
          depthWrite: false,
          depthTest: !s.active,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
          toneMapped: false,
        });
        const fill = new THREE.Mesh(geo, mat);
        fill.renderOrder = s.active ? 7 : 1;
        fill.raycast = () => {};
        this.fillGroup.add(fill);
      }
      const toWorld = this.frameMapper(s.frame);
      const hit: Vec3[][] = [];
      for (const sh of s.shapes) {
        const pts = sh.pts.map(toWorld);
        hit.push(pts);
        if (pts.length < 2) continue;
        const geo = new LineSegmentsGeometry();
        geo.setPositions(this.segments(pts, sh.closed));
        const t = this.theme;
        const toned = sh.tone === "bad" ? t.conflict : sh.tone === "defined" ? t.defined : undefined;
        const color = sh.selected ? t.select : sh.hovered ? t.hover : sh.tone === "bad" ? t.conflict : sh.construction ? t.construction : toned ?? (s.active ? t.sketchActive : t.sketch);
        const line = new LineSegments2(geo, this.lineMat(color, s.active ? (sh.selected ? 2.6 : 1.9) : 1.3, { dashed: sh.construction, depthTest: !s.active }));
        if (sh.construction) line.computeLineDistances();
        line.renderOrder = s.active ? 8 : 2;
        line.raycast = () => {};
        this.sketchGroup.add(line);
      }
      if (!s.active) this.sketchHit.push({ id: s.id, pts: hit });
      if (s.markers?.length) {
        const t = this.theme;
        const pos: number[] = [];
        const col: number[] = [];
        const c = new THREE.Color();
        for (const m of s.markers) {
          pos.push(...toWorld(m.p));
          c.set(m.selected ? t.select : m.hovered ? t.hover : m.tone === "bad" ? t.conflict : m.tone === "defined" ? t.defined : t.sketchActive);
          col.push(c.r, c.g, c.b);
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
        geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
        const pts = new THREE.Points(geo, new THREE.PointsMaterial({ size: 7, sizeAttenuation: false, vertexColors: true, depthTest: false, toneMapped: false }));
        pts.renderOrder = 9;
        pts.raycast = () => {};
        this.sketchGroup.add(pts);
      }
    }
    this.invalidate();
  }

  /** Reference pictures lying on their sketch planes, behind the sketch lines. */
  setReferenceImages(list: { frame: SketchFrame; image: SketchImage; active: boolean }[]) {
    for (const m of this.imageGroup.children as THREE.Mesh[]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.imageGroup.clear();
    const used = new Set<string>();
    for (const { frame: f, image: im, active } of list) {
      used.add(im.src);
      let tex = this.textures.get(im.src);
      if (!tex) {
        tex = new THREE.TextureLoader().load(im.src, () => this.invalidate());
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 8;
        this.textures.set(im.src, tex);
      }
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(im.width, im.width * im.aspect),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: active ? im.opacity : im.opacity * 0.6, side: THREE.DoubleSide, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 }),
      );
      const basis = new THREE.Matrix4().makeBasis(new THREE.Vector3(...f.xDir), new THREE.Vector3(...f.yDir), new THREE.Vector3(...f.normal)).setPosition(...f.origin);
      const local = new THREE.Matrix4().makeRotationZ((im.rotation * Math.PI) / 180).setPosition(im.x, im.y, 0);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.multiplyMatrices(basis, local);
      mesh.renderOrder = -1;
      mesh.raycast = () => {};
      this.imageGroup.add(mesh);
    }
    for (const [src, tex] of this.textures) {
      if (used.has(src)) continue;
      tex.dispose();
      this.textures.delete(src);
    }
    this.invalidate();
  }

  setSketchPreview(frame: SketchFrame | null, shapes: { pts: Vec2[]; closed: boolean }[], guides: [Vec2, Vec2][] = []) {
    this.clearGroup(this.previewGroup);
    if (!frame) return this.invalidate();
    const toWorld = this.frameMapper(frame);
    const add = (pts: Vec2[], closed: boolean, color: string, width: number, dashed = false) => {
      if (pts.length < 2) return;
      const geo = new LineSegmentsGeometry();
      geo.setPositions(this.segments(pts.map(toWorld), closed));
      const line = new LineSegments2(geo, this.lineMat(color, width, { dashed, depthTest: false }));
      if (dashed) line.computeLineDistances();
      line.renderOrder = 12;
      this.previewGroup.add(line);
    };
    for (const s of shapes) add(s.pts, s.closed, this.theme.accent, 2);
    for (const g of guides) add(g, false, this.theme.select, 1, true);
    this.invalidate();
  }

  private frameMapper(f: SketchFrame) {
    return ([x, y]: Vec2): Vec3 => [
      f.origin[0] + f.xDir[0] * x + f.yDir[0] * y,
      f.origin[1] + f.xDir[1] * x + f.yDir[1] * y,
      f.origin[2] + f.xDir[2] * x + f.yDir[2] * y,
    ];
  }

  /** Enter/leave sketch editing on a plane: grid moves onto it, bodies turn translucent. */
  setSketchFrame(frame: SketchFrame | null) {
    const was = this.sketchFrame;
    this.sketchFrame = frame;
    this.setGridFrame(frame);
    if (!frame) {
      // Restore each body's own finish.
      if (was) this.setBodies(this.lastBodies.list, this.lastBodies.meta);
      this.invalidate();
      return;
    }
    this.world.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      if (m instanceof THREE.MeshStandardMaterial) {
        m.transparent = true;
        m.opacity = 0.32;
        m.depthWrite = false;
        m.needsUpdate = true;
      }
    });
    this.invalidate();
  }

  /** Screen position (CSS px, relative to the canvas) of a sketch-plane point. */
  sketchToScreen(p: Vec2, frame = this.sketchFrame): Vec2 | null {
    if (!frame) return null;
    return this.worldToScreen(this.frameMapper(frame)(p));
  }

  worldToScreen(w: Vec3): Vec2 {
    tmpV.set(...w).project(this.camera);
    return [((tmpV.x + 1) / 2) * this.size.x, ((1 - tmpV.y) / 2) * this.size.y];
  }

  /** World size of one screen pixel at the orbit target (for snapping tolerances). */
  get pixelSize(): number {
    const h = 2 * this.orbit.distance * Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2));
    return h / this.size.y;
  }

  get gridSpacing(): number {
    return this.gridStep || 10;
  }

  /* ───────────────────────── Picking ───────────────────────── */

  setPickFilter(f: PickFilter) {
    this.filter = f;
  }

  private ndc(e: { clientX: number; clientY: number }): THREE.Vector2 {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  private screen(e: { clientX: number; clientY: number }): Vec2 {
    const r = this.renderer.domElement.getBoundingClientRect();
    // Layout pixels, whatever the interface zoom makes of the on-screen size.
    return [((e.clientX - r.left) * this.size.x) / (r.width || 1), ((e.clientY - r.top) * this.size.y) / (r.height || 1)];
  }

  pick(e: { clientX: number; clientY: number }): Pick | null {
    // Bodies are drawn away from where they are while exploded, so a click wouldn't mean the right place.
    if ((this.view.explode ?? 0) > 0.001) return null;
    const usePick = this.pickBodies.length > 0;
    const views = usePick ? this.pickBodies : [...this.bodies.values()].filter((v) => v.visible);
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    const meshes = views.map((v) => v.mesh);
    if (usePick) for (const m of meshes) m.visible = true;
    const hits = this.raycaster.intersectObjects(meshes, false);
    if (usePick) for (const m of meshes) m.visible = false;
    // In a section view, ignore the part of each body that's cut away.
    const faceHit = this.view.section ? hits.find((h) => this.clip.distanceToPoint(h.point) >= 0) : hits[0];
    const sp = this.screen(e);

    // A sketch area in front of (or lying on) the faces is what the click meant: profiles sit on the faces they were drawn on.
    const regionHit = this.filter.sketches ? this.raycaster.intersectObjects(this.regionMeshes, false)[0] : undefined;
    if (regionHit && (!faceHit || regionHit.object.userData.profile || regionHit.distance <= faceHit.distance + this.orbit.distance * 0.002)) {
      const { sketchId, region, frame } = regionHit.object.userData as { sketchId: Id; region: number; frame: SketchFrame };
      const d = regionHit.point.clone().sub(new THREE.Vector3(...frame.origin));
      const r3 = (v: number) => Math.round(v * 1000) / 1000;
      const at: Vec2 = [r3(d.dot(new THREE.Vector3(...frame.xDir))), r3(d.dot(new THREE.Vector3(...frame.yDir)))];
      // An edge right under the pointer still wins, so lines stay clickable.
      const edge = this.filter.edges && !regionHit.object.userData.profile ? this.pickEdge(views, sp, regionHit.distance) : null;
      if (edge) return edge;
      const line = this.pickSketch(sp);
      if (line) return line;
      return { kind: "region", sketchId, index: region, at };
    }
    // Edges first: they're thin, so they get a generous screen-space radius.
    if (this.filter.edges) {
      const edge = this.pickEdge(views, sp, faceHit?.distance ?? Infinity);
      if (edge) return edge;
    }
    if (faceHit && faceHit.faceIndex != null) {
      const bodyId = faceHit.object.userData.bodyId as Id;
      const v = views.find((x) => x.id === bodyId)!;
      const at: Vec3 = [faceHit.point.x, faceHit.point.y, faceHit.point.z];
      if (this.filter.faces) {
        const idx = this.faceOfTriangle(v.data.faceRanges, faceHit.faceIndex * 3);
        if (idx >= 0) return { kind: "face", bodyId, index: idx, at };
      }
      return { kind: "body", bodyId, at };
    }
    if (this.filter.sketches) {
      const s = this.pickSketch(sp);
      if (s) return s;
    }
    if (this.filter.planes && this.planes.visible) {
      const ph = this.raycaster.intersectObjects([...this.planes.children, ...this.cplanes.children], false)[0];
      if (ph?.object.userData.cplane) return { kind: "cplane", id: ph.object.userData.cplane as Id };
      if (ph) return { kind: "plane", plane: ph.object.userData.plane as OriginPlane };
    }
    return null;
  }

  /** Alt+click reaches what's behind: each Alt+click on the same spot takes the next thing under it (edge, then faces further back). */
  private lastClick: { x: number; y: number; list: Pick[]; i: number } | null = null;

  private pickCycling(e: { clientX: number; clientY: number; altKey: boolean }): Pick | null {
    const last = this.lastClick;
    if (e.altKey && last && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 4) {
      last.i = (last.i + 1) % last.list.length;
      return last.list[last.i]!;
    }
    const first = this.pick(e);
    const list = first ? [first, ...this.facesBehind(e).filter((p) => !samePick(p, first))] : [];
    this.lastClick = list.length ? { x: e.clientX, y: e.clientY, list, i: e.altKey && list.length > 1 ? 1 : 0 } : null;
    return this.lastClick ? this.lastClick.list[this.lastClick.i]! : null;
  }

  /** Every face along the pointer's ray, nearest first (bodies behind bodies included). */
  private facesBehind(e: { clientX: number; clientY: number }): Pick[] {
    if (!this.filter.faces || this.sketchFrame || (this.view.explode ?? 0) > 0.001) return [];
    const views = this.pickBodies.length > 0 ? this.pickBodies : [...this.bodies.values()].filter((v) => v.visible);
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    const meshes = views.map((v) => v.mesh);
    const hidden = meshes.filter((m) => !m.visible);
    for (const m of hidden) m.visible = true;
    const hits = this.raycaster.intersectObjects(meshes, false);
    for (const m of hidden) m.visible = false;
    const out: Pick[] = [];
    for (const h of hits) {
      if (h.faceIndex == null || (this.view.section && this.clip.distanceToPoint(h.point) < 0)) continue;
      const bodyId = h.object.userData.bodyId as Id;
      const v = views.find((x) => x.id === bodyId);
      const index = v ? this.faceOfTriangle(v.data.faceRanges, h.faceIndex * 3) : -1;
      if (index >= 0 && !out.some((p) => p.kind === "face" && p.bodyId === bodyId && p.index === index)) out.push({ kind: "face", bodyId, index, at: [h.point.x, h.point.y, h.point.z] });
    }
    return out;
  }

  private faceOfTriangle(ranges: Int32Array, indexOffset: number): number {
    for (let i = 0; i < ranges.length / 2; i++) {
      const s = ranges[i * 2]!;
      const c = ranges[i * 2 + 1]!;
      if (indexOffset >= s && indexOffset < s + c) return i;
    }
    return -1;
  }

  private distToSegment(sp: Vec2, pa: Vec2, pb: Vec2): { d: number; t: number } {
    const dx = pb[0] - pa[0];
    const dy = pb[1] - pa[1];
    const l2 = dx * dx + dy * dy || 1;
    const t = THREE.MathUtils.clamp(((sp[0] - pa[0]) * dx + (sp[1] - pa[1]) * dy) / l2, 0, 1);
    return { d: Math.hypot(pa[0] + dx * t - sp[0], pa[1] + dy * t - sp[1]), t };
  }

  private pickEdge(views: BodyView[], sp: Vec2, faceDist: number): Pick | null {
    const radius = 7;
    let best: { d: number; bodyId: Id; index: number; at: Vec3 } | null = null;
    // Depth along the pick ray (works for perspective and orthographic cameras alike).
    const ray = this.raycaster.ray;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const tol = this.orbit.distance * 0.004;
    for (const v of views) {
      const pos = v.data.edgePositions;
      const ranges = v.data.edgeRanges;
      for (let ei = 0; ei < ranges.length / 2; ei++) {
        const s = ranges[ei * 2]!;
        const c = ranges[ei * 2 + 1]!;
        for (let k = s; k + 1 < s + c; k += 2) {
          a.set(pos[k * 3]!, pos[k * 3 + 1]!, pos[k * 3 + 2]!);
          b.set(pos[k * 3 + 3]!, pos[k * 3 + 4]!, pos[k * 3 + 5]!);
          const { d } = this.distToSegment(sp, this.worldToScreen([a.x, a.y, a.z]), this.worldToScreen([b.x, b.y, b.z]));
          if (d > radius || (best && d >= best.d)) continue;
          // The edge point nearest the pick ray. (A screen-space fraction along the edge isn't the same fraction in 3D under
          // perspective, so lerping by it lands millimetres away and wrongly reads as hidden.)
          const on = new THREE.Vector3();
          ray.distanceSqToSegment(a, b, undefined, on);
          // Hidden behind a face? (small tolerance: the edge lies on that face)
          if (on.clone().sub(ray.origin).dot(ray.direction) > faceDist + tol) continue;
          if (this.view.section && this.clip.distanceToPoint(on) < 0) continue;
          best = { d, bodyId: v.id, index: ei, at: [on.x, on.y, on.z] };
        }
      }
    }
    return best ? { kind: "edge", bodyId: best.bodyId, index: best.index, at: best.at } : null;
  }

  private pickSketch(sp: Vec2): Pick | null {
    let best: { d: number; id: Id } | null = null;
    for (const s of this.sketchHit) {
      for (const pts of s.pts) {
        for (let i = 0; i < pts.length; i++) {
          const { d } = this.distToSegment(sp, this.worldToScreen(pts[i]!), this.worldToScreen(pts[(i + 1) % pts.length]!));
          if (d < 6 && (!best || d < best.d)) best = { d, id: s.id };
        }
      }
    }
    return best ? { kind: "sketch", sketchId: best.id } : null;
  }

  /** Intersect the pointer ray with the active sketch plane (2D sketch coordinates). */
  /** The point of the open sketch's plane under a window position, or null. */
  clientToSketch(e: { clientX: number; clientY: number }): Vec2 | null {
    return this.sketchPoint(e);
  }

  private sketchPoint(e: { clientX: number; clientY: number }): Vec2 | null {
    const f = this.sketchFrame;
    if (!f) return null;
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(...f.normal), new THREE.Vector3(...f.origin));
    const hit = this.raycaster.ray.intersectPlane(plane, new THREE.Vector3());
    if (!hit) return null;
    hit.sub(new THREE.Vector3(...f.origin));
    return [hit.dot(new THREE.Vector3(...f.xDir)), hit.dot(new THREE.Vector3(...f.yDir))];
  }

  /* ───────────────────────── Pointer & navigation ───────────────────────── */

  private sketchEvent(type: SketchPointerEvent["type"], e: PointerEvent): boolean {
    if (!this.sketchFrame) return false;
    const p = this.sketchPoint(e);
    if (!p) return false;
    this.cb.onSketchPointer({ type, p, button: e.button, shift: e.shiftKey, alt: e.altKey || e.ctrlKey || e.metaKey, ctrl: e.ctrlKey || e.metaKey, screen: this.screen(e), client: [e.clientX, e.clientY] });
    return true;
  }

  private box: { client: Vec2; screen: Vec2; el: HTMLDivElement | null } | null = null;

  /** Faces (or, when only edges may be picked, edges) inside / touching the screen rectangle. Alt selects through to hidden ones. */
  private boxSelect(a: Vec2, b: Vec2, through: boolean): Pick[] {
    const crossing = b[0] < a[0];
    const [x0, x1] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])];
    const [y0, y1] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])];
    const inside = (w: Vec3) => {
      const p = this.worldToScreen(w);
      return p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1;
    };
    const views = [...this.bodies.values()].filter((v) => v.visible);
    const meshes = views.map((v) => v.mesh);
    const tol = this.orbit.distance * 0.004;
    const visible = (w: Vec3) => {
      if (through) return true;
      const p = this.worldToScreen(w);
      this.raycaster.setFromCamera(new THREE.Vector2((p[0] / this.size.x) * 2 - 1, -((p[1] / this.size.y) * 2 - 1)), this.camera);
      const hit = this.raycaster.intersectObjects(meshes, false)[0];
      const dist = new THREE.Vector3(...w).sub(this.raycaster.ray.origin).dot(this.raycaster.ray.direction);
      return !hit || hit.distance >= dist - tol;
    };
    const edgePoints = (v: BodyView, ei: number): Vec3[] => {
      const pos = v.data.edgePositions;
      const s0 = v.data.edgeRanges[ei * 2]!;
      const c = v.data.edgeRanges[ei * 2 + 1]!;
      const out: Vec3[] = [];
      for (let k = s0; k + 1 < s0 + c; k++) {
        const p: Vec3 = [pos[k * 3]!, pos[k * 3 + 1]!, pos[k * 3 + 2]!];
        const q: Vec3 = [pos[k * 3 + 3]!, pos[k * 3 + 4]!, pos[k * 3 + 5]!];
        for (let t = 0; t < 6; t++) out.push([p[0] + ((q[0] - p[0]) * t) / 6, p[1] + ((q[1] - p[1]) * t) / 6, p[2] + ((q[2] - p[2]) * t) / 6]);
      }
      return out;
    };
    const hits = (pts: Vec3[]) => pts.length > 0 && (crossing ? pts.some(inside) : pts.every(inside));
    const out: Pick[] = [];
    for (const v of views) {
      if (this.filter.faces) {
        v.data.faces.forEach((f, fi) => {
          const pts = (v.data.faceEdges[fi] ?? []).flatMap((ei) => edgePoints(v, ei));
          if (!pts.length) pts.push(f.center);
          if (hits(pts) && visible(f.center)) out.push({ kind: "face", bodyId: v.id, index: fi });
        });
      } else if (this.filter.edges) {
        for (let ei = 0; ei < v.data.edgeRanges.length / 2; ei++) {
          const pts = edgePoints(v, ei);
          if (hits(pts) && visible(pts[Math.floor(pts.length / 2)]!)) out.push({ kind: "edge", bodyId: v.id, index: ei });
        }
      }
    }
    return out;
  }

  /** Fingers on the screen. Two together pinch to zoom and drag to pan; one orbits (model) or draws (sketch). */
  private touches = new Map<number, Vec2>();
  private pinch: { dist: number; cx: number; cy: number } | null = null;
  /** Holding one finger still is the touch screen's right-click: the quick-action menu. */
  private longPress: ReturnType<typeof setTimeout> | null = null;

  /** A long press has opened the menu and the finger is still down. */
  private pressed = false;

  private cancelLongPress() {
    if (this.longPress) clearTimeout(this.longPress);
    this.longPress = null;
  }

  /** The lift after a long press: the click that follows it belongs to nobody. */
  private endLongPress() {
    if (this.pressed) touchGuard.until = performance.now() + 500;
    this.pressed = false;
  }

  private startLongPress(e: PointerEvent) {
    this.cancelLongPress();
    const at = { clientX: e.clientX, clientY: e.clientY };
    this.longPress = setTimeout(() => {
      this.longPress = null;
      if (!this.drag || this.drag.moved || this.pinch) return;
      this.drag = null; // the lift that follows is not a click
      this.pressed = true;
      this.box?.el?.remove();
      this.box = null;
      this.cb.onContext(this.sketchFrame ? null : this.pick(at), this.screen(at));
    }, 550);
  }

  private pinchState(): { dist: number; cx: number; cy: number } {
    const [a, b] = [...this.touches.values()] as [Vec2, Vec2];
    return { dist: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2 };
  }

  /** Move the camera toward (factor < 1) or away from the point under the given screen position. */
  private zoomAt(factor: number, clientX: number, clientY: number) {
    this.raycaster.setFromCamera(this.ndc({ clientX, clientY }), this.camera);
    const viewDir = new THREE.Vector3().subVectors(this.orbit.target, this.camera.position).normalize();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(viewDir, this.orbit.target);
    const p = this.raycaster.ray.intersectPlane(plane, new THREE.Vector3());
    const next = THREE.MathUtils.clamp(this.orbit.distance * factor, 0.5, 200000);
    if (p) this.orbit.target.lerp(p, 1 - next / this.orbit.distance);
    this.orbit.distance = next;
  }

  private startPinch(e: PointerEvent) {
    this.cancelLongPress();
    // A first finger may already have begun a drag, a rubber band or a sketch stroke: drop it.
    if (this.drag && this.sketchFrame) this.sketchEvent("leave", e);
    this.drag = null;
    this.box?.el?.remove();
    this.box = null;
    this.pinch = this.pinchState();
  }

  private onPointerDown = (e: PointerEvent) => {
    this.renderer.domElement.setPointerCapture(e.pointerId);
    this.renderer.domElement.focus({ preventScroll: true });
    if (e.pointerType === "touch") {
      this.touches.set(e.pointerId, [e.clientX, e.clientY]);
      if (this.touches.size === 2) {
        this.startPinch(e);
        return;
      }
      if (this.touches.size > 2) return;
    }
    const inSketch = !!this.sketchFrame;
    let mode = navAction(this.nav, e.button, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey }, inSketch);
    // A single finger has no modifier keys: in the model it orbits (a tap still selects).
    if (e.pointerType === "touch" && !inSketch && e.button === 0) mode = "orbit";
    // Middle-button presses would otherwise start the browser's autoscroll.
    if (e.button === 1) e.preventDefault();
    this.drag = { x: e.clientX, y: e.clientY, button: e.button, moved: false, mode };
    // Orbit around the point under the cursor (when there is one), so the model never swings away.
    if (mode === "orbit" && !inSketch) {
      const hit = this.pick(e);
      const at = hit && "at" in hit ? hit.at : undefined;
      if (at) {
        const dir = new THREE.Vector3().subVectors(this.orbit.target, this.camera.position).normalize();
        const dist = new THREE.Vector3(...at).sub(this.camera.position).dot(dir);
        if (dist > 0.5) {
          this.orbit.target.copy(this.camera.position).addScaledVector(dir, dist);
          this.orbit.distance = dist;
        }
      }
    }
    this.cb.onContext(null, [-1, -1]);
    this.anim = null;
    if (e.pointerType === "touch" && !inSketch) this.startLongPress(e);
    if (inSketch && e.button === 0) this.sketchEvent("down", e);
    // Left-drag on empty space (where the navigation style leaves it free) rubber-bands a selection.
    if (!inSketch && e.button === 0 && mode === "none") this.box = { client: [e.clientX, e.clientY], screen: this.screen(e), el: null };
  };

  private onPointerMove = (e: PointerEvent) => {
    if (e.pointerType === "touch" && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, [e.clientX, e.clientY]);
      if (this.pinch && this.touches.size >= 2) {
        const now = this.pinchState();
        const px = this.pixelSize;
        const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
        this.orbit.target.addScaledVector(right, -(now.cx - this.pinch.cx) * px).addScaledVector(up, (now.cy - this.pinch.cy) * px);
        this.zoomAt(this.pinch.dist / now.dist, now.cx, now.cy);
        this.pinch = now;
        this.anim = null;
        this.applyOrbit();
        this.cb.onCamera();
        this.invalidate();
        return;
      }
    }
    const d = this.drag;
    if (d) {
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) > 4) {
        d.moved = true;
        this.cancelLongPress();
      }
      if (d.moved && d.mode !== "none") {
        d.x = e.clientX;
        d.y = e.clientY;
        if (d.mode === "orbit") {
          this.orbit.theta -= dx * 0.0075;
          this.orbit.phi = THREE.MathUtils.clamp(this.orbit.phi - dy * 0.0075, 0.0001, Math.PI - 0.0001);
        } else if (d.mode === "zoom") {
          const k = Math.pow(1.006, (this.invertZoom ? -dy : dy));
          this.orbit.distance = THREE.MathUtils.clamp(this.orbit.distance * k, 0.5, 200000);
        } else {
          const px = this.pixelSize;
          const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
          const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
          this.orbit.target.addScaledVector(right, -dx * px).addScaledVector(up, dy * px);
        }
        this.applyOrbit();
        this.cb.onCamera();
        this.invalidate();
        return;
      }
    }
    if (this.box && d?.moved) {
      if (!this.box.el) {
        const el = document.createElement("div");
        el.className = "selbox";
        this.container.appendChild(el);
        this.box.el = el;
      }
      const r = this.container.getBoundingClientRect();
      const [x0, y0] = this.box.client;
      this.box.el.classList.toggle("is-crossing", e.clientX < x0);
      Object.assign(this.box.el.style, { left: Math.min(x0, e.clientX) - r.left + "px", top: Math.min(y0, e.clientY) - r.top + "px", width: Math.abs(e.clientX - x0) + "px", height: Math.abs(e.clientY - y0) + "px" });
      return;
    }
    if (this.sketchFrame) {
      this.sketchEvent("move", e);
      return;
    }
    if (!d) this.hoverAt(e);
  };

  private hoverAt(e: { clientX: number; clientY: number }) {
    const p = this.pick(e);
    const key = JSON.stringify(p);
    if (key !== this.lastHoverKey) {
      this.lastHoverKey = key;
      this.cb.onHover(p);
    }
  }

  private onPointerCancel = (e: PointerEvent) => {
    this.cancelLongPress();
    this.endLongPress();
    this.touches.delete(e.pointerId);
    if (this.touches.size < 2) this.pinch = null;
    this.drag = null;
    this.box?.el?.remove();
    this.box = null;
  };

  private onPointerUp = (e: PointerEvent) => {
    this.cancelLongPress();
    this.endLongPress();
    const d = this.drag;
    this.drag = null;
    if (e.pointerType === "touch") {
      this.touches.delete(e.pointerId);
      if (this.pinch) {
        // The end of a pinch is never a click, and the finger left behind doesn't start an orbit.
        if (this.touches.size < 2) this.pinch = null;
        if (this.renderer.domElement.hasPointerCapture(e.pointerId)) this.renderer.domElement.releasePointerCapture(e.pointerId);
        return;
      }
    }
    if (this.renderer.domElement.hasPointerCapture(e.pointerId)) this.renderer.domElement.releasePointerCapture(e.pointerId);
    if (!d) return;
    if (d.button === 2 && !d.moved) {
      this.cb.onContext(this.sketchFrame ? null : this.pick(e), this.screen(e));
      return;
    }
    const box = this.box;
    this.box = null;
    box?.el?.remove();
    if (box?.el && d.moved) {
      this.cb.onBoxSelect?.(this.boxSelect(box.screen, this.screen(e), e.altKey), e.shiftKey || e.ctrlKey || e.metaKey);
      return;
    }
    if (this.sketchFrame) {
      if (d.button === 0) this.sketchEvent("up", e);
      return;
    }
    if (!d.moved && d.button === 0) this.cb.onClick(this.pickCycling(e), e.shiftKey || e.ctrlKey || e.metaKey);
  };

  private onPointerLeave = (e: PointerEvent) => {
    if (this.sketchFrame) this.sketchEvent("leave", e);
    else if (this.lastHoverKey !== "null") {
      this.lastHoverKey = "null";
      this.cb.onHover(null);
    }
  };

  private onDblClick = (e: MouseEvent) => {
    if (this.sketchFrame) return;
    this.cb.onDoubleClick(this.pick(e));
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.anim = null;
    const factor = Math.pow(1.0015, (this.invertZoom ? -1 : 1) * e.deltaY * (e.deltaMode === 1 ? 33 : 1));
    // Zoom toward the cursor: the point under the cursor stays put.
    this.zoomAt(factor, e.clientX, e.clientY);
    this.applyOrbit();
    this.cb.onCamera();
    this.invalidate();
  };

  /* ───────────────────────── Camera views ───────────────────────── */

  private animateTo(to: Turntable, dur = 420) {
    const from = new Turntable();
    from.target.copy(this.orbit.target);
    from.distance = this.orbit.distance;
    from.theta = this.orbit.theta;
    from.phi = this.orbit.phi;
    const dt = to.theta - from.theta;
    to.theta = from.theta + Math.atan2(Math.sin(dt), Math.cos(dt)); // shortest way round
    this.anim = { from, to, t0: performance.now(), dur: matchMedia("(prefers-reduced-motion: reduce)").matches ? 1 : dur };
    this.invalidate();
  }

  private sceneBox(): THREE.Box3 {
    const box = new THREE.Box3();
    for (const v of this.bodies.values()) if (v.visible && v.mesh.geometry.boundingBox) box.union(v.mesh.geometry.boundingBox);
    if (box.isEmpty()) box.set(new THREE.Vector3(-40, -40, 0), new THREE.Vector3(40, 40, 30));
    return box;
  }

  /** `margin` 1.22 leaves room for the view dock along the bottom and the cube in the corner (model views). */
  private fitDistance(radius: number, margin = 1.22) {
    const vfov = THREE.MathUtils.degToRad(this.persp.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.persp.aspect);
    return (radius / Math.sin(Math.min(vfov, hfov) / 2)) * margin;
  }

  viewTo(view: CubeView | "home" | "fit") {
    const sphere = this.sceneBox().getBoundingSphere(new THREE.Sphere());
    const to = new Turntable();
    to.target.copy(sphere.center);
    to.distance = this.fitDistance(sphere.radius);
    const dirs: Record<CubeView, [THREE.Vector3, THREE.Vector3?]> = {
      front: [new THREE.Vector3(0, -1, 0)],
      back: [new THREE.Vector3(0, 1, 0)],
      left: [new THREE.Vector3(-1, 0, 0)],
      right: [new THREE.Vector3(1, 0, 0)],
      top: [new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0)],
      bottom: [new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, -1, 0)],
      iso: [new THREE.Vector3(1, -1.25, 0.95)],
    };
    if (view === "fit") {
      to.theta = this.orbit.theta;
      to.phi = this.orbit.phi;
    } else {
      const [dir, up] = dirs[view === "home" ? "iso" : view];
      const a = Turntable.anglesFor(dir, up);
      to.theta = a.theta;
      to.phi = THREE.MathUtils.clamp(a.phi, 0.0001, Math.PI - 0.0001);
    }
    this.animateTo(to);
  }

  /** Look along any direction from the model's center (the orientation cube's edges and corners). */
  viewDirection(dir: [number, number, number]) {
    const sphere = this.sceneBox().getBoundingSphere(new THREE.Sphere());
    const to = new Turntable();
    to.target.copy(sphere.center);
    to.distance = this.fitDistance(sphere.radius);
    const d = new THREE.Vector3(...dir);
    // Straight down or up has no "up" of its own: keep +Y up the screen, as the cube's Top face does.
    const a = Turntable.anglesFor(d, Math.abs(d.clone().normalize().z) > 0.999 ? new THREE.Vector3(0, Math.sign(d.z), 0) : undefined);
    to.theta = a.theta;
    to.phi = THREE.MathUtils.clamp(a.phi, 0.0001, Math.PI - 0.0001);
    this.animateTo(to);
  }

  /** Extruding from a plan view: swing to a three-quarter view on the sketch's side, so the new solid's depth shows. */
  tiltFromPlan(normal: [number, number, number]) {
    const n = new THREE.Vector3(...normal).normalize();
    const look = this.camera.getWorldDirection(new THREE.Vector3());
    if (Math.abs(look.dot(n)) < 0.97) return;
    const d = new THREE.Vector3(1, -1.25, 0.95);
    if (d.dot(n) < 0) d.addScaledVector(n, -2 * d.dot(n));
    this.viewDirection([d.x, d.y, d.z]);
  }

  /** Turn the camera around the target by screen pixels (dragging the orientation cube). */
  orbitBy(dx: number, dy: number) {
    this.orbit.theta -= dx * 0.0075;
    this.orbit.phi = THREE.MathUtils.clamp(this.orbit.phi - dy * 0.0075, 0.0001, Math.PI - 0.0001);
    this.applyOrbit();
    this.cb.onCamera();
    this.invalidate();
  }

  /** Look straight at a sketch plane. */
  viewNormal(frame: SketchFrame) {
    const to = new Turntable();
    const sphere = this.sceneBox().getBoundingSphere(new THREE.Sphere());
    const r = Math.max(60, sphere.radius);
    // Center on the model where it meets the plane, not the plane's origin: a part drawn up from the origin stays in view.
    const o = new THREE.Vector3(...frame.origin);
    const n = new THREE.Vector3(...frame.normal).normalize();
    if ([...this.bodies.values()].some((v) => v.visible)) to.target.copy(sphere.center).addScaledVector(n, -sphere.center.clone().sub(o).dot(n));
    else to.target.copy(o);
    to.distance = this.fitDistance(r, 1.08); // sketches keep their tighter framing
    const a = Turntable.anglesFor(new THREE.Vector3(...frame.normal), new THREE.Vector3(...frame.yDir));
    to.theta = a.theta;
    to.phi = THREE.MathUtils.clamp(a.phi, 0.0001, Math.PI - 0.0001);
    this.animateTo(to);
  }

  /** A PNG of the current view at `scale` × the screen resolution. */
  image(scale = 2): string {
    const pr = this.renderer.getPixelRatio();
    this.renderer.setPixelRatio(Math.min(4, pr * scale));
    this.renderer.setSize(this.size.x, this.size.y, false);
    for (const m of this.lineMaterials) m.resolution.set(this.size.x * scale, this.size.y * scale);
    this.renderer.render(this.scene, this.camera);
    const url = this.renderer.domElement.toDataURL("image/png");
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(this.size.x, this.size.y, false);
    for (const m of this.lineMaterials) m.resolution.set(this.size.x, this.size.y);
    this.invalidate();
    return url;
  }

  /** PNG thumbnail of the current view (used in saved files). */
  thumbnail(size = 256): string {
    this.renderer.render(this.scene, this.camera);
    const src = this.renderer.domElement;
    const c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    const s = Math.min(src.width, src.height);
    c.getContext("2d")!.drawImage(src, (src.width - s) / 2, (src.height - s) / 2, s, s, 0, 0, size, size);
    return c.toDataURL("image/png");
  }
}