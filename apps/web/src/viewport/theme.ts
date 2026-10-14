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
    plane: "#2f7fb8",
    envIntensity: 0.75,
  },
};