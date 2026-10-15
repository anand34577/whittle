/** Property editors for each feature type (shown in the right-hand panel). */
import type { Draft } from "immer";
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
  ScaleFeature,
  ConstructionPlaneFeature,
  JointFeature,
  PlaneRef,
  DraftFeature,
  OffsetFaceFeature,
} from "@whittle/core";
import { setBodyOp, updateFeature, useApp } from "../state/store";
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
  { value: "intersect", label: "Keep overlap", title: "Keep only where they overlap" },
];

const AUTO = "__auto__";

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
  return (
    <>
      <Segmented label="Result" value={f.op} options={OPS} onChange={(op) => setBodyOp(f.id, op)} />
      {f.op !== "new" && (
        <BodySelect
          value={f.target}
          exclude={f.id}
          allowAuto={f.op === "join" ? "Latest body" : "All bodies it touches"}
          onChange={(v) => upd(f, "Target", (d) => void (d.target = v))}
        />
      )}
    </>
  );
}

function ExtrudeEditor({ f }: { f: ExtrudeFeature }) {
  const advanced = !!(f.taper || f.twist);
  return (
    <>
      <SketchSelect f={f} label="Profile" value={f.sketch} onChange={(v) => upd(f, "Profile", (d) => void (d.sketch = v))} />
      {f.extent !== "through" && (
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
        ]}
        onChange={(v) => upd(f, "Direction", (d) => void (d.extent = v))}
      />
      {f.extent === "two" && (
        <ExprInput label="Other side" kind="length" value={f.distance2 ?? "0"} min={0} onChange={(v) => upd(f, "Second distance", (d) => void (d.distance2 = v))} />
      )}
      {f.extent !== "symmetric" && <Toggle label="Flip direction" checked={f.flip} onChange={(v) => upd(f, "Flip", (d) => void (d.flip = v))} />}
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
      <OpField f={f} />
    </>
  );
}

function RevolveEditor({ f }: { f: RevolveFeature }) {
  const sketch = useApp((s) => s.doc.features.find((x): x is SketchFeature => x.id === f.sketch && x.type === "sketch"));
  const lines = (sketch?.entities ?? []).filter((e) => e.type === "polyline" && (e.open || e.construction));
  return (
    <>
      <SketchSelect f={f} label="Profile" value={f.sketch} onChange={(v) => upd(f, "Profile", (d) => void (d.sketch = v))} />
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
      <ExprInput label="Angle" kind="angle" value={f.angle} autoFocus onChange={(v) => upd(f, "Angle", (d) => void (d.angle = v))} />
      <OpField f={f} />
    </>
  );
}

function EdgeEditor({ f }: { f: FilletFeature | ChamferFeature }) {
  const n = f.edges.length;
  return (
    <>
      <div className="picker">
        <Icon name="fillet" size={16} />
        <span>{n === 0 ? "No edges yet: click edges in the view" : `${n} edge${n > 1 ? "s" : ""}`}</span>
        {n > 0 && (
          <button className="link" onClick={() => upd(f, "Clear edges", (d) => void (d.edges = []))}>
            Clear
          </button>
        )}
      </div>
      {f.type === "fillet" ? (
        <ExprInput label="Radius" kind="length" value={f.radius} autoFocus min={0} onChange={(v) => upd(f, "Radius", (d) => void ((d as FilletFeature).radius = v))} />
      ) : (
        <ExprInput label="Distance" kind="length" value={f.distance} autoFocus min={0} onChange={(v) => upd(f, "Distance", (d) => void ((d as ChamferFeature).distance = v))} />
      )}
    </>
  );
}

