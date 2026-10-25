/** Property editors for each feature type (shown in the right-hand panel). */
import type { Draft } from "immer";
import { useEffect, useRef, useState } from "react";
import { CONSTRUCT_MODES, CURVE_SOURCES, SURFACE_OPS } from "@whittle/core";
import type {
  BodyOp,
  ChamferFeature,
  CombineFeature,
  ExtrudeFeature,
  Feature,
  FilletFeature,
  HoleFeature,
  Id,
  ImportFeature,
  LoftFeature,
  MirrorFeature,
  MoveFeature,
  PatternFeature,
  PrimitiveFeature,
  RevolveFeature,
  ShellFeature,
  SketchFeature,
  SweepFeature,
  CoilFeature,
  SplitFeature,
  OffsetFeature,
  BoundingSolidFeature,
  ScaleFeature,
  ConstructionPlaneFeature,
  ConstructFeature,
  CurveFeature,
  SurfaceFeature,
  RibFeature,
  ThreadFeature,
  ReplaceFaceFeature,
  DeleteFaceFeature,
  AlignFeature,
  BoundaryFillFeature,
  JointFeature,
  PlaneRef,
  DraftFeature,
  OffsetFaceFeature,
} from "@whittle/core";
import { setBodyOp, setPrefs, setView, updateFeature, useApp } from "../state/store";
import { ExprInput, Segmented, Toggle } from "./ExprInput";
import { Checkbox, Disclosure, Select } from "./controls";
import { HoleStandard } from "./HoleStandards";
import { Icon } from "./icons";

function upd<T extends Feature>(f: T, label: string, recipe: (d: Draft<T>) => void, key?: string) {
  updateFeature(f.id, label, (d) => recipe(d as Draft<T>), key ?? f.id + label);
}

const OPS: { value: BodyOp; label: string; title: string }[] = [
  { value: "new", label: "New body", title: "Create a separate body" },
  { value: "join", label: "Join", title: "Add material to a body" },
  { value: "cut", label: "Cut", title: "Remove material" },
  { value: "intersect", label: "Intersect", title: "Keep only where they overlap" },
];

const AUTO = "__auto__";

/** Construction planes or axes defined before feature `id`, for pickers. */
function constructsBefore(features: Feature[], id: Id, want: "plane" | "axis") {
  const idx = features.findIndex((x) => x.id === id);
  return features.slice(0, idx < 0 ? features.length : idx).filter((x) => (want === "plane" ? x.type === "cplane" || (x.type === "construct" && (x.mode.startsWith("plane") || x.mode === "midplane")) : x.type === "construct" && x.mode.startsWith("axis")));
}

const ORIGIN_PLANES = [
  { value: "YZ", label: "YZ plane (left/right)", icon: "plane" as const },
  { value: "XZ", label: "XZ plane (front/back)", icon: "plane" as const },
  { value: "XY", label: "XY plane (top/bottom)", icon: "plane" as const },
];
const ORIGIN_AXES = [
  { value: "x", label: "X axis", icon: "axis" as const },
  { value: "y", label: "Y axis", icon: "axis" as const },
  { value: "z", label: "Z axis", icon: "axis" as const },
];

function BodySelect({ value, onChange, allowAuto, exclude, label = "Body" }: { value?: Id; onChange: (v: Id | undefined) => void; allowAuto: string; exclude?: Id; label?: string }) {
  const regen = useApp((s) => s.regen);
  const bodies = regen?.pickBodies ?? regen?.bodies ?? [];
  const meta = useApp((s) => s.doc.bodies);
  return (
    <Select
      label={label}
      value={value ?? AUTO}
      onChange={(v) => onChange(v === AUTO ? undefined : v)}
      options={[
        { value: AUTO, label: allowAuto, icon: "sparkStep" as const },
        ...bodies.filter((b) => b.id !== exclude).map((b) => ({ value: b.id, label: meta[b.id]?.name ?? "Body", swatch: meta[b.id]?.color })),
      ]}
    />
  );
}

/** A path to follow: a sketch (open line or outline) or a 3D curve, earlier in the timeline. */
function PathSelect({ f, value, onChange, label, placeholder = "The path to follow…" }: { f: Feature; value: Id; onChange: (v: Id) => void; label: string; placeholder?: string }) {
  const sketches = useSketchesBefore(f.id);
  const features = useApp((s) => s.doc.features);
  const idx = features.findIndex((x) => x.id === f.id);
  const curves = features.slice(0, idx < 0 ? features.length : idx).filter((x) => x.type === "curve");
  const all = [...sketches.map((s) => ({ id: s.id, name: s.name, icon: "sketch" as const })), ...curves.map((c) => ({ id: c.id, name: c.name, icon: "path" as const }))];
  return <Select label={label} value={all.some((s) => s.id === value) ? value : ""} placeholder={placeholder} onChange={onChange} options={all.map((s) => ({ value: s.id, label: s.name, icon: s.icon }))} />;
}

/** A sketch picker limited to sketches earlier in the timeline. */
function SketchSelect({ f, value, onChange, label, placeholder = "Choose a sketch…" }: { f: Feature; value: Id; onChange: (v: Id) => void; label: string; placeholder?: string }) {
  const sketches = useSketchesBefore(f.id);
  return (
    <Select
      label={label}
      value={sketches.some((s) => s.id === value) ? value : ""}
      placeholder={placeholder}
      onChange={onChange}
      options={sketches.map((s) => ({ value: s.id, label: s.name, icon: "sketch" as const, hint: `${s.entities.length} shape${s.entities.length === 1 ? "" : "s"}` }))}
    />
  );
}

/** Sketches earlier in the timeline than `id`: later ones don't exist yet when it builds. */
function useSketchesBefore(id: Id): SketchFeature[] {
  const features = useApp((s) => s.doc.features);
  const i = features.findIndex((x) => x.id === id);
  return features.slice(0, i < 0 ? features.length : i).filter((x): x is SketchFeature => x.type === "sketch");
}

function OpField({ f }: { f: ExtrudeFeature | RevolveFeature | PrimitiveFeature | LoftFeature | SweepFeature | CoilFeature }) {
  const canSurface = f.type === "extrude" || f.type === "revolve" || f.type === "loft" || (f.type === "sweep" && !f.pipe);
  const surface = canSurface && !!(f as { surface?: boolean }).surface;
  return (
    <>
      {!surface && <Segmented label="Result" value={f.op} options={OPS} onChange={(op) => setBodyOp(f.id, op)} />}
      {!surface && f.op !== "new" && (
        <BodySelect
          value={f.target}
          exclude={f.id}
          allowAuto={f.op === "join" ? "Latest body" : "All bodies it touches"}
          onChange={(v) => upd(f, "Target", (d) => void (d.target = v))}
        />
      )}
      {canSurface && (
        <Segmented
          label="Output"
          value={surface ? "surface" : "solid"}
          options={[
            { value: "solid", label: "Solid" },
            { value: "surface", label: "Surface", title: "A skin with no volume: the sides only (no caps), and open lines work too" },
          ]}
          onChange={(v) => upd(f as ExtrudeFeature, "Output", (d) => void ((d as { surface?: boolean }).surface = v === "surface" ? true : undefined))}
        />
      )}
    </>
  );
}

function ExtrudeEditor({ f }: { f: ExtrudeFeature }) {
  const advanced = !!(f.taper || f.twist);
  return (
    <>
      <SketchSelect f={f} label="Profile" value={f.sketch} onChange={(v) => upd(f, "Profile", (d) => void ((d.sketch = v), d.type === "extrude" && (d.regions = undefined)))} />
      <RegionLine f={f} />
      {f.extent !== "through" && f.extent !== "face" && (
        <ExprInput label="Distance" kind="length" value={f.distance} autoFocus onChange={(v) => upd(f, "Distance", (d) => void (d.distance = v))} />
      )}
      <Segmented
        label="Direction"
        value={f.extent}
        options={[
          { value: "one", label: "One side" },
          { value: "symmetric", label: "Symmetric", title: "Half the distance each way" },
          { value: "two", label: "Two sides", title: "A different distance each way" },
          { value: "through", label: "Through all", title: "Through every body in that direction (holes and slots that always go all the way)" },
          { value: "face", label: "Up to a face", title: "Stop exactly at a flat face you click, wherever it is" },
        ]}
        onChange={(v) => upd(f, "Direction", (d) => void (d.extent = v))}
      />
      {f.extent === "face" && (
        <PickLine
          icon="plane"
          text={f.toFace ? "Stops at the face you chose. Click another face to change it" : "Click the face to extrude up to"}
          clearable={!!f.toFace}
          onClear={() => upd(f, "Clear face", (d) => void (d.type === "extrude" && (d.toFace = undefined)))}
        />
      )}
      {f.extent === "two" && (
        <ExprInput label="Other side" kind="length" value={f.distance2 ?? "0"} min={0} onChange={(v) => upd(f, "Second distance", (d) => void (d.distance2 = v))} />
      )}
      {f.extent !== "symmetric" && f.extent !== "face" && <Toggle label="Flip direction" checked={f.flip} onChange={(v) => upd(f, "Flip", (d) => void (d.flip = v))} />}
      <OpField f={f} />
      <Disclosure summary="Start" defaultOpen={f.startFace !== undefined || !!(f.startOffset && f.startOffset !== "0")}>
        <Toggle
          label="Start from a face"
          hint="Begin on a flat face of the model instead of the sketch plane (the offset below then counts from that face)"
          checked={f.startFace !== undefined}
          onChange={(on) => upd(f, "Start from a face", (d) => void (d.type === "extrude" && (d.startFace = on ? null : undefined)))}
        />
        {f.startFace !== undefined && (
          <PickLine
            icon="plane"
            text={f.startFace ? "Starts on the face you chose. Click another face to change it" : "Click the flat face to start from"}
            clearable={!!f.startFace}
            onClear={() => upd(f, "Clear start face", (d) => void (d.type === "extrude" && (d.startFace = null)))}
          />
        )}
        <ExprInput
          label="Start offset"
          kind="length"
          value={f.startOffset ?? "0"}
          hint="Begin the extrusion this far above (or below) the sketch plane"
          onChange={(v) => upd(f, "Start offset", (d) => void (d.type === "extrude" && (d.startOffset = v === "0" ? undefined : v)))}
        />
      </Disclosure>
      <Disclosure summary="Thin wall" defaultOpen={!!f.thin}>
        <ExprInput
          label="Wall"
          kind="length"
          value={f.thin ?? "0"}
          min={0}
          hint="Extrude walls along the outlines instead of filling them. Open paths become ribs."
          onChange={(v) => upd(f, "Wall thickness", (d) => void (d.thin = v === "0" ? undefined : v))}
        />
        {f.thin && (
          <Segmented
            label="Wall side"
            value={f.thinSide ?? "center"}
            options={[
              { value: "inside", label: "Inside", title: "Inside outlines (left of paths)" },
              { value: "center", label: "Centered" },
              { value: "outside", label: "Outside", title: "Outside outlines (right of paths)" },
            ]}
            onChange={(v) => upd(f, "Wall side", (d) => void (d.thinSide = v === "center" ? undefined : v))}
          />
        )}
      </Disclosure>
      <Disclosure summary="Taper and twist" defaultOpen={advanced}>
        <ExprInput
          label="Taper"
          kind="angle"
          value={f.taper ?? "0"}
          hint="Draft for moulding and casting; negative flares out"
          onChange={(v) => upd(f, "Taper", (d) => void (d.taper = v === "0" ? undefined : v))}
        />
        <ExprInput
          label="Twist"
          kind="angle"
          value={f.twist ?? "0"}
          hint="Turns the profile along the way: vases, grips, knobs"
          onChange={(v) => upd(f, "Twist", (d) => void (d.twist = v === "0" ? undefined : v))}
        />
      </Disclosure>
    </>
  );
}

