/**
 * Personal preferences: look and feel, workspace profile, navigation and the
 * defaults for new designs. Kept on this device (localStorage), applied live.
 */
import { type LengthUnit, display } from "@whittle/core";
import type { DrawingSettings } from "@whittle/kernel";

export type ThemeId = "daylight" | "daylightdark" | "graphite" | "paper" | "midnight" | "blueprint" | "studio" | "contrast";
export type ThemePref = ThemeId | "system";
export type Accent = "orange" | "blue" | "green" | "violet" | "rose" | "teal" | "amber";
export type Density = "compact" | "comfortable" | "spacious";
/** Who is using Whittle: tunes defaults, hints and which tools are up front. */
export type Profile = "beginner" | "maker" | "engineer" | "designer" | "educator";
export type NavPreset = "whittle" | "middle-pan" | "middle-orbit" | "middle-orbit-shift" | "right-orbit" | "trackpad";

export interface Prefs {
  theme: ThemePref;
  accent: Accent;
  density: Density;
  /** Interface size, 0.85 to 1.3. */
  scale: number;
  /** null until the person picks one on first run. */
  profile: Profile | null;
  units: LengthUnit;
  nav: NavPreset;
  invertZoom: boolean;
  /** The hint line and inline tips. */
  hints: boolean;
  /** Labels under toolbar icons. */
  toolLabels: boolean;
  /** Clicking an edge to round or bevel it also takes the edges that continue smoothly from it. */
  tangentChain: boolean;
  /** Default material for mass estimates. */
  material: string;
  /** The person picked the default material themself (older builds set PLA for them). */
  materialSet?: boolean;
  reduceMotion: boolean;
  /** New shapes become constraint-ready geometry (dimension, constrain, trim, fillet them). */
  smartSketch: boolean | null;
  /** How finely mesh exports (STL, 3MF, OBJ, GLB, PLY) follow curved faces. */
  meshQuality: "draft" | "standard" | "fine";
  /** What the 2D drawing export shows (sheet, scale, projection, section, parts list). */
  drawing?: DrawingSettings;
  /** Single-key shortcuts: Whittle's own, or the classic CAD letters (H hole, J joint, T trim, O offset, P project). */
  keys: "whittle" | "classic";
  /** Send to slicer (desktop): an installed slicer by name, or "" for whatever opens .3mf files. */
  slicer?: string;
  /** The desktop app looks for a newer release once a day. */
  updateCheck: boolean;
  /** Decimal places for measurements and read-outs (0 to 6). */
  precision?: number;
}

export interface ThemeInfo {
  id: ThemeId;
  label: string;
  dark: boolean;
  blurb: string;
  /** Swatch colors for the picker: background, surface, text. */
  swatch: [string, string, string];
}

export const THEMES: ThemeInfo[] = [
  { id: "daylight", label: "Daylight", dark: false, blurb: "Light grey interface with a blue accent.", swatch: ["#dfe2e6", "#f4f5f6", "#0696d7"] },
  { id: "daylightdark", label: "Daylight dark", dark: true, blurb: "Charcoal interface with a blue accent, easy on the eyes.", swatch: ["#25282c", "#34383d", "#0696d7"] },
  { id: "graphite", label: "Graphite", dark: true, blurb: "Warm dark grey. Easy on the eyes for long sessions.", swatch: ["#1b1a18", "#2b2926", "#ece6da"] },
  { id: "paper", label: "Paper", dark: false, blurb: "Warm light, like a drafting table.", swatch: ["#ece8df", "#f8f6f1", "#2b2722"] },
  { id: "midnight", label: "Midnight", dark: true, blurb: "Deep blue-black with crisp contrast.", swatch: ["#0e1117", "#171b24", "#e4e8f1"] },
  { id: "blueprint", label: "Blueprint", dark: true, blurb: "Engineering blue with white linework.", swatch: ["#0f2340", "#163056", "#e8f0ff"] },
  { id: "studio", label: "Studio", dark: true, blurb: "Neutral grey, like product-design tools.", swatch: ["#26272a", "#323337", "#ededee"] },
  { id: "contrast", label: "High contrast", dark: true, blurb: "Maximum legibility: pure black, bright text, bold outlines.", swatch: ["#000000", "#111111", "#ffffff"] },
];