function ShellEditor({ f }: { f: ShellFeature }) {
  const n = f.faces.length;
  return (
    <>
      <div className="picker">
        <Icon name="shell" size={16} />
        <span>{n === 0 ? "Click the face(s) to open" : `${n} open face${n > 1 ? "s" : ""}`}</span>
        {n > 0 && (
          <button className="link" onClick={() => upd(f, "Clear faces", (d) => void (d.faces = []))}>
            Clear
          </button>
        )}
      </div>
      <ExprInput label="Wall" kind="length" value={f.thickness} autoFocus min={0} hint="Typical: moulded plastic 1.5–3 mm, 3D prints 1.2–2 mm, cast metal 3+ mm" onChange={(v) => upd(f, "Thickness", (d) => void (d.thickness = v))} />
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

function MirrorEditor({ f }: { f: MirrorFeature }) {
  return (
    <>
      <BodySelect value={f.bodyId} allowAuto="Latest body" exclude={f.id} onChange={(v) => upd(f, "Body", (d) => void (d.bodyId = v))} />
      <Segmented
        label="Mirror plane"
        value={f.plane}
        options={[
          { value: "YZ", label: "YZ (left/right)" },
          { value: "XZ", label: "XZ (front/back)" },
          { value: "XY", label: "XY (top/bottom)" },
        ]}
        onChange={(v) => upd(f, "Plane", (d) => void (d.plane = v))}
      />
      <ExprInput
        label="Plane offset"
        kind="length"
        value={f.offset ?? "0"}
        hint="Move the mirror plane along its normal"
        onChange={(v) => upd(f, "Offset", (d) => void (d.offset = v === "0" ? undefined : v))}
      />
      <Toggle label="Merge with the original" checked={f.merge} onChange={(v) => upd(f, "Merge", (d) => void (d.merge = v))} />
    </>
  );
}

function PatternEditor({ f }: { f: PatternFeature }) {
  return (
    <>
      <BodySelect value={f.bodyId} allowAuto="Latest body" exclude={f.id} onChange={(v) => upd(f, "Body", (d) => void (d.bodyId = v))} />
      <Segmented
        label="Type"
        value={f.pattern}
        options={[
          { value: "linear", label: "In a row" },
          { value: "circular", label: "Around an axis" },
        ]}
        onChange={(v) => upd(f, "Type", (d) => void (d.pattern = v))}
      />
      <Segmented
        label={f.pattern === "linear" ? "Direction" : "Axis"}
        value={f.axis}
        options={[
          { value: "x", label: "X" },
          { value: "y", label: "Y" },
          { value: "z", label: "Z" },
        ]}
        onChange={(v) => upd(f, "Axis", (d) => void (d.axis = v))}
      />
      <ExprInput label="Count" kind="count" value={f.count} autoFocus min={2} onChange={(v) => upd(f, "Count", (d) => void (d.count = v))} />
      {f.pattern === "linear" ? (
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
      <Toggle label="Merge copies into one body" checked={f.merge} onChange={(v) => upd(f, "Merge", (d) => void (d.merge = v))} />
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
      {f.style !== "simple" && (
        <div className="field-row">
          <ExprInput label="Head Ø" kind="length" value={f.headDiameter} min={0} onChange={(v) => upd(f, "Head diameter", (d) => void (d.headDiameter = v))} />
          {f.style === "counterbore" && <ExprInput label="Head depth" kind="length" value={f.headDepth} min={0} onChange={(v) => upd(f, "Head depth", (d) => void (d.headDepth = v))} />}
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
          { value: "intersect", label: "Keep overlap" },
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
      <ExprInput label="Scale" kind="count" value={f.scale} autoFocus min={0} hint="25.4 converts a part modelled in inches" onChange={(v) => upd(f, "Scale", (d) => void (d.scale = v))} />
    </>
  );
}

function PipeEditor({ f }: { f: SweepFeature }) {
  const pipe = f.pipe!;
  const set = (label: string, recipe: (p: NonNullable<SweepFeature["pipe"]>) => void) => upd(f, label, (d) => void (d.type === "sweep" && d.pipe && recipe(d.pipe)));
  return (
    <>
      <SketchSelect f={f} label="Path" value={f.path} placeholder="The path to follow…" onChange={(v) => upd(f, "Path", (d) => void (d.type === "sweep" && (d.path = v)))} />
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
      <SketchSelect f={f} label="Path" value={f.path} placeholder="The path to follow…" onChange={(v) => upd(f, "Path", (d) => void (d.path = v))} />
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
      <Segmented
        label="Plane"
        value={f.plane}
        options={[
          { value: "XY", label: "XY (horizontal)" },
          { value: "XZ", label: "XZ (front)" },
          { value: "YZ", label: "YZ (side)" },
        ]}
        onChange={(v) => upd(f, "Plane", (d) => void (d.plane = v))}
      />
      <ExprInput label="Offset" kind="length" value={f.offset} autoFocus onChange={(v) => upd(f, "Offset", (d) => void (d.offset = v))} />
      <Segmented
        label="Keep"
        value={f.keep}
        options={[
          { value: "both", label: "Both halves" },
          { value: "above", label: "Above" },
          { value: "below", label: "Below" },
        ]}
        onChange={(v) => upd(f, "Keep", (d) => void (d.keep = v))}
      />
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

function JointEditor({ f }: { f: JointFeature }) {
  const turns = f.joint === "revolute" || f.joint === "cylindrical";
  const slides = f.joint === "slider" || f.joint === "cylindrical";
  const limitKind = f.joint === "revolute" ? "angle" : "length";
  const set = (label: string, recipe: (d: JointFeature) => void) => upd(f, label, (d) => void (d.type === "joint" && recipe(d)));
  return (
    <>
      <BodySelect label="Moving body" value={f.bodyId} allowAuto="Choose…" exclude={f.id} onChange={(v) => set("Body", (d) => void (d.bodyId = v))} />
      <BodySelect label="Attached to" value={f.fixedId} allowAuto="Choose…" exclude={f.id} onChange={(v) => set("Attached to", (d) => void (d.fixedId = v))} />
      <Segmented
        label="Joint"
        value={f.joint}
        options={[
          { value: "rigid", label: "Rigid", title: "No motion: holds the body where it is" },
          { value: "revolute", label: "Revolute", title: "Turns about an axis (hinge, wheel)" },
          { value: "slider", label: "Slider", title: "Slides along an axis (drawer, piston)" },
          { value: "cylindrical", label: "Cylindrical", title: "Turns and slides along the same axis (screw)" },
        ]}
        onChange={(v) =>
          set("Joint type", (d) => {
            d.joint = v;
            d.min = v === "revolute" ? "-90" : "-50";
            d.max = v === "revolute" ? "90" : "50";
          })
        }
      />
      {f.joint !== "rigid" && (
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
      {turns && (
        <Segmented
          label="Pivot at"
          value={f.origin}
          options={[
            { value: "center", label: "Body center" },
            { value: "point", label: "A point" },
          ]}
          onChange={(v) => set("Pivot", (d) => void (d.origin = v))}
        />
      )}
      {turns && f.origin === "point" && (
        <div className="field-row">
          {(["X", "Y", "Z"] as const).map((axis, i) => (
            <ExprInput key={axis} label={axis} kind="length" value={f.point[i]!} onChange={(v) => set("Pivot", (d) => void (d.point[i] = v))} />
          ))}
        </div>
      )}
      {turns && <ExprInput label="Angle" kind="angle" value={f.angle} autoFocus hint="Drive the joint: change this to turn the body" onChange={(v) => set("Angle", (d) => void (d.angle = v))} />}
      {slides && <ExprInput label="Distance" kind="length" value={f.distance} autoFocus={!turns} hint="Drive the joint: change this to slide the body" onChange={(v) => set("Distance", (d) => void (d.distance = v))} />}
      {f.joint !== "rigid" && (
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
    case "scale":
      return <ScaleEditor f={f} />;
    case "offsetFace":
      return <OffsetFaceEditor f={f} />;
    case "cplane":
      return <ConstructionPlaneEditor f={f} />;
    case "joint":
      return <JointEditor f={f} />;
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