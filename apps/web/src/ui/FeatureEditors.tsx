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
} from "@whittle/core";
import { setBodyOp, updateFeature, useApp } from "../state/store";
import { ExprInput, Segmented, Toggle } from "./ExprInput";
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

function BodySelect({ value, onChange, allowAuto, exclude, label = "Body" }: { value?: Id; onChange: (v: Id | undefined) => void; allowAuto: string; exclude?: Id; label?: string }) {
  const regen = useApp((s) => s.regen);
  const bodies = regen?.pickBodies ?? regen?.bodies ?? [];
  const meta = useApp((s) => s.doc.bodies);
  return (
    <div className="field">
      <span className="field__label">{label}</span>
      <select className="select" value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">{allowAuto}</option>
        {bodies
          .filter((b) => b.id !== exclude)
          .map((b) => (
            <option key={b.id} value={b.id}>
              {meta[b.id]?.name ?? "Body"}
            </option>
          ))}
      </select>
    </div>
  );
}

/** Sketches earlier in the timeline than `id`: later ones don't exist yet when it builds. */
function useSketchesBefore(id: Id): SketchFeature[] {
  const features = useApp((s) => s.doc.features);
  const i = features.findIndex((x) => x.id === id);
  return features.slice(0, i < 0 ? features.length : i).filter((x): x is SketchFeature => x.type === "sketch");
}

function OpField({ f }: { f: ExtrudeFeature | RevolveFeature | PrimitiveFeature | LoftFeature }) {
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
  const sketches = useSketchesBefore(f.id);
  return (
    <>
      <div className="field">
        <span className="field__label">Profile</span>
        <select className="select" value={f.sketch} onChange={(e) => upd(f, "Profile", (d) => void (d.sketch = e.target.value))}>
          {sketches.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
      <ExprInput label="Distance" kind="length" value={f.distance} autoFocus onChange={(v) => upd(f, "Distance", (d) => void (d.distance = v))} />
      <Segmented
        label="Direction"
        value={f.extent}
        options={[
          { value: "one", label: "One side" },
          { value: "symmetric", label: "Both sides" },
        ]}
        onChange={(v) => upd(f, "Direction", (d) => void (d.extent = v))}
      />
      {f.extent === "one" && <Toggle label="Flip direction" checked={f.flip} onChange={(v) => upd(f, "Flip", (d) => void (d.flip = v))} />}
      <OpField f={f} />
    </>
  );
}

function RevolveEditor({ f }: { f: RevolveFeature }) {
  return (
    <>
      <Segmented
        label="Axis"
        value={f.axis}
        options={[
          { value: "y", label: "Sketch vertical", title: "The sketch's vertical (Y) axis" },
          { value: "x", label: "Sketch horizontal", title: "The sketch's horizontal (X) axis" },
        ]}
        onChange={(v) => upd(f, "Axis", (d) => void (d.axis = v))}
      />
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
      <ExprInput label="Wall" kind="length" value={f.thickness} autoFocus min={0} hint="1.2 to 2 mm is typical for 3D printing" onChange={(v) => upd(f, "Thickness", (d) => void (d.thickness = v))} />
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
        <ExprInput label="Spacing" kind="length" value={f.spacing} onChange={(v) => upd(f, "Spacing", (d) => void (d.spacing = v))} />
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
      <ExprInput label="Diameter" kind="length" value={f.diameter} autoFocus min={0} hint="Clearance: M3 = 3.4, M4 = 4.5, M5 = 5.5 mm" onChange={(v) => upd(f, "Diameter", (d) => void (d.diameter = v))} />
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
      <div className="field">
        <span className="field__label">Add</span>
        <select className="select" value="" onChange={(e) => e.target.value && upd(f, "Add profile", (d) => void d.sketches.push(e.target.value))}>
          <option value="">Choose a sketch…</option>
          {sketches
            .filter((s) => !f.sketches.includes(s.id))
            .map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
        </select>
      </div>
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
              <label key={b.id} className="checkrow">
                <input
                  type="checkbox"
                  checked={f.tools.includes(b.id)}
                  onChange={(e) =>
                    upd(f, "Tools", (d) => {
                      d.tools = e.target.checked ? [...d.tools, b.id] : d.tools.filter((x) => x !== b.id);
                    })
                  }
                />
                <span className="tree__swatch" style={{ background: meta[b.id]?.color ?? "#ccc" }} />
                {meta[b.id]?.name ?? "Body"}
              </label>
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

export function FeatureEditor({ f }: { f: Feature }) {
  switch (f.type) {
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