export const ACCENTS: { id: Accent; label: string; color: string }[] = [
  { id: "orange", label: "Theme default", color: "#0696d7" },
  { id: "amber", label: "Amber", color: "#e7b02f" },
  { id: "rose", label: "Rose", color: "#e8607a" },
  { id: "violet", label: "Violet", color: "#9b7ff0" },
  { id: "blue", label: "Blue", color: "#4f93f0" },
  { id: "teal", label: "Teal", color: "#2fb8a8" },
  { id: "green", label: "Green", color: "#5cb85c" },
];

export interface ProfileInfo {
  id: Profile;
  label: string;
  blurb: string;
  icon: "sparkStep" | "print" | "params" | "vector" | "users";
  units: LengthUnit;
  material: string;
  hints: boolean;
}

export const PROFILES: ProfileInfo[] = [
  { id: "beginner", label: "New to 3D design", blurb: "Guided steps, helpful hints everywhere, the essential tools up front.", icon: "sparkStep", units: "mm", material: "steel", hints: true },
  { id: "maker", label: "Maker & hobbyist", blurb: "3D printing, laser cutting, woodworking and home projects.", icon: "print", units: "mm", material: "steel", hints: true },
  { id: "engineer", label: "Engineer & professional", blurb: "Parametric parts, precise dimensions, STEP for manufacturing and other CAD.", icon: "params", units: "mm", material: "steel", hints: false },
  { id: "designer", label: "Product & industrial designer", blurb: "Forms, surfaces and finishes, renders, and handoff to engineering.", icon: "vector", units: "mm", material: "steel", hints: false },
  { id: "educator", label: "Teacher or student", blurb: "Learn and teach CAD: clear steps, explanations and simple sharing.", icon: "users", units: "mm", material: "steel", hints: true },
];

export const NAV_PRESETS: { id: NavPreset; label: string; blurb: string }[] = [
  { id: "whittle", label: "Whittle", blurb: "Left-drag orbits, right- or middle-drag pans, wheel zooms." },
  { id: "middle-pan", label: "Middle button pans", blurb: "Middle-drag pans, Shift + middle-drag orbits, left-drag selects." },
  { id: "middle-orbit", label: "Middle button orbits, Ctrl pans", blurb: "Middle-drag orbits, Ctrl + middle-drag pans, Shift + middle-drag zooms." },
  { id: "middle-orbit-shift", label: "Middle button orbits, Shift pans", blurb: "Middle-drag orbits, Shift + middle-drag pans, Ctrl + middle-drag zooms." },
  { id: "right-orbit", label: "Right button orbits", blurb: "Right-drag orbits, middle-drag or Ctrl + right-drag pans." },
  { id: "trackpad", label: "Trackpad", blurb: "Left-drag orbits, Shift + left-drag pans, Ctrl + left-drag zooms." },
];

import { writeStored } from "./stored";

const KEY = "whittle.prefs";

export const DEFAULT_PREFS: Prefs = {
  theme: "daylight",
  accent: "orange",
  density: "comfortable",
  scale: 1,
  profile: null,
  units: "mm",
  nav: "whittle",
  invertZoom: false,
  hints: true,
  toolLabels: true,
  tangentChain: true,
  material: "steel",
  reduceMotion: false,
  smartSketch: null,
  meshQuality: "standard",
  keys: "whittle",
  updateCheck: true,
};

/** The first look before the person's saved preferences arrive (from this device when there is no server). */
export function loadPrefs(): Prefs {
  let p: Partial<Prefs> = {};
  try {
    p = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Prefs>;
    // Older builds stored only the theme.
    const legacy = localStorage.getItem("whittle.theme");
    if (!p.theme && (legacy === "paper" || legacy === "graphite")) p.theme = legacy;
  } catch {
    /* storage unavailable or damaged: defaults */
  }
  return normalizePrefs(p);
}

