/**
 * Hole presets from common standards, so nobody has to look up "what size
 * hole for an M4 screw". Picking one fills in the diameter and, for
 * counterbored and countersunk holes, the head size too.
 */
import { useState } from "react";
import type { HoleFeature } from "@whittle/core";
import { updateFeature } from "../state/store";
import { Select } from "./controls";

type Fit = "normal" | "close" | "tap" | "insert";

interface Size {
  id: string;
  label: string;
  /** Millimetres: normal clearance, close clearance, tap drill, heat-set insert (0 = none). */
  normal: number;
  close: number;
  tap: number;
  insert: number;
  /** Socket head cap screw: head diameter and height. */
  cbore: [number, number];
  /** Flat (countersunk) head diameter, 90 degrees. */
  csink: number;
}

const IN = 25.4;

export const METRIC: Size[] = [
  { id: "M2", label: "M2", normal: 2.4, close: 2.2, tap: 1.6, insert: 3.2, cbore: [3.8, 2], csink: 4.4 },
  { id: "M2.5", label: "M2.5", normal: 2.9, close: 2.7, tap: 2.05, insert: 3.5, cbore: [4.5, 2.5], csink: 5.5 },
  { id: "M3", label: "M3", normal: 3.4, close: 3.2, tap: 2.5, insert: 4, cbore: [5.5, 3], csink: 6.72 },
  { id: "M4", label: "M4", normal: 4.5, close: 4.3, tap: 3.3, insert: 5.6, cbore: [7, 4], csink: 8.96 },
  { id: "M5", label: "M5", normal: 5.5, close: 5.3, tap: 4.2, insert: 6.4, cbore: [8.5, 5], csink: 11.2 },
  { id: "M6", label: "M6", normal: 6.6, close: 6.4, tap: 5, insert: 8, cbore: [10, 6], csink: 13.44 },
  { id: "M8", label: "M8", normal: 9, close: 8.4, tap: 6.8, insert: 0, cbore: [13, 8], csink: 17.92 },
  { id: "M10", label: "M10", normal: 11, close: 10.5, tap: 8.5, insert: 0, cbore: [16, 10], csink: 22.4 },
  { id: "M12", label: "M12", normal: 13.5, close: 13, tap: 10.2, insert: 0, cbore: [18, 12], csink: 26.88 },
  { id: "M16", label: "M16", normal: 17.5, close: 17, tap: 14, insert: 0, cbore: [24, 16], csink: 33.6 },
  { id: "M20", label: "M20", normal: 22, close: 21, tap: 17.5, insert: 0, cbore: [30, 20], csink: 40.32 },
];

export const IMPERIAL: Size[] = [
  { id: "#4", label: "#4-40", normal: 0.1285 * IN, close: 0.116 * IN, tap: 0.089 * IN, insert: 0, cbore: [0.183 * IN, 0.112 * IN], csink: 0.255 * IN },
  { id: "#6", label: "#6-32", normal: 0.1495 * IN, close: 0.144 * IN, tap: 0.1065 * IN, insert: 0, cbore: [0.226 * IN, 0.138 * IN], csink: 0.307 * IN },
  { id: "#8", label: "#8-32", normal: 0.177 * IN, close: 0.1695 * IN, tap: 0.136 * IN, insert: 0, cbore: [0.27 * IN, 0.164 * IN], csink: 0.359 * IN },
  { id: "#10", label: "#10-24", normal: 0.201 * IN, close: 0.196 * IN, tap: 0.1495 * IN, insert: 0, cbore: [0.312 * IN, 0.19 * IN], csink: 0.411 * IN },
  { id: "1/4", label: "1/4\"-20", normal: 0.266 * IN, close: 0.257 * IN, tap: 0.201 * IN, insert: 0, cbore: [0.375 * IN, 0.25 * IN], csink: 0.531 * IN },
  { id: "5/16", label: "5/16\"-18", normal: 0.332 * IN, close: 0.323 * IN, tap: 0.257 * IN, insert: 0, cbore: [0.469 * IN, 0.312 * IN], csink: 0.656 * IN },
  { id: "3/8", label: "3/8\"-16", normal: 0.397 * IN, close: 0.386 * IN, tap: 0.3125 * IN, insert: 0, cbore: [0.562 * IN, 0.375 * IN], csink: 0.781 * IN },
  { id: "1/2", label: "1/2\"-13", normal: 0.531 * IN, close: 0.516 * IN, tap: 0.4219 * IN, insert: 0, cbore: [0.75 * IN, 0.5 * IN], csink: 1.031 * IN },
];

const FITS: { value: Fit; label: string; hint: string }[] = [
  { value: "normal", label: "Clearance", hint: "The screw passes through freely" },
  { value: "close", label: "Close fit", hint: "Tighter clearance for accurate location" },
  { value: "tap", label: "Tapped", hint: "Tap drill size: cut a thread into it" },
  { value: "insert", label: "Heat-set insert", hint: "Brass inserts melted into 3D prints" },
];

const mm = (v: number) => `${Math.round(v * 100) / 100} mm`;

export function HoleStandard({ f }: { f: HoleFeature }) {
  const [fit, setFit] = useState<Fit>("normal");
  const [size, setSize] = useState("");
  const apply = (sizeId: string, how: Fit) => {
    const s = [...METRIC, ...IMPERIAL].find((x) => x.id === sizeId);
    if (!s) return;
    const d = s[how];
    if (!d) return;
    updateFeature(f.id, `${s.label} hole`, (draft) => {
      const h = draft as HoleFeature;
      h.diameter = mm(d);
      if (h.style === "counterbore") {
        h.headDiameter = mm(s.cbore[0] + 1);
        h.headDepth = mm(s.cbore[1] + 0.4);
      } else if (h.style === "countersink") {
        h.headDiameter = mm(s.csink + 0.4);
      }
    });
  };
  const sizes = [...METRIC.map((s) => ({ ...s, group: "Metric (ISO)" })), ...IMPERIAL.map((s) => ({ ...s, group: "Inch (UNC)" }))].filter((s) => fit !== "insert" || s.insert > 0);
  return (
    <div className="field-row">
      <Select
        label="Standard"
        value={fit}
        onChange={(v) => {
          setFit(v);
          if (size) apply(size, v);
        }}
        options={FITS}
      />
      <Select
        label="Screw size"
        value={size}
        placeholder="Custom"
        onChange={(v) => {
          setSize(v);
          apply(v, fit);
        }}
        options={sizes.map((s) => ({ value: s.id, label: s.label, group: s.group, hint: s[fit] ? mm(s[fit]) : undefined }))}
      />
    </div>
  );
}