function RevolveEditor({ f }: { f: RevolveFeature }) {
  const sketch = useApp((s) => s.doc.features.find((x): x is SketchFeature => x.id === f.sketch && x.type === "sketch"));
  const lines = (sketch?.entities ?? []).filter((e) => e.type === "polyline" && (e.open || e.construction));
  return (
    <>
      <SketchSelect f={f} label="Profile" value={f.sketch} onChange={(v) => upd(f, "Profile", (d) => void ((d.sketch = v), d.type === "revolve" && (d.regions = undefined)))} />
      <RegionLine f={f} />
      <Segmented
        label="Axis"
        value={f.axis}
        options={[
          { value: "y", label: "Sketch vertical", title: "The sketch's vertical (Y) axis" },
          { value: "x", label: "Sketch horizontal", title: "The sketch's horizontal (X) axis" },
          { value: "line", label: "A line", title: "A straight path or construction line drawn in the sketch" },
        ]}
        onChange={(v) => upd(f, "Axis", (d) => void (d.axis = v))}
      />
      {f.axis === "line" && (
        <Select
          label="Axis line"
          value={lines.find((e) => e.id === f.axisLine)?.id ?? lines[0]?.id ?? ""}
          placeholder={lines.length ? "Choose a line…" : "Draw a line with the Path tool first"}
          onChange={(v) => upd(f, "Axis line", (d) => void (d.axisLine = v))}
          options={lines.map((e, i) => ({ value: e.id, label: `${e.construction ? "Construction line" : "Path"} ${i + 1}`, icon: "sketch" as const }))}
        />
      )}
      <Segmented
        label="Direction"
        value={f.extent ?? "one"}
        options={[
          { value: "one", label: "One side", title: "Turn one way from the profile" },
          { value: "symmetric", label: "Symmetric", title: "Split the angle evenly either side of the profile" },
          { value: "two", label: "Two sides", title: "A different angle each way" },
        ]}
        onChange={(v) => upd(f, "Direction", (d) => void ((d as RevolveFeature).extent = v === "one" ? undefined : (v as RevolveFeature["extent"])))}
      />
      <ExprInput label={f.extent === "two" ? "Angle 1" : f.extent === "symmetric" ? "Total angle" : "Angle"} kind="angle" value={f.angle} autoFocus onChange={(v) => upd(f, "Angle", (d) => void (d.angle = v))} />
      {f.extent === "two" && <ExprInput label="Angle 2" kind="angle" value={f.angle2 ?? "90"} min={0} onChange={(v) => upd(f, "Angle 2", (d) => void ((d as RevolveFeature).angle2 = v))} />}
      <OpField f={f} />
    </>
  );
}

function EdgeEditor({ f }: { f: FilletFeature | ChamferFeature }) {
  const n = f.edges.length;
  const prefs = useApp((s) => s.prefs);
  const previewing = useApp((s) => s.hoverEdges?.length ?? 0);
  const label = n === 0 ? "No edges yet: click edges in the view (or a face for all its edges)" : `${n} edge${n > 1 ? "s" : ""}`;
  return (
    <>
      <div className="picker">
        <Icon name="fillet" size={16} />
        <span>{previewing ? `${label} · previewing the edge${previewing > 1 ? "s" : ""} under the pointer, click to add` : label}</span>
        {n > 0 && (
          <button className="link" onClick={() => upd(f, "Clear edges", (d) => void (d.edges = []))}>
            Clear
          </button>
        )}
      </div>
      <Toggle label="Select tangent edges together" hint="Clicking an edge also takes the edges that continue smoothly from it, such as a whole rounded outline" checked={prefs.tangentChain} onChange={(v) => setPrefs({ tangentChain: v })} />
      {f.type === "fillet" ? (
        <>
          <Toggle label="Full round" hint="Round a narrow flat face into a half-round: pick one long edge along it and the other side follows" checked={!!f.fullRound} onChange={(on) => upd(f, "Full round", (d) => void ((d as FilletFeature).fullRound = on || undefined))} />
          {!f.fullRound && <ExprInput label={f.radius2 ? "Start radius" : "Radius"} kind="length" value={f.radius} autoFocus min={0} onChange={(v) => upd(f, "Radius", (d) => void ((d as FilletFeature).radius = v))} />}
          {!f.fullRound && <Toggle label="Variable radius" hint="The radius changes along each edge, from the start radius to the end radius" checked={!!f.radius2} onChange={(on) => upd(f, "Variable", (d) => void ((d as FilletFeature).radius2 = on ? String(Number.parseFloat(f.radius) * 2 || 2) : undefined))} />}
          {!f.fullRound && f.radius2 && <ExprInput label="End radius" kind="length" value={f.radius2} min={0} onChange={(v) => upd(f, "End radius", (d) => void ((d as FilletFeature).radius2 = v))} />}
        </>
      ) : (
        <>
          <Segmented
            label="Type"
            value={f.mode ?? "equal"}
            options={[
              { value: "equal", label: "Equal", title: "The same setback on both faces" },
              { value: "two", label: "Two distances", title: "A different setback on each face" },
              { value: "angle", label: "Distance + angle", title: "A setback on one face and the angle of the cut" },
            ]}
            onChange={(v) =>
              upd(f, "Chamfer type", (d) => {
                const c = d as ChamferFeature;
                c.mode = v === "equal" ? undefined : (v as ChamferFeature["mode"]);
                if (v === "two") c.distance2 ??= c.distance;
                if (v === "angle") c.angle ??= "45";
              })
            }
          />
          <ExprInput label={f.mode === "two" ? "Distance 1" : "Distance"} kind="length" value={f.distance} autoFocus min={0} onChange={(v) => upd(f, "Distance", (d) => void ((d as ChamferFeature).distance = v))} />
          {f.mode === "two" && <ExprInput label="Distance 2" kind="length" value={f.distance2 ?? f.distance} min={0} onChange={(v) => upd(f, "Distance 2", (d) => void ((d as ChamferFeature).distance2 = v))} />}
          {f.mode === "angle" && <ExprInput label="Angle" kind="angle" value={f.angle ?? "45"} min={0} max={89.9} onChange={(v) => upd(f, "Angle", (d) => void ((d as ChamferFeature).angle = v))} />}
          {f.mode && <Toggle label="Flip side" hint="Measure the first distance on the other face of each edge" checked={!!f.flip} onChange={(v) => upd(f, "Flip chamfer", (d) => void ((d as ChamferFeature).flip = v || undefined))} />}
        </>
      )}
    </>
  );
}

function ShellEditor({ f }: { f: ShellFeature }) {
  const n = f.faces.length;
  const section = useApp((s) => !!s.view.section);
  // Cut the view through the middle of the body, so the walls show while the thickness is set.
  const seeInside = (on: boolean) => {
    const r = useApp.getState().regen;
    const b = r?.bodies.find((x) => x.id === f.bodyId) ?? r?.bodies[r.bodies.length - 1];
    setView({ section: on ? { axis: "y", offset: b ? (b.bbox[0][1] + b.bbox[1][1]) / 2 : 0, flip: false } : null });
  };
  return (
    <>
      <div className="picker">
        <Icon name="shell" size={16} />
        <span>{n === 0 ? "Closed all round (hollow inside). Click the faces to open" : `${n} open face${n > 1 ? "s" : ""}`}</span>
        {n > 0 && (
          <button className="link" onClick={() => upd(f, "Clear faces", (d) => void (d.faces = []))}>
            Clear
          </button>
        )}
      </div>
      <Segmented
        label="Direction"
        value={f.direction ?? "inside"}
        options={[
          { value: "inside", label: "Inside", title: "The wall grows into the body: its outside stays the same size" },
          { value: "outside", label: "Outside", title: "The wall grows outward: the cavity keeps the body's size" },
          { value: "both", label: "Both", title: "Half the wall each side of the original surface" },
        ]}
        onChange={(v) => upd(f, "Shell direction", (d) => void ((d as ShellFeature).direction = v === "inside" ? undefined : (v as ShellFeature["direction"])))}
      />
      <ExprInput label="Wall" kind="length" value={f.thickness} autoFocus min={0} hint="Typical: moulded plastic 1.5–3 mm, 3D prints 1.2–2 mm, cast metal 3+ mm" onChange={(v) => upd(f, "Thickness", (d) => void (d.thickness = v))} />
      <Toggle label="See inside" hint={n === 0 ? "A closed shell is hollow inside: cut the view open through the middle to see the walls (the model is unchanged)" : "Cut the view open through the middle to see the walls (the model is unchanged)"} checked={section} onChange={seeInside} />
    </>
  );
}

