import type { Theme } from "../state/store";

export interface ViewportTheme {
  bgTop: string;
  bgBottom: string;
  gridMinor: string;
  gridMajor: string;
  axisX: string;
  axisY: string;
  edge: string;
  edgeOverlay: string;
  hover: string;
  select: string;
  accent: string;
  sketch: string;
  sketchActive: string;
  construction: string;
  /** Fully defined sketch geometry, and geometry in a constraint conflict. */
  defined: string;
  conflict: string;
  plane: string;
  envIntensity: number;
}

export const VIEWPORT_THEMES: Record<Theme, ViewportTheme> = {
  graphite: {
    bgTop: "#33312d",
    bgBottom: "#1b1a18",
    gridMinor: "#403d38",
    gridMajor: "#57534b",
    axisX: "#a85b4c",
    axisY: "#6f8f5e",
    edge: "#141312",
    edgeOverlay: "#e8e2d6",
    hover: "#ffb27a",
    select: "#7fd0f0",
    accent: "#ff7a2e",
    sketch: "#d9d2c3",
    sketchActive: "#f2ecdf",
    construction: "#8a857a",
    defined: "#7ccf8a",
    conflict: "#ff6b5e",
    plane: "#7fd0f0",
    envIntensity: 0.55,
  },
  paper: {
    bgTop: "#f7f4ee",
    bgBottom: "#e2ddd3",
    gridMinor: "#d6d0c4",
    gridMajor: "#bdb6a7",
    axisX: "#c8705e",
    axisY: "#6f9a5c",
    edge: "#2a2722",
    edgeOverlay: "#2a2722",
    hover: "#e8742f",
    select: "#2f7fb8",
    accent: "#e0611c",
    sketch: "#3d3931",
    sketchActive: "#1b1916",
    construction: "#9a9488",
    defined: "#2f8a4a",
    conflict: "#c8332b",
    plane: "#2f7fb8",
    envIntensity: 0.75,
  },
  midnight: {
    bgTop: "#1f2533",
    bgBottom: "#0b0d12",
    gridMinor: "#252b38",
    gridMajor: "#343c4e",
    axisX: "#c0605a",
    axisY: "#5d9a6a",
    edge: "#07080b",
    edgeOverlay: "#dfe6f5",
    hover: "#ffb27a",
    select: "#6fc8ff",
    accent: "#ff7a2e",
    sketch: "#cfd8ea",
    sketchActive: "#f2f6ff",
    construction: "#7d879c",
    defined: "#7ccf8a",
    conflict: "#ff6b5e",
    plane: "#6fc8ff",
    envIntensity: 0.5,
  },
  blueprint: {
    bgTop: "#1d3d6b",
    bgBottom: "#0d2140",
    gridMinor: "#24497c",
    gridMajor: "#3a6aa8",
    axisX: "#e88a7a",
    axisY: "#8fd6a0",
    edge: "#e8f0ff",
    edgeOverlay: "#ffffff",
    hover: "#ffd27a",
    select: "#7fe8ff",
    accent: "#ffcf5a",
    sketch: "#ffffff",
    sketchActive: "#ffffff",
    construction: "#9fb8dc",
    defined: "#7ccf8a",
    conflict: "#ff6b5e",
    plane: "#7fe8ff",
    envIntensity: 0.6,
  },
  studio: {
    bgTop: "#45464b",
    bgBottom: "#232427",
    gridMinor: "#4a4b50",
    gridMajor: "#5c5e64",
    axisX: "#c46a5c",
    axisY: "#6e9c62",
    edge: "#121214",
    edgeOverlay: "#ececee",
    hover: "#ffb27a",
    select: "#5fb7ff",
    accent: "#ff8a3d",
    sketch: "#e2e2e5",
    sketchActive: "#ffffff",
    construction: "#8c8d93",
    defined: "#7ccf8a",
    conflict: "#ff6b5e",
    plane: "#5fb7ff",
    envIntensity: 0.6,
  },
  contrast: {
    bgTop: "#000000",
    bgBottom: "#000000",
    gridMinor: "#262626",
    gridMajor: "#4d4d4d",
    axisX: "#ff5c5c",
    axisY: "#5cff7a",
    edge: "#ffffff",
    edgeOverlay: "#ffffff",
    hover: "#ffd400",
    select: "#00e5ff",
    accent: "#ffd400",
    sketch: "#ffffff",
    sketchActive: "#ffffff",
    construction: "#a6a6a6",
    defined: "#7ccf8a",
    conflict: "#ff6b5e",
    plane: "#00e5ff",
    envIntensity: 0.7,
  },
};