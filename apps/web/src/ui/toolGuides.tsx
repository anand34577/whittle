/** The longer tooltip: after a pause on a tool, a before/after picture and the steps to follow. */
import type { ReactNode } from "react";

const S = { fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinejoin: "round", strokeLinecap: "round" } as const;
const A = { ...S, stroke: "var(--accent)" } as const;

/** A flat square and the box it becomes. */
const box = (h: number) => (
  <g {...S}>
    <path d={`M8 ${34 - h} l12 -6 l12 6 v${h} l-12 6 l-12 -6 z M8 ${34 - h} l12 6 l12 -6 M20 ${40 - h} v${h}`} />
  </g>
);
const arrow = <path d="M44 26 h14 m-5 -5 l5 5 l-5 5" {...A} />;
const pair = (before: ReactNode, after: ReactNode) => (
  <svg viewBox="0 0 100 52" width="170" height="88" aria-hidden="true">
    <g transform="translate(0 0)">{before}</g>
    {arrow}
    <g transform="translate(62 0) scale(0.9)">{after}</g>
  </svg>
);

export interface Guide {
  summary: string;
  steps: string[];
  art: ReactNode;
}

export const GUIDES: Record<string, Guide> = {
  extrude: { summary: "Pull a flat sketch up into a solid.", steps: ["Draw a closed shape in a sketch.", "Choose Extrude, then drag the dot or type a height.", "Press Enter."], art: pair(<path d="M8 30 l12 -6 l12 6 l-12 6 z" {...S} />, box(14)) },
  revolve: { summary: "Spin a flat profile around an axis.", steps: ["Sketch half of the shape, beside the axis.", "Choose Revolve and pick the axis.", "Drag the dot to set the angle (it clicks into 90° steps)."], art: pair(<path d="M10 14 h8 v24 h-8 z" {...S} />, <g {...S}><ellipse cx="22" cy="14" rx="12" ry="4" /><path d="M10 14 v24 c0 5 24 5 24 0 v-24" /></g>) },
  fillet: { summary: "Round off sharp edges.", steps: ["Choose Fillet, then click the edges.", "Drag the dot, or type a radius.", "Press Enter."], art: pair(box(14), <g {...S}><path d="M8 26 l12 -6 l12 6 v14 l-12 6 l-12 -6 z" strokeDasharray="2 3" /><path d="M10 28 q10 -10 22 0 v12 l-12 6 l-12 -6 z" /></g>) },
  chamfer: { summary: "Cut a flat bevel along an edge.", steps: ["Choose Chamfer, then click the edges.", "Drag the dot or type a distance.", "Press Enter."], art: pair(box(14), <g {...S}><path d="M8 28 l5 -4 h14 l5 4 v12 l-12 6 l-12 -6 z" /></g>) },
  shell: { summary: "Hollow a solid, leaving walls of an even thickness.", steps: ["Choose Shell and click the face to open.", "Drag the dot to set the wall thickness.", "Press Enter."], art: pair(box(14), <g {...S}><path d="M8 26 l12 -6 l12 6 v14 l-12 6 l-12 -6 z" /><path d="M13 28 l7 -3 l7 3 l-7 3 z" /></g>) },
  hole: { summary: "Drill a hole in a flat face.", steps: ["Choose Hole and click the face where it goes.", "Drag the dots for depth and diameter.", "Press Enter."], art: pair(box(14), <g {...S}>{box(14).props.children}<ellipse cx="20" cy="26" rx="5" ry="2.5" /></g>) },
  "press-pull": { summary: "Push or pull a flat face by a distance.", steps: ["Select a face (or edge, or sketch) then press Q.", "Drag the dot out to add, in to remove.", "Press Enter."], art: pair(box(10), box(18)) },
  sketch: { summary: "Start a 2D drawing on a plane or a flat face.", steps: ["Pick a plane or a face.", "Draw with Line, Rectangle, Circle…", "Finish the sketch, then Extrude it."], art: pair(<path d="M8 30 l12 -6 l12 6 l-12 6 z" {...S} strokeDasharray="2 3" />, <path d="M10 32 l10 -8 l10 8 l-10 5 z" {...S} />) },
  loft: { summary: "Blend smoothly from one shape to another.", steps: ["Sketch two or more shapes on different planes.", "Choose Loft and click them in order.", "Press Enter."], art: pair(<g {...S}><ellipse cx="20" cy="40" rx="12" ry="4" /><path d="M12 14 h16 l-3 4 h-10 z" /></g>, <g {...S}><ellipse cx="20" cy="40" rx="12" ry="4" /><path d="M8 40 L12 14 h16 L32 40" /></g>) },
  sweep: { summary: "Move a shape along a path to make a tube, rail or handle.", steps: ["Sketch the cross-section (closed) and a path (open).", "Choose Sweep: profile first, then the path.", "Press Enter."], art: pair(<g {...S}><circle cx="10" cy="36" r="4" /><path d="M10 36 q4 -24 24 -22" strokeDasharray="2 3" /></g>, <g {...S}><path d="M6 36 q4 -26 28 -26 M14 36 q4 -18 20 -18" /><circle cx="10" cy="36" r="4" /></g>) },
  pattern: { summary: "Repeat a body in a row or around a circle.", steps: ["Select the body, choose Pattern.", "Pick Row or Circle, set the count and spacing.", "Press Enter."], art: pair(<g {...S}><rect x="8" y="22" width="8" height="8" /></g>, <g {...S}><rect x="2" y="22" width="8" height="8" /><rect x="14" y="22" width="8" height="8" /><rect x="26" y="22" width="8" height="8" /></g>) },
  mirror: { summary: "Copy a body to the other side of a plane.", steps: ["Choose Mirror and click the body.", "Pick the plane to mirror across.", "Press Enter (Join merges the halves)."], art: pair(<g {...S}><path d="M20 10 v34" strokeDasharray="2 3" /><path d="M8 20 h10 v16 h-10 z" /></g>, <g {...S}><path d="M20 10 v34" strokeDasharray="2 3" /><path d="M8 20 h10 v16 h-10 z M22 20 h10 v16 h-10 z" /></g>) },
  move: { summary: "Move or turn a body, or place a moved copy.", steps: ["Select the body, press M.", "Type distances or angles, or drag the labels to scrub.", "Tick Copy to keep the original. Press Enter."], art: pair(box(10), <g transform="translate(6 -6)">{box(10)}</g>) },
  combine: { summary: "Join bodies, cut one from another, or keep the overlap.", steps: ["Choose Combine, click the body to keep.", "Click the tool bodies.", "Pick Join, Cut or Keep overlap. Press Enter."], art: pair(<g {...S}><rect x="6" y="18" width="18" height="18" /><circle cx="26" cy="27" r="9" /></g>, <g {...S}><path d="M6 18 h18 v4 a9 9 0 0 0 0 10 v4 h-18 z" /></g>) },
  measure: { summary: "Read sizes, distances and angles.", steps: ["Press I.", "Click a face, edge or body for its size.", "Click a second one for the distance and angle between them."], art: pair(box(14), <g {...S}>{box(14).props.children}<path d="M8 44 l12 6 M8 41 v6 M20 47 v6" stroke="var(--accent)" /></g>) },
  section: { summary: "Cut the view open to see inside (the model is unchanged).", steps: ["Choose Section.", "Pick the plane and drag the slider.", "Turn it off when done."], art: pair(box(14), <g {...S}><path d="M8 26 l12 -6 l6 3 v20 l-6 3 l-12 -6 z" /><path d="M20 26 l6 -3" strokeDasharray="2 3" /></g>) },
  "tool-trim": { summary: "Erase the part of a line between crossings.", steps: ["Press and drag across the pieces to remove.", "Hold Shift to extend instead."], art: pair(<g {...S}><path d="M6 20 h30 M14 8 v26" /></g>, <g {...S}><path d="M14 20 h22 M14 20 v14" /></g>) },
  "tool-dimension": { summary: "Fix a size so it stays when you edit other things.", steps: ["Click a line (length) or a circle (radius).", "Type the value in the box that opens.", "Dimensions that repeat what is already fixed show in brackets."], art: pair(<path d="M8 28 h28" {...S} />, <g {...S}><path d="M8 28 h28 M8 22 v12 M36 22 v12 M8 18 h28" /></g>) },
};

export function GuideCard({ guide }: { guide: Guide }) {
  return (
    <div className="tooltip__guide">
      {guide.art}
      <p>{guide.summary}</p>
      <ol>
        {guide.steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
    </div>
  );
}