const R2_LABEL: Record<string, string> = { cone: "Top radius", torus: "Tube radius", tube: "Inner radius" };
const R_LABEL: Record<string, string> = { cone: "Bottom radius", torus: "Ring radius", tube: "Outer radius" };

function PrimitiveEditor({ f }: { f: PrimitiveFeature }) {
  return (
    <>
      {f.shape === "box" && (
        <>
          <ExprInput label="Width" kind="length" value={f.width} autoFocus onChange={(v) => upd(f, "Width", (d) => void (d.width = v))} />
          <ExprInput label="Depth" kind="length" value={f.depth} onChange={(v) => upd(f, "Depth", (d) => void (d.depth = v))} />
          <ExprInput label="Height" kind="length" value={f.height} onChange={(v) => upd(f, "Height", (d) => void (d.height = v))} />
        </>
      )}
      {f.shape !== "box" && (
        <ExprInput label={R_LABEL[f.shape] ?? "Radius"} kind="length" value={f.radius} autoFocus onChange={(v) => upd(f, "Radius", (d) => void (d.radius = v))} />
      )}
      {R2_LABEL[f.shape] && (
        <ExprInput
          label={R2_LABEL[f.shape]!}
          kind="length"
          value={f.radius2 ?? "0"}
          min={0}
          hint={f.shape === "cone" ? "0 makes a pointed cone" : undefined}
          onChange={(v) => upd(f, "Radius 2", (d) => void (d.radius2 = v))}
        />
      )}
      {(f.shape === "cylinder" || f.shape === "cone" || f.shape === "tube") && (
        <ExprInput label="Height" kind="length" value={f.height} onChange={(v) => upd(f, "Height", (d) => void (d.height = v))} />
      )}
      <div className="field-row">
        {(["X", "Y", "Z"] as const).map((axis, i) => (
          <ExprInput
            key={axis}
            label={axis}
            kind="length"
            value={f.position[i]!}
            onChange={(v) =>
              upd(f, "Position", (d) => {
                d.position[i] = v;
              })
            }
          />
        ))}
      </div>
      <OpField f={f} />
    </>
  );
}

/** The earlier features that add to or cut a body, which a pattern or mirror can repeat. */
const REPEATABLE = new Set(["extrude", "revolve", "loft", "sweep", "hole", "rib", "coil", "thread", "primitive", "fillet", "chamfer", "draft", "offsetFace", "combine"]);

/** Choose what a pattern or mirror repeats: a whole body, or particular features (a boss, a rib, a cut). */
function RepeatWhat({ f }: { f: MirrorFeature | PatternFeature }) {
  const features = useApp((s) => s.doc.features);
  const mode = f.features ? "features" : "body";
  const sources = features.slice(0, Math.max(0, features.findIndex((x) => x.id === f.id))).filter((x) => REPEATABLE.has(x.type) && !x.suppressed);
  const set = (label: string, recipe: (d: Draft<MirrorFeature | PatternFeature>) => void) => upd(f, label, (d) => void ((d.type === "mirror" || d.type === "pattern") && recipe(d)));
  return (
    <>
      <Segmented
        label="Repeat"
        value={mode}
        options={[
          { value: "body", label: "A whole body" },
          { value: "features", label: "Features" },
        ]}
        onChange={(v) => set("Repeat what", (d) => void (d.features = v === "features" ? [] : undefined))}
      />
      {mode === "body" ? (
        <BodySelect value={f.bodyId} allowAuto="Latest body" exclude={f.id} onChange={(v) => set("Body", (d) => void (d.bodyId = v))} />
      ) : (
        <div className="field">
          <span className="field__label">Features</span>
          <div className="checklist">
            {sources.map((s) => (
              <Checkbox
                key={s.id}
                className="checkrow"
                checked={!!f.features?.includes(s.id)}
                onChange={(on) => set("Features", (d) => void (d.features = on ? [...(d.features ?? []), s.id] : (d.features ?? []).filter((x) => x !== s.id)))}
                label={s.name}
              />
            ))}
            {sources.length === 0 && <p className="field__note">There are no earlier features to repeat yet.</p>}
          </div>
        </div>
      )}
    </>
  );
}

function MirrorEditor({ f }: { f: MirrorFeature }) {
  return (
    <>
      <RepeatWhat f={f} />
      <Select
        label="Mirror plane"
        value={f.planeRef ?? f.plane}
        options={[...ORIGIN_PLANES, ...constructsBefore(useApp.getState().doc.features, f.id, "plane").map((c) => ({ value: c.id, label: c.name, icon: "plane" as const }))]}
        onChange={(v) => upd(f, "Plane", (d) => (v === "YZ" || v === "XZ" || v === "XY" ? ((d.plane = v), (d.planeRef = undefined)) : (d.planeRef = v)))}
      />
      <ExprInput
        label="Plane offset"
        kind="length"
        value={f.offset ?? "0"}
        hint="Move the mirror plane along its normal"
        onChange={(v) => upd(f, "Offset", (d) => void (d.offset = v === "0" ? undefined : v))}
      />
      {!f.features && <Toggle label="Merge with the original" checked={f.merge} onChange={(v) => upd(f, "Merge", (d) => void (d.merge = v))} />}
    </>
  );
}

function PatternEditor({ f }: { f: PatternFeature }) {
  return (
    <>
      <RepeatWhat f={f} />
      <Segmented
        label="Type"
        value={f.pattern}
        options={[
          { value: "linear", label: "In a row" },
          { value: "circular", label: "Around an axis" },
          { value: "path", label: "Along a path" },
        ]}
        onChange={(v) => upd(f, "Type", (d) => void (d.pattern = v))}
      />
      {f.pattern === "path" ? (
        <>
          <PathSelect f={f} label="Path sketch" value={f.path ?? ""} placeholder="Choose a sketch with a path…" onChange={(v) => upd(f, "Path", (d) => void (d.type === "pattern" && (d.path = v)))} />
          <Toggle label="Turn copies with the path" checked={!!f.follow} onChange={(v) => upd(f, "Follow", (d) => void (d.follow = v))} />
        </>
      ) : (
        <>
          <Select
            label={f.pattern === "linear" ? "Direction" : "Axis"}
            value={f.axisGeom ? "pick" : f.axisRef ?? f.axis}
            options={[
              ...ORIGIN_AXES,
              ...constructsBefore(useApp.getState().doc.features, f.id, "axis").map((c) => ({ value: c.id, label: c.name, icon: "axis" as const })),
              { value: "pick", label: "Edge or face on the model…", icon: "select" as const },
            ]}
            onChange={(v) =>
              upd(f, "Axis", (d) => {
                d.axisGeom = v === "pick" ? (d.axisGeom ?? {}) : undefined;
                if (v === "x" || v === "y" || v === "z") ((d.axis = v), (d.axisRef = undefined));
                else if (v !== "pick") d.axisRef = v;
              })
            }
          />
          {f.axisGeom && (
            <div className="picker">
              <Icon name="select" size={16} />
              <span>{f.axisGeom.edge ? "Along the picked edge" : f.axisGeom.face ? "From the picked face" : f.pattern === "linear" ? "Click a straight edge or flat face for the direction" : "Click a round face or circular edge for the axis"}</span>
            </div>
          )}
        </>
      )}
      <ExprInput label="Count" kind="count" value={f.count} autoFocus min={2} onChange={(v) => upd(f, "Count", (d) => void (d.count = v))} />
      {f.pattern === "path" ? null : f.pattern === "linear" ? (
        <>
          <ExprInput label="Spacing" kind="length" value={f.spacing} onChange={(v) => upd(f, "Spacing", (d) => void (d.spacing = v))} />
          <Disclosure summary="Second direction (grid)" defaultOpen={!!f.count2 && f.count2 !== "1"}>
            <Segmented
              label="Direction"
              value={f.axis2 ?? (f.axis === "x" ? "y" : "x")}
              options={(["x", "y", "z"] as const).filter((a) => a !== f.axis).map((a) => ({ value: a, label: a.toUpperCase() }))}
              onChange={(v) => upd(f, "Second direction", (d) => void (d.axis2 = v))}
            />
            <ExprInput label="Count" kind="count" value={f.count2 ?? "1"} min={1} onChange={(v) => upd(f, "Second count", (d) => void (d.count2 = v === "1" ? undefined : v))} />
            <ExprInput label="Spacing" kind="length" value={f.spacing2 ?? f.spacing} onChange={(v) => upd(f, "Second spacing", (d) => void (d.spacing2 = v))} />
          </Disclosure>
        </>
      ) : (
        <ExprInput label="Total angle" kind="angle" value={f.angle} onChange={(v) => upd(f, "Angle", (d) => void (d.angle = v))} />
      )}
      {!f.features && <Toggle label="Merge copies into one body" checked={f.merge} onChange={(v) => upd(f, "Merge", (d) => void (d.merge = v))} />}
    </>
  );
}

