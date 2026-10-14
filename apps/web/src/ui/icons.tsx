/**
 * Whittle's own icon set: 20px grid, 1.5px stroke, isometric hints for 3D
 * operations. Drawn for this app (not a stock pack) so tools read as CAD.
 */
import type { JSX, SVGProps } from "react";

const P = {
  // ── Create ─────────────────────────────────────────
  sketch: (
    <>
      <path d="M3 15.5 L10 12 L17 15.5 L10 19 Z" opacity=".55" />
      <path d="M11.5 3.5 L15 7 L8.5 13.5 L5 14 L5.5 10.5 Z" />
      <path d="M10 5 L13.5 8.5" />
    </>
  ),
  finish: (
    <>
      <rect x="3" y="3" width="14" height="14" rx="1.5" />
      <path d="M6.5 10.2 L9 12.7 L13.8 7.5" />
    </>
  ),
  extrude: (
    <>
      <path d="M4 14 L10 17 L16 14 L10 11 Z" />
      <path d="M4 14 V8 L10 11 V17 M16 14 V8 L10 11" opacity=".55" />
      <path d="M4 8 L10 5 L16 8" opacity=".55" />
      <path d="M10 9 V1.8 M7.6 4.2 L10 1.8 L12.4 4.2" />
    </>
  ),
  revolve: (
    <>
      <path d="M10 2.5 V17.5" strokeDasharray="1.6 1.8" />
      <path d="M10 5 H13.5 V9 L15.5 12 V15 H10" />
      <path d="M4.2 7.5 A6.5 3 0 0 0 4.5 13.5" opacity=".6" />
      <path d="M3 11.6 L4.5 13.6 L6.6 12.4" opacity=".6" />
    </>
  ),
  fillet: (
    <>
      <path d="M3.5 16.5 H9 A7.5 7.5 0 0 0 16.5 9 V3.5" />
      <path d="M3.5 16.5 V3.5 H16.5" opacity=".35" strokeDasharray="1.6 1.8" />
    </>
  ),
  chamfer: (
    <>
      <path d="M3.5 16.5 H9 L16.5 9 V3.5" />
      <path d="M3.5 16.5 V3.5 H16.5" opacity=".35" strokeDasharray="1.6 1.8" />
    </>
  ),
  shell: (
    <>
      <path d="M3 7 L10 3.5 L17 7 V14 L10 17.5 L3 14 Z" />
      <path d="M6 7.8 L10 5.8 L14 7.8 V12.6 L10 14.6 L6 12.6 Z" opacity=".6" />
    </>
  ),
  box: (
    <>
      <path d="M3 6.5 L10 3 L17 6.5 V13.5 L10 17 L3 13.5 Z" />
      <path d="M3 6.5 L10 10 L17 6.5 M10 10 V17" opacity=".6" />
    </>
  ),
  cylinder: (
    <>
      <ellipse cx="10" cy="5.5" rx="6" ry="2.5" />
      <path d="M4 5.5 V14.5 A6 2.5 0 0 0 16 14.5 V5.5" />
    </>
  ),
  sphere: (
    <>
      <circle cx="10" cy="10" r="7" />
      <ellipse cx="10" cy="10" rx="7" ry="2.6" opacity=".55" />
    </>
  ),
  mirror: (
    <>
      <path d="M10 2.5 V17.5" strokeDasharray="1.6 1.8" />
      <path d="M7.5 5 L3 14 H7.5 Z" />
      <path d="M12.5 5 L17 14 H12.5 Z" opacity=".6" />
    </>
  ),
  pattern: (
    <>
      <rect x="2.5" y="7" width="4" height="6" rx=".6" />
      <rect x="8" y="7" width="4" height="6" rx=".6" opacity=".7" />
      <rect x="13.5" y="7" width="4" height="6" rx=".6" opacity=".45" />
    </>
  ),
  // ── Sketch tools ───────────────────────────────────
  line: (
    <>
      <path d="M4 15 L9 6 L16 12" />
      <circle cx="4" cy="15" r="1.4" fill="currentColor" />
      <circle cx="9" cy="6" r="1.4" fill="currentColor" />
      <circle cx="16" cy="12" r="1.4" fill="currentColor" />
    </>
  ),
  rect: (
    <>
      <rect x="3.5" y="5.5" width="13" height="9" rx=".5" />
      <circle cx="3.5" cy="5.5" r="1.3" fill="currentColor" />
      <circle cx="16.5" cy="14.5" r="1.3" fill="currentColor" />
    </>
  ),
  circle: (
    <>
      <circle cx="10" cy="10" r="6.5" />
      <path d="M10 10 L14.6 5.4" opacity=".6" />
      <circle cx="10" cy="10" r="1.2" fill="currentColor" />
    </>
  ),
  polygon: (
    <>
      <path d="M10 3.2 L16.3 6.6 V13.4 L10 16.8 L3.7 13.4 V6.6 Z" />
      <circle cx="10" cy="10" r="1.1" fill="currentColor" />
    </>
  ),
  slot: (
    <>
      <path d="M6.5 6.5 H13.5 A3.5 3.5 0 0 1 13.5 13.5 H6.5 A3.5 3.5 0 0 1 6.5 6.5 Z" />
      <path d="M6.5 10 H13.5" opacity=".5" strokeDasharray="1.4 1.6" />
    </>
  ),
  select: <path d="M5 3.5 L15 10 L10.4 11 L13 16.2 L11.2 17 L8.6 11.9 L5 14.8 Z" />,
  construction: <path d="M3.5 16.5 L16.5 3.5" strokeDasharray="2 2" />,
  // ── Document / UI ──────────────────────────────────
  undo: (
    <>
      <path d="M7 5 L3.5 8.5 L7 12" />
      <path d="M3.8 8.5 H12 A4.5 4.5 0 0 1 12 17.5 H8" />
    </>
  ),
  redo: (
    <>
      <path d="M13 5 L16.5 8.5 L13 12" />
      <path d="M16.2 8.5 H8 A4.5 4.5 0 0 0 8 17.5 H12" />
    </>
  ),
  save: (
    <>
      <path d="M4 3.5 H13.5 L16.5 6.5 V16.5 H4 Z" />
      <path d="M7 3.5 V7.5 H12.5 V3.5 M7 16.5 V11.5 H13 V16.5" opacity=".6" />
    </>
  ),
  open: (
    <>
      <path d="M2.5 15.5 V4.5 H8 L9.8 6.5 H16 V9" />
      <path d="M2.5 15.5 L5 9 H18 L15.5 15.5 Z" />
    </>
  ),
  file: (
    <>
      <path d="M5 2.5 H11.5 L15 6 V17.5 H5 Z" />
      <path d="M11.5 2.5 V6 H15" opacity=".6" />
    </>
  ),
  export: (
    <>
      <path d="M10 12.5 V2.5 M6.5 6 L10 2.5 L13.5 6" />
      <path d="M4 10.5 V17 H16 V10.5" />
    </>
  ),
  params: (
    <>
      <path d="M8.5 16.5 C9.5 16.5 10 15.5 10.2 14 L11.5 5.5 C11.8 4 12.5 3.5 13.5 3.5" />
      <path d="M8 8.5 H13.5" />
      <path d="M13 11 L17 16 M17 11 L13 16" opacity=".65" />
    </>
  ),
  eye: (
    <>
      <path d="M2 10 C4.5 5.5 15.5 5.5 18 10 C15.5 14.5 4.5 14.5 2 10 Z" />
      <circle cx="10" cy="10" r="2.4" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M2 10 C4.5 5.5 15.5 5.5 18 10 C15.5 14.5 4.5 14.5 2 10 Z" opacity=".4" />
      <path d="M3.5 16.5 L16.5 3.5" />
    </>
  ),
  body: (
    <>
      <path d="M3.5 6.5 L10 3.2 L16.5 6.5 V13.5 L10 16.8 L3.5 13.5 Z" />
      <path d="M3.5 6.5 L10 9.8 L16.5 6.5 M10 9.8 V16.8" opacity=".55" />
    </>
  ),
  plane: <path d="M2.5 13 L7.5 6 H17.5 L12.5 13 Z" />,
  origin: (
    <>
      <path d="M10 10 V3 M10 10 L16 13.5 M10 10 L4 13.5" />
      <circle cx="10" cy="10" r="1.5" fill="currentColor" />
    </>
  ),
  chevronDown: <path d="M5.5 8 L10 12.5 L14.5 8" />,
  chevronRight: <path d="M8 5.5 L12.5 10 L8 14.5" />,
  close: <path d="M5 5 L15 15 M15 5 L5 15" />,
  check: <path d="M4.5 10.5 L8.3 14.2 L15.5 6.5" />,
  search: (
    <>
      <circle cx="8.8" cy="8.8" r="5.3" />
      <path d="M12.8 12.8 L17 17" />
    </>
  ),
  plus: <path d="M10 4 V16 M4 10 H16" />,
  trash: (
    <>
      <path d="M3.5 5.5 H16.5 M8 5.5 V3.5 H12 V5.5" />
      <path d="M5 5.5 L6 17 H14 L15 5.5" />
    </>
  ),
  more: (
    <>
      <circle cx="4.5" cy="10" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="10" cy="10" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="15.5" cy="10" r="1.3" fill="currentColor" stroke="none" />
    </>
  ),
  sun: (
    <>
      <circle cx="10" cy="10" r="3.5" />
      <path d="M10 1.8 V4 M10 16 V18.2 M1.8 10 H4 M16 10 H18.2 M4.2 4.2 L5.7 5.7 M14.3 14.3 L15.8 15.8 M4.2 15.8 L5.7 14.3 M14.3 5.7 L15.8 4.2" />
    </>
  ),
  moon: <path d="M15.5 12.8 A6.5 6.5 0 0 1 7.2 4.5 A6.5 6.5 0 1 0 15.5 12.8 Z" />,
  help: (
    <>
      <circle cx="10" cy="10" r="7.5" />
      <path d="M7.6 7.8 A2.5 2.5 0 1 1 10.8 10.2 C10.2 10.5 10 11 10 11.8" />
      <circle cx="10" cy="14.4" r=".9" fill="currentColor" stroke="none" />
    </>
  ),
  warning: (
    <>
      <path d="M10 3 L18 16.5 H2 Z" />
      <path d="M10 8 V11.8" />
      <circle cx="10" cy="14" r=".9" fill="currentColor" stroke="none" />
    </>
  ),
  error: (
    <>
      <circle cx="10" cy="10" r="7.5" />
      <path d="M7.3 7.3 L12.7 12.7 M12.7 7.3 L7.3 12.7" />
    </>
  ),
  suppress: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M5 15 L15 5" />
    </>
  ),
  home: (
    <>
      <path d="M3.5 9.5 L10 3.8 L16.5 9.5" />
      <path d="M5.5 8 V16.5 H14.5 V8" />
    </>
  ),
  measure: (
    <>
      <path d="M2.5 13 L13 2.5 L17.5 7 L7 17.5 Z" />
      <path d="M6 9.5 L7.8 11.3 M8.5 7 L10.3 8.8 M11 4.5 L12.8 6.3" opacity=".7" />
    </>
  ),
  rollback: (
    <>
      <path d="M10 2.5 V17.5" />
      <path d="M10 4 L15.5 6.5 L10 9" fill="currentColor" />
    </>
  ),
  edit: (
    <>
      <path d="M12.5 3.5 L16.5 7.5 L7.5 16.5 H3.5 V12.5 Z" />
      <path d="M10.5 5.5 L14.5 9.5" opacity=".6" />
    </>
  ),
  cube: (
    <>
      <path d="M3.5 6.5 L10 3.2 L16.5 6.5 V13.5 L10 16.8 L3.5 13.5 Z" />
      <path d="M3.5 6.5 L10 9.8 L16.5 6.5 M10 9.8 V16.8" opacity=".55" />
    </>
  ),
  // ── Second wave ───────────────────────────────────
  loft: (
    <>
      <path d="M3.5 15 L10 18 L16.5 15 L10 12 Z" />
      <ellipse cx="10" cy="4.5" rx="4" ry="1.8" />
      <path d="M3.5 15 L6 4.5 M16.5 15 L14 4.5" opacity=".6" />
    </>
  ),
  hole: (
    <>
      <path d="M2.5 9 L10 5.5 L17.5 9 L10 12.5 Z" />
      <path d="M2.5 9 V12.5 L10 16 L17.5 12.5 V9" opacity=".5" />
      <ellipse cx="10" cy="9" rx="2.6" ry="1.3" />
      <path d="M7.4 9 V12.6 M12.6 9 V12.6" strokeDasharray="1.2 1.4" opacity=".7" />
    </>
  ),
  cone: (
    <>
      <path d="M10 2.5 L4 15 M10 2.5 L16 15" />
      <ellipse cx="10" cy="15" rx="6" ry="2.3" />
    </>
  ),
  torus: (
    <>
      <ellipse cx="10" cy="10" rx="7.5" ry="4.5" />
      <path d="M6.5 9.8 Q10 13 13.5 9.8 M7.6 10.6 Q10 8.5 12.4 10.6" />
    </>
  ),
  tube: (
    <>
      <ellipse cx="10" cy="5" rx="6" ry="2.3" />
      <ellipse cx="10" cy="5" rx="3" ry="1.1" opacity=".6" />
      <path d="M4 5 V15 A6 2.3 0 0 0 16 15 V5" />
    </>
  ),
  library: (
    <>
      <rect x="3" y="3" width="6" height="6" rx="1" />
      <circle cx="14" cy="6" r="3" />
      <path d="M3.5 16.5 L6 12 L8.5 16.5 Z" />
      <path d="M11 14 L14 11 L17 14 L14 17 Z" />
    </>
  ),
  import: (
    <>
      <path d="M10 2.5 V11.5 M6.5 8 L10 11.5 L13.5 8" />
      <path d="M3 12.5 V16.5 H17 V12.5" />
    </>
  ),
  move: (
    <>
      <path d="M10 2.5 V17.5 M2.5 10 H17.5" />
      <path d="M8 4.5 L10 2.5 L12 4.5 M8 15.5 L10 17.5 L12 15.5 M4.5 8 L2.5 10 L4.5 12 M15.5 8 L17.5 10 L15.5 12" />
    </>
  ),
  combine: (
    <>
      <circle cx="7.5" cy="10" r="5" />
      <circle cx="12.5" cy="10" r="5" opacity=".6" />
    </>
  ),
  section: (
    <>
      <path d="M3 7 L10 3.5 L17 7 V14 L10 17.5 L3 14 Z" opacity=".5" />
      <path d="M10 2 V18" />
      <path d="M10 6 L15.5 8.7 V14.5 L10 17.5" fill="currentColor" fillOpacity=".22" stroke="none" />
    </>
  ),
  overhang: (
    <>
      <path d="M3 16.5 H17" opacity=".5" />
      <path d="M5.5 16.5 V8 H16 V11 H9 V16.5" />
      <path d="M11 13.5 V15 M13.5 13.5 V15" strokeDasharray="1 1.3" />
    </>
  ),
  grid: <path d="M3 7 H17 M3 13 H17 M7 3 V17 M13 3 V17" />,
  ortho: (
    <>
      <rect x="3.5" y="6" width="9" height="9" />
      <path d="M3.5 6 L7.5 2.5 H16.5 V11.5 L12.5 15 M12.5 6 L16.5 2.5" opacity=".6" />
    </>
  ),
  wire: (
    <>
      <path d="M3 6.5 L10 3 L17 6.5 V13.5 L10 17 L3 13.5 Z" />
      <path d="M3 6.5 L10 10 L17 6.5 M10 10 V17" />
      <path d="M3 13.5 L10 10 L17 13.5 M10 3 V10" strokeDasharray="1.2 1.5" opacity=".6" />
    </>
  ),
  xray: (
    <>
      <path d="M3 6.5 L10 3 L17 6.5 V13.5 L10 17 L3 13.5 Z" fill="currentColor" fillOpacity=".12" />
      <path d="M3 6.5 L10 10 L17 6.5 M10 10 V17" opacity=".5" />
      <circle cx="10" cy="10" r="2.2" />
    </>
  ),
  shaded: (
    <>
      <path d="M3 6.5 L10 3 L17 6.5 L10 10 Z" fill="currentColor" fillOpacity=".55" stroke="none" />
      <path d="M10 10 L17 6.5 V13.5 L10 17 Z" fill="currentColor" fillOpacity=".3" stroke="none" />
      <path d="M3 6.5 L10 10 V17 L3 13.5 Z" fill="currentColor" fillOpacity=".8" stroke="none" />
    </>
  ),
  camera: (
    <>
      <path d="M2.5 6.5 H6 L7.5 4.5 H12.5 L14 6.5 H17.5 V15.5 H2.5 Z" />
      <circle cx="10" cy="10.8" r="3" />
    </>
  ),
  ellipse: <ellipse cx="10" cy="10" rx="7.5" ry="4.5" />,
  text: (
    <>
      <path d="M4 5 V3.5 H16 V5 M10 3.5 V16.5 M7.5 16.5 H12.5" />
    </>
  ),
  gear: (
    <>
      <path d="M8.6 2.5 H11.4 L11.9 4.6 L13.6 5.4 L15.5 4.3 L17.2 6.5 L15.8 8.1 L16.1 10 L17.6 11.5 L16.3 14 L14.2 13.6 L12.8 15 L12.6 17.2 H9.6 L9 15.2 L7.2 14.4 L5.3 15.5 L3.6 13.4 L5 11.7 L4.8 9.8 L3 8.4 L4.2 5.9 L6.3 6.3 L7.8 4.8 Z" />
      <circle cx="10.3" cy="9.9" r="2.4" />
    </>
  ),
  duplicate: (
    <>
      <rect x="3" y="7" width="10" height="10" rx="1.2" />
      <path d="M7 4.5 V3 H17 V13 H15.5" opacity=".6" />
    </>
  ),
  rotate: (
    <>
      <path d="M16 10 A6 6 0 1 1 13.5 5.2" />
      <path d="M13 2.5 L13.7 5.4 L10.8 6.1" />
    </>
  ),
  isolate: (
    <>
      <circle cx="10" cy="10" r="3" />
      <path d="M2.5 6 V2.5 H6 M14 2.5 H17.5 V6 M17.5 14 V17.5 H14 M6 17.5 H2.5 V14" />
    </>
  ),
  fit: (
    <>
      <path d="M2.5 7 V2.5 H7 M13 2.5 H17.5 V7 M17.5 13 V17.5 H13 M7 17.5 H2.5 V13" />
      <rect x="6.5" y="6.5" width="7" height="7" rx="1" opacity=".6" />
    </>
  ),
  print: (
    <>
      <path d="M7 2.5 H13 V6 L11 8.5 H9 L7 6 Z" />
      <path d="M10 8.5 V10" />
      <path d="M4 13 H16 M3 16.5 H17" />
      <path d="M6.5 13 V11.8 H13.5 V13" opacity=".6" />
    </>
  ),
  layers: (
    <>
      <path d="M10 3 L17.5 7 L10 11 L2.5 7 Z" />
      <path d="M2.5 10.5 L10 14.5 L17.5 10.5 M2.5 14 L10 18 L17.5 14" opacity=".6" />
    </>
  ),
  keyboard: (
    <>
      <rect x="2" y="5" width="16" height="10" rx="1.5" />
      <path d="M5 8.5 H6 M8.5 8.5 H9.5 M12 8.5 H13 M15 8.5 H15.2 M6 12 H14" />
    </>
  ),
  sparkStep: (
    <>
      <circle cx="10" cy="10" r="7.5" />
      <path d="M8 6.5 L12.5 10 L8 13.5" />
    </>
  ),
  // ── Files, accounts, history ───────────────────────
  history: (
    <>
      <path d="M3.5 10 A6.5 6.5 0 1 0 5.4 5.4" />
      <path d="M3 3.5 V6.5 H6" />
      <path d="M10 6.5 V10 L12.6 11.6" />
    </>
  ),
  cloud: (
    <>
      <path d="M6 15.5 H14.5 A3.5 3.5 0 0 0 14 8.5 A4.5 4.5 0 0 0 5.4 9.6 A3 3 0 0 0 6 15.5 Z" />
    </>
  ),
  folder: (
    <>
      <path d="M2.5 5.5 V15 A1 1 0 0 0 3.5 16 H16.5 A1 1 0 0 0 17.5 15 V7.5 A1 1 0 0 0 16.5 6.5 H9.5 L8 4.5 H3.5 A1 1 0 0 0 2.5 5.5 Z" />
    </>
  ),
  key: (
    <>
      <circle cx="6.5" cy="13.5" r="3.5" />
      <path d="M9 11 L16.5 3.5 M13.5 6.5 L15.5 8.5 M15 5 L16.8 6.8" />
    </>
  ),
  users: (
    <>
      <circle cx="7.5" cy="7" r="3" />
      <path d="M2.5 16.5 C3 13.5 5 12 7.5 12 C10 12 12 13.5 12.5 16.5" />
      <path d="M13 4.3 A2.6 2.6 0 0 1 13 9.4 M14.5 12.3 C16.2 12.9 17.2 14.3 17.5 16.5" opacity=".6" />
    </>
  ),
  logout: (
    <>
      <path d="M8 3.5 H4.5 A1 1 0 0 0 3.5 4.5 V15.5 A1 1 0 0 0 4.5 16.5 H8" />
      <path d="M8.5 10 H16.5 M13.5 7 L16.5 10 L13.5 13" />
    </>
  ),
  arrowLeft: <path d="M15.5 10 H4.5 M8.5 6 L4.5 10 L8.5 14" />,
  arrowRight: <path d="M4.5 10 H15.5 M11.5 6 L15.5 10 L11.5 14" />,
  vector: (
    <>
      <path d="M4 15 C6 6 14 14 16 5" />
      <rect x="2.5" y="13.5" width="3" height="3" rx=".5" />
      <rect x="14.5" y="3.5" width="3" height="3" rx=".5" />
    </>
  ),
  drawing: (
    <>
      <rect x="3" y="3" width="14" height="14" rx="1" />
      <path d="M6 13 L9 7 L11 11 L12.5 9 L14 13 Z" />
    </>
  ),
  settings: (
    <>
      <circle cx="10" cy="10" r="2.6" />
      <path d="M10 2.5 V4.6 M10 15.4 V17.5 M2.5 10 H4.6 M15.4 10 H17.5 M4.7 4.7 L6.2 6.2 M13.8 13.8 L15.3 15.3 M4.7 15.3 L6.2 13.8 M13.8 6.2 L15.3 4.7" />
    </>
  ),
} satisfies Record<string, JSX.Element>;

export type IconName = keyof typeof P;

export function Icon({ name, size = 20, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {P[name]}
    </svg>
  );
}