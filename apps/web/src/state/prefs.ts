/**
 * Personal preferences: look and feel, workspace profile, navigation and the
 * defaults for new designs. Kept on this device (localStorage), applied live.
 */
import type { LengthUnit } from "@whittle/core";

export type ThemeId = "graphite" | "paper" | "midnight" | "blueprint" | "studio" | "contrast";
export type ThemePref = ThemeId | "system";
export type Accent = "orange" | "blue" | "green" | "violet" | "rose" | "teal" | "amber";
export type Density = "compact" | "comfortable" | "spacious";
/** Who is using Whittle: tunes defaults, hints and which tools are up front. */
export type Profile = "beginner" | "maker" | "engineer" | "designer" | "educator";
export type NavPreset = "whittle" | "fusion" | "solidworks" | "onshape" | "blender" | "trackpad";

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
  /** Default material for mass estimates. */
  material: string;
  reduceMotion: boolean;
  /** New shapes become constraint-ready geometry (dimension, constrain, trim, fillet them). */
  smartSketch: boolean | null;
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
  { id: "graphite", label: "Graphite", dark: true, blurb: "Warm dark grey. Easy on the eyes for long sessions.", swatch: ["#1b1a18", "#2b2926", "#ece6da"] },
  { id: "paper", label: "Paper", dark: false, blurb: "Warm light, like a drafting table.", swatch: ["#ece8df", "#f8f6f1", "#2b2722"] },
  { id: "midnight", label: "Midnight", dark: true, blurb: "Deep blue-black with crisp contrast.", swatch: ["#0e1117", "#171b24", "#e4e8f1"] },
  { id: "blueprint", label: "Blueprint", dark: true, blurb: "Engineering blue with white linework.", swatch: ["#0f2340", "#163056", "#e8f0ff"] },
  { id: "studio", label: "Studio", dark: true, blurb: "Neutral grey, like product-design tools.", swatch: ["#26272a", "#323337", "#ededee"] },
  { id: "contrast", label: "High contrast", dark: true, blurb: "Maximum legibility: pure black, bright text, bold outlines.", swatch: ["#000000", "#111111", "#ffffff"] },
];

export const ACCENTS: { id: Accent; label: string; color: string }[] = [
  { id: "orange", label: "Marking orange", color: "#f08a3c" },
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
  { id: "beginner", label: "New to 3D design", blurb: "Guided steps, helpful hints everywhere, the essential tools up front.", icon: "sparkStep", units: "mm", material: "pla", hints: true },
  { id: "maker", label: "Maker & hobbyist", blurb: "3D printing, laser cutting, woodworking and home projects.", icon: "print", units: "mm", material: "pla", hints: true },
  { id: "engineer", label: "Engineer & professional", blurb: "Parametric parts, precise dimensions, STEP for manufacturing and other CAD.", icon: "params", units: "mm", material: "al", hints: false },
  { id: "designer", label: "Product & industrial designer", blurb: "Forms, surfaces and finishes, renders, and handoff to engineering.", icon: "vector", units: "mm", material: "abs", hints: false },
  { id: "educator", label: "Teacher or student", blurb: "Learn and teach CAD: clear steps, explanations and simple sharing.", icon: "users", units: "mm", material: "pla", hints: true },
];

export const NAV_PRESETS: { id: NavPreset; label: string; blurb: string }[] = [
  { id: "whittle", label: "Whittle", blurb: "Left-drag orbits, right- or middle-drag pans, wheel zooms." },
  { id: "fusion", label: "Fusion 360", blurb: "Middle-drag pans, Shift + middle-drag orbits, left-drag selects." },
  { id: "solidworks", label: "SolidWorks", blurb: "Middle-drag orbits, Ctrl + middle-drag pans, Shift + middle-drag zooms." },
  { id: "onshape", label: "Onshape", blurb: "Right-drag orbits, middle-drag or Ctrl + right-drag pans." },
  { id: "blender", label: "Blender", blurb: "Middle-drag orbits, Shift + middle-drag pans, Ctrl + middle-drag zooms." },
  { id: "trackpad", label: "Trackpad", blurb: "Left-drag orbits, Shift + left-drag pans, Ctrl + left-drag zooms." },
];

const KEY = "whittle.prefs";

export const DEFAULT_PREFS: Prefs = {
  theme: "graphite",
  accent: "orange",
  density: "comfortable",
  scale: 1,
  profile: null,
  units: "mm",
  nav: "whittle",
  invertZoom: false,
  hints: true,
  toolLabels: true,
  material: "pla",
  reduceMotion: false,
  smartSketch: null,
};

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
  const out = { ...DEFAULT_PREFS, ...p };
  if (!THEMES.some((t) => t.id === out.theme) && out.theme !== "system") out.theme = DEFAULT_PREFS.theme;
  out.scale = Math.min(1.3, Math.max(0.85, Number(out.scale) || 1));
  return out;
}

export function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* not persisted, still applied */
  }
}

/** Whether new shapes become constraint-ready geometry: the person's choice, else on for engineers and designers. */
export function smartSketchOn(p: Prefs): boolean {
  return p.smartSketch ?? (p.profile === "engineer" || p.profile === "designer");
}

/** The concrete theme for a preference ("system" follows the OS). */
export function resolveTheme(t: ThemePref): ThemeId {
  if (t !== "system") return t;
  try {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "paper" : "graphite";
  } catch {
    return "graphite";
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
    case "fusion":
      if (M) return mods.shift ? "orbit" : "pan";
      if (R) return inSketch ? "pan" : "none";
      return "none";
    case "solidworks":
      if (M) return mods.ctrl ? "pan" : mods.shift ? "zoom" : "orbit";
      if (R) return inSketch ? "pan" : "none";
      return "none";
    case "onshape":
      if (R) return mods.ctrl ? "pan" : "orbit";
      if (M) return "pan";
      return "none";
    case "blender":
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