function HoleEditor({ f }: { f: HoleFeature }) {
  const n = f.points.length;
  return (
    <>
      <div className="picker">
        <Icon name="hole" size={16} />
        <span>{!f.face ? "Click a flat face to drill into" : n === 0 ? "Click on the face to place holes" : `${n} hole${n > 1 ? "s" : ""} · click to add more`}</span>
        {n > 0 && (
          <button className="link" onClick={() => upd(f, "Clear holes", (d) => void (d.points = []))}>
            Clear
          </button>
        )}
      </div>
      <Segmented
        label="Type"
        value={f.style}
        options={[
          { value: "simple", label: "Simple" },
          { value: "counterbore", label: "Counterbore", title: "Flat-bottomed recess for socket head screws" },
          { value: "countersink", label: "Countersink", title: "Cone-shaped recess for flat head screws" },
        ]}
        onChange={(v) => upd(f, "Hole type", (d) => void (d.style = v))}
      />
      <HoleStandard f={f} />
      <ExprInput label="Diameter" kind="length" value={f.diameter} autoFocus min={0} onChange={(v) => upd(f, "Diameter", (d) => void (d.diameter = v))} />
      <Toggle label="Through all" checked={f.through} onChange={(v) => upd(f, "Through", (d) => void (d.through = v))} />
      {!f.through && <ExprInput label="Depth" kind="length" value={f.depth} min={0} onChange={(v) => upd(f, "Depth", (d) => void (d.depth = v))} />}
      {!f.through && (
        <Segmented
          label="Drill point"
          value={f.tipAngle ? "angle" : "flat"}
          options={[
            { value: "flat", label: "Flat", title: "A flat bottom (end mill)" },
            { value: "angle", label: "Angled", title: "The cone a twist drill leaves" },
          ]}
          onChange={(v) => upd(f, "Drill point", (d) => void (d.tipAngle = v === "angle" ? "118" : undefined))}
        />
      )}
      {!f.through && f.tipAngle && <ExprInput label="Point angle" kind="angle" value={f.tipAngle} min={1} max={179} hint="118° is a standard twist drill" onChange={(v) => upd(f, "Drill point angle", (d) => void (d.tipAngle = v))} />}
      {f.style !== "simple" && (
        <div className="field-row">
          <ExprInput label="Head Ø" kind="length" value={f.headDiameter} min={0} onChange={(v) => upd(f, "Head diameter", (d) => void (d.headDiameter = v))} />
          {f.style === "counterbore" && <ExprInput label="Head depth" kind="length" value={f.headDepth} min={0} onChange={(v) => upd(f, "Head depth", (d) => void (d.headDepth = v))} />}
          {f.style === "countersink" && <ExprInput label="Angle" kind="angle" value={f.sinkAngle ?? "90"} min={1} max={179} hint="90° metric, 82° imperial" onChange={(v) => upd(f, "Countersink angle", (d) => void (d.sinkAngle = v))} />}
        </div>
      )}
      {f.points.map((p, i) => (
        <div className="field-row field-row--removable" key={i}>
          <ExprInput label={`#${i + 1} X`} kind="length" value={p[0]} onChange={(v) => upd(f, "Hole position", (d) => void (d.points[i]![0] = v))} />
          <ExprInput label="Y" kind="length" value={p[1]} onChange={(v) => upd(f, "Hole position", (d) => void (d.points[i]![1] = v))} />
          <button className="iconbtn iconbtn--small" title="Remove this hole" onClick={() => upd(f, "Remove hole", (d) => void d.points.splice(i, 1))}>
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </>
  );
}

function LoftEditor({ f }: { f: LoftFeature }) {
  const sketches = useSketchesBefore(f.id);
  return (
    <>
      <div className="picker">
        <Icon name="loft" size={16} />
        <span>{f.sketches.length < 2 ? "Click two or more sketches, bottom to top" : `${f.sketches.length} profiles, in order`}</span>
      </div>
      <ol className="chips">
        {f.sketches.map((id, i) => (
          <li key={id} className="chip">
            <span className="chip__n mono">{i + 1}</span>
            {sketches.find((s) => s.id === id)?.name ?? "Missing"}
            <button className="chip__x" aria-label="Remove profile" onClick={() => upd(f, "Remove profile", (d) => void d.sketches.splice(i, 1))}>
              <Icon name="close" size={12} />
            </button>
          </li>
        ))}
      </ol>
      <Select
        label="Add"
        value=""
        placeholder="Add a sketch…"
        onChange={(v) => upd(f, "Add profile", (d) => void d.sketches.push(v))}
        options={sketches.filter((s) => !f.sketches.includes(s.id)).map((s) => ({ value: s.id, label: s.name, icon: "sketch" as const }))}
      />
      <Toggle label="Straight sides (ruled)" checked={f.ruled} onChange={(v) => upd(f, "Ruled", (d) => void (d.ruled = v))} />
      <OpField f={f} />
    </>
  );
}

function MoveEditor({ f }: { f: MoveFeature }) {
  return (
    <>
      <BodySelect value={f.bodyId} allowAuto="Latest body" exclude={f.id} onChange={(v) => upd(f, "Body", (d) => void (d.bodyId = v))} />
      <div className="field-row">
        {(["X", "Y", "Z"] as const).map((axis, i) => (
          <ExprInput key={axis} label={axis} kind="length" value={f.translate[i]!} autoFocus={i === 0} onChange={(v) => upd(f, "Move", (d) => void (d.translate[i] = v))} />
        ))}
      </div>
      <Segmented
        label="Rotate around"
        value={f.axis}
        options={[
          { value: "x", label: "X" },
          { value: "y", label: "Y" },
          { value: "z", label: "Z" },
        ]}
        onChange={(v) => upd(f, "Axis", (d) => void (d.axis = v))}
      />
      <ExprInput label="Angle" kind="angle" value={f.angle} hint="Turns about the body's own center" onChange={(v) => upd(f, "Angle", (d) => void (d.angle = v))} />
      <Toggle label="Keep the original (make a copy)" checked={f.copy} onChange={(v) => upd(f, "Copy", (d) => void (d.copy = v))} />
    </>
  );
}

function CombineEditor({ f }: { f: CombineFeature }) {
  const bodies = useApp((s) => s.regen?.pickBodies ?? s.regen?.bodies ?? []);
  const meta = useApp((s) => s.doc.bodies);
  return (
    <>
      <Segmented
        label="Operation"
        value={f.op}
        options={[
          { value: "join", label: "Join" },
          { value: "cut", label: "Cut" },
          { value: "intersect", label: "Intersect", title: "Keep only where they overlap" },
        ]}
        onChange={(v) => upd(f, "Operation", (d) => void (d.op = v))}
      />
      <BodySelect value={f.target} allowAuto="Choose…" onChange={(v) => upd(f, "Target", (d) => void (d.target = v))} label="Target" />
      <div className="field">
        <span className="field__label">Tools</span>
        <div className="checklist">
          {bodies
            .filter((b) => b.id !== f.target)
            .map((b) => (
              <Checkbox
                key={b.id}
                className="checkrow"
                checked={f.tools.includes(b.id)}
                onChange={(on) =>
                  upd(f, "Tools", (d) => {
                    d.tools = on ? [...d.tools, b.id] : d.tools.filter((x) => x !== b.id);
                  })
                }
                label={
                  <>
                    <span className="tree__swatch" style={{ background: meta[b.id]?.color ?? "#ccc" }} />
                    {meta[b.id]?.name ?? "Body"}
                  </>
                }
              />
            ))}
        </div>
      </div>
      <Toggle label="Keep tool bodies" checked={f.keepTools} onChange={(v) => upd(f, "Keep tools", (d) => void (d.keepTools = v))} />
    </>
  );
}

function ImportEditor({ f }: { f: ImportFeature }) {
  return (
    <>
      <div className="picker">
        <Icon name="import" size={16} />
        <span className="ellipsis">
          {f.fileName} · {f.format.toUpperCase()} · {Math.round((f.data.length * 0.75) / 1024)} KB
        </span>
      </div>
      <ExprInput label="Scale" kind="number" value={f.scale} autoFocus min={0} hint="25.4 converts a part modelled in inches" onChange={(v) => upd(f, "Scale", (d) => void (d.scale = v))} />
    </>
  );
}

function PipeEditor({ f }: { f: SweepFeature }) {
  const pipe = f.pipe!;
  const set = (label: string, recipe: (p: NonNullable<SweepFeature["pipe"]>) => void) => upd(f, label, (d) => void (d.type === "sweep" && d.pipe && recipe(d.pipe)));
  return (
    <>
      <PathSelect f={f} label="Path" value={f.path} onChange={(v) => upd(f, "Path", (d) => void (d.type === "sweep" && (d.path = v)))} />
      <Segmented
        label="Section"
        value={pipe.shape}
        options={[
          { value: "circle", label: "Round" },
          { value: "square", label: "Square" },
        ]}
        onChange={(v) => set("Section", (p) => void (p.shape = v))}
      />
      <ExprInput label={pipe.shape === "circle" ? "Outer diameter" : "Outer width"} kind="length" value={pipe.size} min={0} onChange={(v) => set("Size", (p) => void (p.size = v))} />
      <ExprInput label="Wall thickness" kind="length" value={pipe.wall} min={0} hint="0 makes a solid rod" onChange={(v) => set("Wall", (p) => void (p.wall = v))} />
      <OpField f={f} />
    </>
  );
}

function SweepEditor({ f }: { f: SweepFeature }) {
  if (f.pipe) return <PipeEditor f={f} />;
  return (
    <>
      <SketchSelect f={f} label="Profile" value={f.profile} placeholder="The cross-section…" onChange={(v) => upd(f, "Profile", (d) => void (d.profile = v))} />
      <PathSelect f={f} label="Path" value={f.path} onChange={(v) => upd(f, "Path", (d) => void (d.path = v))} />
      <p className="field__note">
        Draw the cross-section where the path starts, facing along it. A path is an open line (switch on <b>Open path</b> for a line) or any outline.
      </p>
      <Segmented
        label="Orientation"
        value={f.orientation}
        options={[
          { value: "fixed", label: "Minimal twist", title: "Keeps the profile steady: best for most paths" },
          { value: "frenet", label: "Follow curve", title: "Turns with the curvature of the path: helices and 3D curves" },
        ]}
        onChange={(v) => upd(f, "Orientation", (d) => void (d.orientation = v))}
      />
      <OpField f={f} />
    </>
  );
}

function CoilEditor({ f }: { f: CoilFeature }) {
  return (
    <>
      <Segmented
        label="Section"
        value={f.section}
        options={[
          { value: "circle", label: "Round", title: "Springs and wire coils" },
          { value: "triangle", label: "V thread", title: "60 degree screw thread" },
          { value: "square", label: "Square", title: "Square or power thread" },
        ]}
        onChange={(v) => upd(f, "Section", (d) => void (d.section = v))}
      />
      <ExprInput
        label="Radius"
        kind="length"
        value={f.radius}
        autoFocus
        min={0}
        hint={f.section === "circle" ? "To the middle of the wire" : "Where the thread starts: the rod or hole radius"}
        onChange={(v) => upd(f, "Radius", (d) => void (d.radius = v))}
      />
      <div className="field-row">
        <ExprInput label="Pitch" kind="length" value={f.pitch} min={0} onChange={(v) => upd(f, "Pitch", (d) => void (d.pitch = v))} />
        <ExprInput label="Height" kind="length" value={f.height} min={0} onChange={(v) => upd(f, "Height", (d) => void (d.height = v))} />
      </div>
      <ExprInput label={f.section === "circle" ? "Wire Ø" : "Depth"} kind="length" value={f.size} min={0} onChange={(v) => upd(f, "Size", (d) => void (d.size = v))} />
      <div className="field-row">
        {(["X", "Y", "Z"] as const).map((axis, i) => (
          <ExprInput key={axis} label={axis} kind="length" value={f.position[i]!} onChange={(v) => upd(f, "Position", (d) => void (d.position[i] = v))} />
        ))}
      </div>
      <Toggle label="Left-handed" checked={f.lefthand} onChange={(v) => upd(f, "Hand", (d) => void (d.lefthand = v))} />
      <p className="field__note">For a screw, Join a V thread to a rod of the same radius. For a tapped hole, Cut it from the wall of a hole.</p>
      <OpField f={f} />
    </>
  );
}

function SplitEditor({ f }: { f: SplitFeature }) {
  return (
    <>
      <BodySelect value={f.bodyId} allowAuto="Latest body" exclude={f.id} onChange={(v) => upd(f, "Body", (d) => void (d.bodyId = v))} />
      <Select
        label="Plane"
        value={f.planeRef ?? f.plane}
        options={[...ORIGIN_PLANES, ...constructsBefore(useApp.getState().doc.features, f.id, "plane").map((c) => ({ value: c.id, label: c.name, icon: "plane" as const }))]}
        onChange={(v) => upd(f, "Plane", (d) => (v === "YZ" || v === "XZ" || v === "XY" ? ((d.plane = v), (d.planeRef = undefined)) : (d.planeRef = v)))}
      />
      <ExprInput label="Offset" kind="length" value={f.offset} autoFocus onChange={(v) => upd(f, "Offset", (d) => void (d.offset = v))} />
      <Toggle label="Only split the faces" checked={!!f.facesOnly} onChange={(v) => upd(f, "Split faces", (d) => void (d.facesOnly = v))} />
      <Toggle label="At the widest outline" hint="Cut where the body is widest across the plane's normal: the parting line for a mould" checked={!!f.silhouette} onChange={(v) => upd(f, "Silhouette", (d) => void (d.silhouette = v))} />
      {!f.facesOnly && <Segmented
        label="Keep"
        value={f.keep}
        options={[
          { value: "both", label: "Both halves" },
          { value: "above", label: "Above" },
          { value: "below", label: "Below" },
        ]}
        onChange={(v) => upd(f, "Keep", (d) => void (d.keep = v))}
      />}
    </>
  );
}

function BoundingSolidEditor({ f }: { f: BoundingSolidFeature }) {
  const bodies = useApp((s) => s.regen?.pickBodies ?? s.regen?.bodies ?? []);
  const meta = useApp((s) => s.doc.bodies);
  return (
    <>
      <div className="field">
        <span className="field__label">Enclose</span>
        <div className="checklist">
          {bodies
            .filter((b) => b.id !== f.id)
            .map((b) => (
              <Checkbox
                key={b.id}
                className="checkrow"
                checked={f.bodies.includes(b.id)}
                onChange={(on) => upd(f, "Bodies", (d) => void (d.bodies = on ? [...d.bodies, b.id] : d.bodies.filter((x) => x !== b.id)))}
                label={
                  <>
                    <span className="tree__swatch" style={{ background: meta[b.id]?.color ?? "#ccc" }} />
                    {meta[b.id]?.name ?? "Body"}
                  </>
                }
              />
            ))}
        </div>
        <p className="field__hint">{f.bodies.length ? "Click bodies in the view to add or remove them" : "Every body (or click bodies in the view to choose)"}</p>
      </div>
      <Segmented
        label="Shape"
        value={f.shape}
        options={[
          { value: "box", label: "Box" },
          { value: "cylinder", label: "Cylinder" },
        ]}
        onChange={(v) => upd(f, "Shape", (d) => void (d.shape = v))}
      />
      {f.shape === "cylinder" && (
        <Segmented
          label="Axis"
          value={f.axis}
          options={[
            { value: "x", label: "X" },
            { value: "y", label: "Y" },
            { value: "z", label: "Z" },
          ]}
          onChange={(v) => upd(f, "Axis", (d) => void (d.axis = v))}
        />
      )}
      <ExprInput label="Padding" kind="length" value={f.padding} autoFocus hint="Extra stock on every side (machining allowance, clearance)" onChange={(v) => upd(f, "Padding", (d) => void (d.padding = v))} />
    </>
  );
}

function OffsetEditor({ f }: { f: OffsetFeature }) {
  return (
    <>
      <BodySelect value={f.bodyId} allowAuto="Latest body" exclude={f.id} onChange={(v) => upd(f, "Body", (d) => void (d.bodyId = v))} />
      <ExprInput label="Distance" kind="length" value={f.distance} autoFocus hint="Positive grows the body, negative shrinks it" onChange={(v) => upd(f, "Distance", (d) => void (d.distance = v))} />
      <Toggle label="Keep the original (make a copy)" checked={f.copy} onChange={(v) => upd(f, "Copy", (d) => void (d.copy = v))} />
    </>
  );
}

function ScaleEditor({ f }: { f: ScaleFeature }) {
  return (
    <>
      <BodySelect value={f.bodyId} allowAuto="Latest body" exclude={f.id} onChange={(v) => upd(f, "Body", (d) => void (d.bodyId = v))} />
      <ExprInput label="Factor" kind="number" value={f.factor} autoFocus min={0} hint="2 doubles every dimension; 25.4 turns inches into mm" onChange={(v) => upd(f, "Factor", (d) => void (d.factor = v))} />
      <Segmented
        label="About"
        value={f.center}
        options={[
          { value: "body", label: "Its center" },
          { value: "origin", label: "The origin" },
        ]}
        onChange={(v) => upd(f, "Center", (d) => void (d.center = v))}
      />
      <Toggle label="Keep the original (make a copy)" checked={f.copy} onChange={(v) => upd(f, "Copy", (d) => void (d.copy = v))} />
    </>
  );
}

function DraftEditor({ f }: { f: DraftFeature }) {
  const n = f.faces.length;
  return (
    <>
      <div className="picker">
        <Icon name="draft" size={16} />
        <span>{n === 0 ? "Click the side faces to tilt" : `${n} face${n > 1 ? "s" : ""}`}</span>
        {n > 0 && (
          <button className="link" onClick={() => upd(f, "Clear faces", (d) => void (d.faces = []))}>
            Clear
          </button>
        )}
      </div>
      <ExprInput label="Angle" kind="angle" value={f.angle} autoFocus hint="1 to 3 degrees is typical for moulded parts" onChange={(v) => upd(f, "Angle", (d) => void (d.angle = v))} />
      <Segmented
        label="Pull direction"
        value={f.pull}
        options={[
          { value: "z", label: "Z" },
          { value: "y", label: "Y" },
          { value: "x", label: "X" },
        ]}
        onChange={(v) => upd(f, "Pull", (d) => void (d.pull = v))}
      />
      <ExprInput label="Neutral plane" kind="length" value={f.neutral} hint="Faces keep their size at this height" onChange={(v) => upd(f, "Neutral", (d) => void (d.neutral = v))} />
      <Toggle label="Flip direction" checked={f.flip} onChange={(v) => upd(f, "Flip", (d) => void (d.flip = v))} />
    </>
  );
}

function ConstructionPlaneEditor({ f }: { f: ConstructionPlaneFeature }) {
  const features = useApp((s) => s.doc.features);
  const before = features.slice(0, Math.max(0, features.findIndex((x) => x.id === f.id))).filter((x) => x.type === "cplane");
  const p = f.plane;
  const set = (label: string, recipe: (pl: PlaneRef) => PlaneRef) => upd(f, label, (d) => void (d.type === "cplane" && (d.plane = recipe(d.plane))));
  const value = p.kind === "origin" ? p.plane : p.kind === "construction" ? p.plane : "face";
  return (
    <>
      {p.kind === "face" ? (
        <p className="field__note">On a flat model face. Offset moves it along the face normal.</p>
      ) : (
        <Select
          label="Based on"
          value={value}
          onChange={(v) => set("Base", (pl) => (v === "XY" || v === "XZ" || v === "YZ" ? { kind: "origin", plane: v, offset: pl.offset } : { kind: "construction", plane: v, offset: pl.offset }))}
          options={[
            ...(["XY", "XZ", "YZ"] as const).map((o) => ({ value: o as string, label: `${o} plane`, icon: "plane" as const })),
            ...before.map((c) => ({ value: c.id, label: c.name, icon: "plane" as const })),
          ]}
        />
      )}
      <ExprInput label="Offset" kind="length" value={p.offset} autoFocus hint="Distance along the plane's normal" onChange={(v) => set("Offset", (pl) => ({ ...pl, offset: v }))} />
      {p.kind === "origin" && (
        <>
          <ExprInput label="Tilt angle" kind="angle" value={p.angle ?? "0"} hint="Rotate the plane about one of its own axes" onChange={(v) => set("Tilt", (pl) => (pl.kind === "origin" ? { ...pl, angle: v } : pl))} />
          <Segmented
            label="Tilt about"
            value={p.tilt ?? "x"}
            options={[
              { value: "x", label: "X axis" },
              { value: "y", label: "Y axis" },
            ]}
            onChange={(v) => set("Tilt axis", (pl) => (pl.kind === "origin" ? { ...pl, tilt: v } : pl))}
          />
        </>
      )}
    </>
  );
}

function ConstructEditor({ f }: { f: ConstructFeature }) {
  const need = CONSTRUCT_MODES[f.mode];
  const has = f.faces.length + f.edges.length + f.points.length;
  const parts = [f.faces.length && `${f.faces.length} face${f.faces.length > 1 ? "s" : ""}`, f.edges.length && `${f.edges.length} edge${f.edges.length > 1 ? "s" : ""}`, f.points.length && `${f.points.length} point${f.points.length > 1 ? "s" : ""}`].filter(Boolean);
  return (
    <>
      <div className="picker">
        <Icon name={f.mode.startsWith("axis") ? "axis" : f.mode.startsWith("point") ? "point" : "plane"} size={16} />
        <span>{has === 0 ? need.hint : parts.join(" · ")}</span>
        {has > 0 && (
          <button className="link" onClick={() => upd(f, "Clear picks", (d) => void (d.type === "construct" && ((d.faces = []), (d.edges = []), (d.points = []))))}>
            Clear
          </button>
        )}
      </div>
      {need.value && (
        <ExprInput
          label={need.value === "angle" ? "Angle" : "Position (%)"}
          kind={need.value === "angle" ? "angle" : "number"}
          value={f.value}
          autoFocus
          hint={need.value === "angle" ? "Rotation from the reference" : "0 = start of the edge, 100 = end"}
          onChange={(v) => upd(f, "Value", (d) => void (d.type === "construct" && (d.value = v)))}
        />
      )}
    </>
  );
}

/** Which areas of the sketch an extrude or revolve uses, with a way back to the whole sketch. */
function RegionLine({ f }: { f: ExtrudeFeature | RevolveFeature }) {
  const n = f.regions?.length ?? 0;
  const many = useApp((s) => (s.regen?.sketches.find((x) => x.id === f.sketch)?.regions?.length ?? 0) > 1);
  if (!n && !many) return null;
  return (
    <PickLine
      icon="select"
      text={n ? `${n} area${n > 1 ? "s" : ""} of the sketch. Click areas in the view to add or remove them` : "The whole sketch (shapes inside shapes are holes). Click an area in the view to use only that"}
      clearable={n > 0}
      onClear={() => upd(f, "Whole sketch", (d) => void ((d.type === "extrude" || d.type === "revolve") && (d.regions = undefined)))}
    />
  );
}

function PickLine({ icon, text, onClear, clearable }: { icon: "move" | "thread" | "trash" | "plane" | "select"; text: string; onClear: () => void; clearable: boolean }) {
  return (
    <div className="picker">
      <Icon name={icon} size={16} />
      <span>{text}</span>
      {clearable && (
        <button className="link" onClick={onClear}>
          Clear
        </button>
      )}
    </div>
  );
}

function RibEditor({ f }: { f: RibFeature }) {
  const sketches = useSketchesBefore(f.id);
  const set = (label: string, recipe: (d: RibFeature) => void) => upd(f, label, (d) => void (d.type === "rib" && recipe(d)));
  return (
    <>
      <Select label="Rib line" value={f.sketch} placeholder="Click a sketch with an open line…" options={sketches.map((s) => ({ value: s.id, label: s.name, icon: "path" as const }))} onChange={(v) => set("Sketch", (d) => void (d.sketch = v))} />
      <ExprInput label="Thickness" kind="length" value={f.thickness} autoFocus hint="Wall thickness, centered on the sketch plane" onChange={(v) => set("Thickness", (d) => void (d.thickness = v))} />
      <ExprInput label="Depth" kind="length" value={f.depth} hint="How far the rib reaches from the line, sideways in the sketch plane" onChange={(v) => set("Depth", (d) => void (d.depth = v))} />
      <Toggle label="Flip side" checked={f.flip} onChange={(v) => set("Flip", (d) => void (d.flip = v))} />
      <Segmented label="Result" value={f.op} options={OPS} onChange={(op) => setBodyOp(f.id, op)} />
      {f.op !== "new" && <BodySelect label="Body" value={f.target} allowAuto="Latest body" exclude={f.id} onChange={(v) => set("Body", (d) => void (d.target = v))} />}
    </>
  );
}

function ThreadEditor({ f }: { f: ThreadFeature }) {
  const set = (label: string, recipe: (d: ThreadFeature) => void) => upd(f, label, (d) => void (d.type === "thread" && recipe(d)));
  return (
    <>
      <PickLine icon="thread" text={f.face ? "Round face selected" : "Click the round face to thread (a rod or a hole)"} clearable={!!f.face} onClear={() => set("Clear face", (d) => void (d.face = null))} />
      <ExprInput label="Pitch" kind="length" value={f.pitch} autoFocus hint="Distance between turns" onChange={(v) => set("Pitch", (d) => void (d.pitch = v))} />
      <Toggle label="Whole length" checked={!f.length} onChange={(on) => set("Length", (d) => void (d.length = on ? "" : "10"))} />
      {f.length && <ExprInput label="Length" kind="length" value={f.length} onChange={(v) => set("Length", (d) => void (d.length = v))} />}
      <Toggle label="Automatic depth" checked={!f.depth} onChange={(on) => set("Depth", (d) => void (d.depth = on ? "" : "1"))} />
      {f.depth && <ExprInput label="Depth" kind="length" value={f.depth} onChange={(v) => set("Depth", (d) => void (d.depth = v))} />}
      <Toggle label="Left-handed" checked={f.lefthand} onChange={(v) => set("Hand", (d) => void (d.lefthand = v))} />
    </>
  );
}

function ReplaceFaceEditor({ f }: { f: ReplaceFaceFeature }) {
  const features = useApp((s) => s.doc.features);
  const set = (label: string, recipe: (d: ReplaceFaceFeature) => void) => upd(f, label, (d) => void (d.type === "replaceFace" && recipe(d)));
  const planes = constructsBefore(features, f.id, "plane");
  const useFace = f.plane === undefined;
  return (
    <>
      <PickLine icon="move" text={f.faces.length ? `${f.faces.length} face${f.faces.length > 1 ? "s" : ""} to replace` : "Click the flat faces to replace"} clearable={f.faces.length > 0} onClear={() => set("Clear faces", (d) => void (d.faces = []))} />
      <Segmented
        label="Replace with"
        value={useFace ? "face" : "plane"}
        options={[
          { value: "face", label: "A flat face" },
          { value: "plane", label: "A plane" },
        ]}
        onChange={(v) => set("Target", (d) => (v === "face" ? ((d.plane = undefined), (d.pickTarget = true)) : ((d.target = null), (d.pickTarget = false), (d.plane = planes[0]?.id ?? ""))))}
      />
      {useFace ? (
        <div className="picker">
          <Icon name="plane" size={16} />
          <span>{f.target ? "Target face selected" : f.pickTarget ? "Now click the target face" : "No target yet"}</span>
          <button className="link" onClick={() => set("Pick target", (d) => void (d.pickTarget = true))}>
            {f.target ? "Change" : "Pick"}
          </button>
        </div>
      ) : (
        <Select label="Plane" value={f.plane ?? ""} placeholder="Make a construction plane first" options={planes.map((c) => ({ value: c.id, label: c.name, icon: "plane" as const }))} onChange={(v) => set("Plane", (d) => void (d.plane = v))} />
      )}
    </>
  );
}

function DeleteFaceEditor({ f }: { f: DeleteFaceFeature }) {
  return (
    <>
      <PickLine icon="trash" text={f.faces.length ? `${f.faces.length} face${f.faces.length > 1 ? "s" : ""} selected` : "Click every wall of a hole, pocket or boss"} clearable={f.faces.length > 0} onClear={() => upd(f, "Clear faces", (d) => void (d.type === "deleteFace" && (d.faces = [])))} />
      <p className="field__note">The opening must be flat. The gap is filled (or the boss removed) and the body healed.</p>
    </>
  );
}

function AlignEditor({ f }: { f: AlignFeature }) {
  const set = (label: string, recipe: (d: AlignFeature) => void) => upd(f, label, (d) => void (d.type === "align" && recipe(d)));
  return (
    <>
      <PickLine icon="move" text={!f.from ? "Click a flat face on the body to move" : !f.to ? "Now click the flat face it should meet" : "Faces chosen"} clearable={!!f.from} onClear={() => set("Clear faces", (d) => ((d.from = null), (d.to = null)))} />
      <Toggle label="Turn it around" checked={f.flip} onChange={(v) => set("Flip", (d) => void (d.flip = v))} />
      <ExprInput label="Gap" kind="length" value={f.offset} hint="Distance left between the two faces" onChange={(v) => set("Gap", (d) => void (d.offset = v))} />
    </>
  );
}

function BoundaryFillEditor({ f }: { f: BoundaryFillFeature }) {
  const bodies = useApp((s) => s.regen?.pickBodies ?? s.regen?.bodies ?? []);
  const meta = useApp((s) => s.doc.bodies);
  const cells = useApp((s) => s.regen?.status.find((x) => x.id === f.id)?.cells);
  const set = (label: string, recipe: (d: BoundaryFillFeature) => void) => upd(f, label, (d) => void (d.type === "boundaryFill" && recipe(d)));
  return (
    <>
      <div className="field">
        <span className="field__label">Tool bodies</span>
        <div className="checklist">
          {bodies
            .filter((b) => b.id !== f.id)
            .map((b) => (
              <Checkbox
                key={b.id}
                className="checkrow"
                checked={f.tools.includes(b.id)}
                onChange={(on) => set("Tools", (d) => void (d.tools = on ? [...d.tools, b.id] : d.tools.filter((x) => x !== b.id)))}
                label={
                  <>
                    <span className="tree__swatch" style={{ background: meta[b.id]?.color ?? "#ccc" }} />
                    {meta[b.id]?.name ?? "Body"}
                  </>
                }
              />
            ))}
        </div>
      </div>
      <div className="field">
        <span className="field__label">Cells to keep</span>
        <div className="checklist">
          {(cells ?? []).map((c, i) => (
            <Checkbox key={i} className="checkrow" checked={f.cells.includes(i)} onChange={(on) => set("Cells", (d) => void (d.cells = on ? [...d.cells, i] : d.cells.filter((x) => x !== i)))} label={`Cell ${i + 1} · ${Math.round(c.volume)} mm³`} />
          ))}
          {!cells?.length && <p className="field__note">Choose two or more overlapping bodies.</p>}
        </div>
      </div>
      <Toggle label="Keep the tool bodies" checked={f.keepTools} onChange={(v) => set("Keep tools", (d) => void (d.keepTools = v))} />
    </>
  );
}

const JOINT_TYPES = [
  { value: "rigid", label: "Rigid: no motion" },
  { value: "revolute", label: "Revolute: turns about an axis" },
  { value: "slider", label: "Slider: slides along an axis" },
  { value: "cylindrical", label: "Cylindrical: turns and slides" },
  { value: "pinslot", label: "Pin-slot: turns on a pin that slides" },
  { value: "planar", label: "Planar: slides and turns on a plane" },
  { value: "ball", label: "Ball: turns every way" },
] as const;

/** A drag bar that drives a joint value live (and Play sweeps it back and forth). */
function Drive({ f, field, min, max, unit }: { f: JointFeature; field: "angle" | "distance"; min: number; max: number; unit: string }) {
  const timer = useRef<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const value = Number.parseFloat(f[field]);
  const write = (v: number) => updateFeature(f.id, "Drive joint", (d) => void (d.type === "joint" && (d[field] = String(Math.round(v * 100) / 100))), f.id + "drive");
  useEffect(
    () => () => {
      if (timer.current) window.clearInterval(timer.current);
    },
    [],
  );
  const play = () => {
    if (timer.current) {
      window.clearInterval(timer.current);
      timer.current = null;
      return setPlaying(false);
    }
    let dir = 1;
    let v = Number.isFinite(value) ? value : min;
    setPlaying(true);
    timer.current = window.setInterval(() => {
      v += (dir * (max - min)) / 40;
      if (v >= max) ((v = max), (dir = -1));
      if (v <= min) ((v = min), (dir = 1));
      write(v);
    }, 120);
  };
  return (
    <div className="field">
      <span className="field__label">Drive ({unit})</span>
      <div className="field-row">
        <input type="range" min={min} max={max} step={(max - min) / 200} value={Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min} onChange={(e) => write(Number(e.target.value))} style={{ flex: 1 }} aria-label="Drive the joint" />
        <button className="link" onClick={play}>
          {playing ? "Stop" : "Play"}
        </button>
      </div>
    </div>
  );
}

function CurveEditor({ f }: { f: CurveFeature }) {
  const set = (label: string, recipe: (d: CurveFeature) => void) => upd(f, label, (d) => void (d.type === "curve" && recipe(d)));
  const text =
    f.source === "points"
      ? f.points.length
        ? `${f.points.length} point${f.points.length > 1 ? "s" : ""}`
        : CURVE_SOURCES.points.hint
      : f.source === "edges"
        ? f.edges.length
          ? `${f.edges.length} edge${f.edges.length > 1 ? "s" : ""}`
          : CURVE_SOURCES.edges.hint
        : f.source === "faces"
          ? f.faces.length >= 2
            ? "Two faces chosen"
            : f.faces.length === 1
              ? "Now click the second face"
              : CURVE_SOURCES.faces.hint
          : !f.faces.length
            ? "Click the face to project onto"
            : !f.sketch
              ? "Now click the sketch to lay onto it"
              : "Face and sketch chosen";
  const any = f.points.length + f.edges.length + f.faces.length > 0 || !!f.sketch;
  return (
    <>
      <PickLine icon="plane" text={text} clearable={any} onClear={() => set("Clear picks", (d) => ((d.points = []), (d.edges = []), (d.faces = []), (d.sketch = undefined)))} />
      {f.source === "points" && f.points.length > 0 && (
        <button className="link" onClick={() => set("Remove last point", (d) => void d.points.pop())}>
          Remove the last point
        </button>
      )}
      {f.source === "points" && <Toggle label="Smooth curve" hint="Off draws straight segments between the points" checked={f.smooth} onChange={(v) => set("Smooth", (d) => void (d.smooth = v))} />}
      <p className="field__note">Sweeps, pipes and path patterns can follow this curve.</p>
    </>
  );
}

function SurfaceEditor({ f }: { f: SurfaceFeature }) {
  const features = useApp((s) => s.doc.features);
  const bodies = useApp((s) => s.regen?.pickBodies ?? s.regen?.bodies ?? []);
  const meta = useApp((s) => s.doc.bodies);
  const set = (label: string, recipe: (d: SurfaceFeature) => void) => upd(f, label, (d) => void (d.type === "surface" && recipe(d)));
  const op = f.op;
  const byEdges = op === "patch" || op === "ruled";
  const byFaces = op === "offset" || op === "untrim" || op === "extend";
  const byBody = op === "trim" || op === "unstitch" || op === "merge" || op === "reverse" || op === "thicken";
  const picked = byEdges ? f.edges.length : byFaces ? f.faces.length : op === "stitch" ? f.bodies.length : f.bodyId ? 1 : 0;
  const noun = byEdges ? "edge" : byFaces ? "face" : "body";
  const needsDistance = op === "ruled" || op === "offset" || op === "extend" || op === "thicken";
  const planes = constructsBefore(features, f.id, "plane");
  return (
    <>
      <PickLine
        icon="plane"
        text={picked ? (op === "stitch" || byEdges || byFaces ? `${picked} ${noun}${picked > 1 ? (noun === "body" ? "ies" : "s") : ""}`.replace("bodys", "bodies") : "Body chosen") : SURFACE_OPS[op].hint}
        clearable={picked > 0}
        onClear={() => set("Clear", (d) => ((d.edges = []), (d.faces = []), (d.bodies = []), (d.bodyId = undefined)))}
      />
      {op === "stitch" && (
        <div className="field">
          <span className="field__label">Surface bodies</span>
          <div className="checklist">
            {bodies
              .filter((b) => b.id !== f.id)
              .map((b) => (
                <Checkbox key={b.id} className="checkrow" checked={f.bodies.includes(b.id)} onChange={(on) => set("Bodies", (d) => void (d.bodies = on ? [...d.bodies, b.id] : d.bodies.filter((x) => x !== b.id)))} label={meta[b.id]?.name ?? "Body"} />
              ))}
          </div>
        </div>
      )}
      {needsDistance && <ExprInput label={op === "thicken" ? "Thickness" : "Distance"} kind="length" value={f.distance} autoFocus hint={op === "offset" ? "0 copies the faces without moving them" : op === "extend" ? "Positive grows the face all around, negative shrinks it" : undefined} onChange={(v) => set("Distance", (d) => void (d.distance = v))} />}
      {op === "thicken" && <Toggle label="Grow both ways" checked={!!f.both} onChange={(v) => set("Both", (d) => void (d.both = v))} />}
      {op === "thicken" && <Toggle label="Keep the surface" checked={!!f.keep2} onChange={(v) => set("Keep", (d) => void (d.keep2 = v))} />}
      {op === "ruled" && (
        <Segmented
          label="Direction"
          value={f.direction}
          options={[
            { value: "normal", label: "Out of the face", title: "Along the normal of the face the edge belongs to" },
            { value: "tangent", label: "Along the face", title: "Continues the face past the edge" },
            { value: "axis", label: "Along an axis" },
          ]}
          onChange={(v) => set("Direction", (d) => void (d.direction = v))}
        />
      )}
      {op === "ruled" && f.direction === "axis" && (
        <Segmented
          label="Axis"
          value={f.axis}
          options={[
            { value: "x", label: "X" },
            { value: "y", label: "Y" },
            { value: "z", label: "Z" },
          ]}
          onChange={(v) => set("Axis", (d) => void (d.axis = v))}
        />
      )}
      {op === "trim" && (
        <>
          <Select
            label="Plane"
            value={f.planeRef ?? f.plane}
            options={[...ORIGIN_PLANES, ...planes.map((c) => ({ value: c.id, label: c.name, icon: "plane" as const }))]}
            onChange={(v) => set("Plane", (d) => (v === "YZ" || v === "XZ" || v === "XY" ? ((d.plane = v), (d.planeRef = undefined)) : (d.planeRef = v)))}
          />
          <ExprInput label="Offset" kind="length" value={f.offset} onChange={(v) => set("Offset", (d) => void (d.offset = v))} />
          <Segmented
            label="Keep"
            value={f.keep}
            options={[
              { value: "below", label: "Below the plane" },
              { value: "above", label: "Above the plane" },
            ]}
            onChange={(v) => set("Keep", (d) => void (d.keep = v))}
          />
        </>
      )}
      {byBody && op !== "trim" && op !== "thicken" && <p className="field__note">{SURFACE_OPS[op].hint}</p>}
    </>
  );
}

function JointEditor({ f }: { f: JointFeature }) {
  const features = useApp((s) => s.doc.features);
  const t = f.joint;
  const turns = t === "revolute" || t === "cylindrical" || t === "pinslot" || t === "planar";
  const slides = t === "slider" || t === "cylindrical" || t === "pinslot" || t === "planar";
  const ball = t === "ball";
  const mainIsTurn = t === "revolute" || ball;
  const limitKind = t === "revolute" ? "angle" : "length";
  const set = (label: string, recipe: (d: JointFeature) => void) => upd(f, label, (d) => void (d.type === "joint" && recipe(d)));
  const axes = constructsBefore(features, f.id, "axis");
  const points = features.slice(0, features.findIndex((x) => x.id === f.id)).filter((x) => x.type === "construct" && x.mode.startsWith("point"));
  const others = features.slice(0, features.findIndex((x) => x.id === f.id)).filter((x) => x.type === "joint");
  const lim = f.limited ? [Number.parseFloat(f.min), Number.parseFloat(f.max)] : null;
  return (
    <>
      <BodySelect label="Moving body" value={f.bodyId} allowAuto="Choose…" exclude={f.id} onChange={(v) => set("Body", (d) => void (d.bodyId = v))} />
      <BodySelect label="Attached to" value={f.fixedId} allowAuto="Choose…" exclude={f.id} onChange={(v) => set("Attached to", (d) => void (d.fixedId = v))} />
      <Select
        label="Joint"
        value={f.joint}
        options={JOINT_TYPES.map((j) => ({ value: j.value, label: j.label }))}
        onChange={(v) =>
          set("Joint type", (d) => {
            d.joint = v;
            d.min = v === "revolute" ? "-90" : "-50";
            d.max = v === "revolute" ? "90" : "50";
          })
        }
      />
      {t !== "rigid" && (
        <Select
          label="Axis"
          value={f.axisRef ?? f.axis}
          options={[...ORIGIN_AXES, ...axes.map((c) => ({ value: c.id, label: c.name, icon: "axis" as const }))]}
          onChange={(v) => set("Axis", (d) => (v === "x" || v === "y" || v === "z" ? ((d.axis = v), (d.axisRef = undefined)) : (d.axisRef = v)))}
        />
      )}
      {(turns || ball) && (
        <>
          <Segmented
            label="Pivot at"
            value={f.origin}
            options={[
              { value: "center", label: "Body center" },
              { value: "point", label: "A point" },
            ]}
            onChange={(v) => set("Pivot", (d) => void (d.origin = v))}
          />
          {f.origin === "point" && !f.originRef && (
            <div className="field-row">
              {(["X", "Y", "Z"] as const).map((axis, i) => (
                <ExprInput key={axis} label={axis} kind="length" value={f.point[i]!} onChange={(v) => set("Pivot", (d) => void (d.point[i] = v))} />
              ))}
            </div>
          )}
          {points.length > 0 && (
            <Select
              label="Joint origin"
              value={f.originRef ?? ""}
              placeholder="None (use the pivot above)"
              options={[{ value: "", label: "None" }, ...points.map((c) => ({ value: c.id, label: c.name, icon: "point" as const }))]}
              onChange={(v) => set("Joint origin", (d) => void (d.originRef = v || undefined))}
            />
          )}
        </>
      )}
      {(turns || ball) && <ExprInput label={ball ? "Turn about X" : "Angle"} kind="angle" value={f.angle} autoFocus hint="Drive the joint: change this to turn the body" onChange={(v) => set("Angle", (d) => void (d.angle = v))} />}
      {ball && <ExprInput label="Turn about Y" kind="angle" value={f.angle2 ?? "0"} onChange={(v) => set("Angle Y", (d) => void (d.angle2 = v))} />}
      {ball && <ExprInput label="Turn about Z" kind="angle" value={f.angle3 ?? "0"} onChange={(v) => set("Angle Z", (d) => void (d.angle3 = v))} />}
      {slides && <ExprInput label={t === "planar" ? "Slide along the plane (1)" : "Distance"} kind="length" value={f.distance} autoFocus={!turns} hint="Drive the joint: change this to slide the body" onChange={(v) => set("Distance", (d) => void (d.distance = v))} />}
      {t === "planar" && <ExprInput label="Slide along the plane (2)" kind="length" value={f.distance2 ?? "0"} onChange={(v) => set("Distance 2", (d) => void (d.distance2 = v))} />}
      {t !== "rigid" && !f.link && (
        <Drive
          f={f}
          field={mainIsTurn ? "angle" : "distance"}
          min={lim && Number.isFinite(lim[0]) ? lim[0]! : mainIsTurn ? -180 : -50}
          max={lim && Number.isFinite(lim[1]) ? lim[1]! : mainIsTurn ? 180 : 50}
          unit={mainIsTurn ? "degrees" : "length"}
        />
      )}
      {t !== "rigid" && <Toggle label="Warn on collisions" hint="Flag the joint when the moving part runs into another body" checked={!!f.collide} onChange={(v) => set("Collisions", (d) => void (d.collide = v))} />}
      {t !== "rigid" && !ball && (
        <>
          <Toggle label="Limit the travel" checked={f.limited} onChange={(v) => set("Limits", (d) => void (d.limited = v))} />
          {f.limited && (
            <div className="field-row">
              <ExprInput label="Min" kind={limitKind} value={f.min} onChange={(v) => set("Minimum", (d) => void (d.min = v))} />
              <ExprInput label="Max" kind={limitKind} value={f.max} onChange={(v) => set("Maximum", (d) => void (d.max = v))} />
            </div>
          )}
        </>
      )}
      {t !== "rigid" && others.length > 0 && (
        <Disclosure summary="Motion link (gears, lead screws)" defaultOpen={!!f.link}>
          <Select
            label="Follows joint"
            value={f.link?.joint ?? ""}
            placeholder="Independent"
            options={[{ value: "", label: "Independent" }, ...others.map((j) => ({ value: j.id, label: j.name }))]}
            onChange={(v) => set("Motion link", (d) => void (d.link = v ? { joint: v, ratio: d.link?.ratio ?? "1" } : undefined))}
          />
          {f.link && <ExprInput label="Ratio" kind="number" value={f.link.ratio} hint="Value = ratio × the other joint's value (degrees or length). Use -1 to run opposite, 5 for 5 mm per degree." onChange={(v) => set("Link ratio", (d) => void (d.link && (d.link.ratio = v)))} />}
        </Disclosure>
      )}
    </>
  );
}

function OffsetFaceEditor({ f }: { f: OffsetFaceFeature }) {
  const n = f.faces.length;
  return (
    <>
      <div className="picker">
        <Icon name="move" size={16} />
        <span>{n === 0 ? "Click the flat faces to push or pull" : `${n} face${n > 1 ? "s" : ""}`}</span>
        {n > 0 && (
          <button className="link" onClick={() => upd(f, "Clear faces", (d) => void (d.type === "offsetFace" && (d.faces = [])))}>
            Clear
          </button>
        )}
      </div>
      <ExprInput label="Distance" kind="length" value={f.distance} autoFocus hint="Positive pulls the face out and adds material; negative pushes it in and removes material" onChange={(v) => upd(f, "Distance", (d) => void (d.type === "offsetFace" && (d.distance = v)))} />
    </>
  );
}

export function FeatureEditor({ f }: { f: Feature }) {
  switch (f.type) {
    case "sweep":
      return <SweepEditor f={f} />;
    case "coil":
      return <CoilEditor f={f} />;
    case "split":
      return <SplitEditor f={f} />;
    case "offset":
      return <OffsetEditor f={f} />;
    case "boundingSolid":
      return <BoundingSolidEditor f={f} />;
    case "scale":
      return <ScaleEditor f={f} />;
    case "offsetFace":
      return <OffsetFaceEditor f={f} />;
    case "cplane":
      return <ConstructionPlaneEditor f={f} />;
    case "joint":
      return <JointEditor f={f} />;
    case "construct":
      return <ConstructEditor f={f} />;
    case "curve":
      return <CurveEditor f={f} />;
    case "surface":
      return <SurfaceEditor f={f} />;
    case "rib":
      return <RibEditor f={f} />;
    case "thread":
      return <ThreadEditor f={f} />;
    case "replaceFace":
      return <ReplaceFaceEditor f={f} />;
    case "deleteFace":
      return <DeleteFaceEditor f={f} />;
    case "align":
      return <AlignEditor f={f} />;
    case "boundaryFill":
      return <BoundaryFillEditor f={f} />;
    case "draft":
      return <DraftEditor f={f} />;
    case "hole":
      return <HoleEditor f={f} />;
    case "loft":
      return <LoftEditor f={f} />;
    case "move":
      return <MoveEditor f={f} />;
    case "combine":
      return <CombineEditor f={f} />;
    case "import":
      return <ImportEditor f={f} />;
    case "extrude":
      return <ExtrudeEditor f={f} />;
    case "revolve":
      return <RevolveEditor f={f} />;
    case "fillet":
    case "chamfer":
      return <EdgeEditor f={f} />;
    case "shell":
      return <ShellEditor f={f} />;
    case "primitive":
      return <PrimitiveEditor f={f} />;
    case "mirror":
      return <MirrorEditor f={f} />;
    case "pattern":
      return <PatternEditor f={f} />;
    case "sketch":
      return null;
  }
}