/** Fill in defaults and clamp values of preferences read from anywhere. */
export function normalizePrefs(p: Partial<Prefs>): Prefs {
  const out = { ...DEFAULT_PREFS, ...p };
  if (!THEMES.some((t) => t.id === out.theme) && out.theme !== "system") out.theme = DEFAULT_PREFS.theme;
  out.scale = Math.min(1.3, Math.max(0.85, Number(out.scale) || 1));
  if (!["draft", "standard", "fine"].includes(out.meshQuality)) out.meshQuality = "standard";
  if (!NAV_PRESETS.some((n) => n.id === out.nav)) out.nav = DEFAULT_PREFS.nav;
  if (out.keys !== "classic") out.keys = "whittle";
  // Damaged or older stored values fall back too: an unknown unit would make every new design's lengths unreadable.
  if (!ACCENTS.some((a) => a.id === out.accent)) out.accent = DEFAULT_PREFS.accent;
  if (!["compact", "comfortable", "spacious"].includes(out.density)) out.density = DEFAULT_PREFS.density;
  if (!["mm", "cm", "m", "in", "ft"].includes(out.units)) out.units = DEFAULT_PREFS.units;
  if (out.profile !== null && !PROFILES.some((x) => x.id === out.profile)) out.profile = null;
  if (out.drawing && typeof out.drawing !== "object") out.drawing = undefined;
  // Older builds gave most profiles PLA without asking: a general-purpose default unless it was chosen.
  if (out.material === "pla" && !out.materialSet) out.material = DEFAULT_PREFS.material;
  out.updateCheck = out.updateCheck !== false;
  return out;
}

export function savePrefs(p: Prefs) {
  // On a server these go to the database; without one, to this device. Either way they are already applied.
  void writeStored("prefs", p, 500).catch(() => {});
}

/**
 * Whether new shapes become constraint-ready geometry: the person's choice, else on. Then every line and arc of a
 * rectangle can be dimensioned, constrained, trimmed and filleted like any other, and sizes typed while drawing stay as dimensions.
 */
export function smartSketchOn(p: Prefs): boolean {
  return p.smartSketch ?? true;
}

/** The concrete theme for a preference ("system" follows the OS). */
export function resolveTheme(t: ThemePref): ThemeId {
  if (t !== "system") return t;
  try {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "daylight" : "daylightdark";
  } catch {
    return "daylight";
  }
}

/** Apply look-and-feel preferences to the document element. */
export function applyPrefs(p: Prefs, theme: ThemeId) {
  const el = document.documentElement;
  el.dataset.theme = theme;
  el.dataset.accent = p.accent;
  el.dataset.density = p.density;
  el.dataset.motion = p.reduceMotion ? "reduced" : "full";
  el.style.setProperty("--ui-scale", String(p.scale));
  display.digits = Math.max(0, Math.min(6, Math.round(p.precision ?? 2)));
}

/** What a mouse drag does under a navigation preset. */
export function navAction(
  preset: NavPreset,
  button: number,
  mods: { shift: boolean; ctrl: boolean; alt: boolean },
  inSketch: boolean,
): "orbit" | "pan" | "zoom" | "none" {
  const L = button === 0;
  const M = button === 1;
  const R = button === 2;
  switch (preset) {
    case "middle-pan":
      if (M) return mods.shift ? "orbit" : "pan";
      if (R) return inSketch ? "pan" : "none";
      return "none";
    case "middle-orbit":
      if (M) return mods.ctrl ? "pan" : mods.shift ? "zoom" : "orbit";
      if (R) return inSketch ? "pan" : "none";
      return "none";
    case "right-orbit":
      if (R) return mods.ctrl ? "pan" : "orbit";
      if (M) return "pan";
      return "none";
    case "middle-orbit-shift":
      if (M) return mods.shift ? "pan" : mods.ctrl ? "zoom" : "orbit";
      if (R) return inSketch ? "pan" : "none";
      return "none";
    case "trackpad":
      if (L && !inSketch) return mods.shift ? "pan" : mods.ctrl ? "zoom" : "orbit";
      if (M) return "pan";
      if (R) return "pan";
      return "none";
    default:
      if (L) return inSketch ? "none" : "orbit";
      if (M) return mods.shift ? "orbit" : "pan";
      if (R) return inSketch ? "orbit" : "pan";
      return "none";
  }
}
