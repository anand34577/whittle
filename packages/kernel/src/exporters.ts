import type { Id, WhittleDocument } from "@whittle/core";
import { strToU8, zipSync } from "fflate";
import { type Shape3D, exportSTEP, makeCompound } from "replicad";
import type { ExportFormat } from "./protocol";

export interface ExportedFile {
  data: Uint8Array;
  mime: string;
  ext: string;
}

async function blobBytes(b: Blob): Promise<Uint8Array> {
  return new Uint8Array(await b.arrayBuffer());
}

export async function exportShapes(
  doc: WhittleDocument,
  shapes: Map<Id, Shape3D>,
  format: ExportFormat,
  bodyIds?: Id[],
): Promise<ExportedFile> {
  const entries = [...shapes.entries()].filter(([id]) => (bodyIds ? bodyIds.includes(id) : doc.bodies[id]?.visible !== false));
  if (entries.length === 0) throw new Error(bodyIds ? "The selected body no longer exists." : "There are no visible bodies to export.");

  if (format === "step") {
    const blob = exportSTEP(
      entries.map(([id, shape]) => ({
        shape: shape.clone(),
        name: doc.bodies[id]?.name ?? id,
        color: doc.bodies[id]?.color,
      })),
      { unit: "mm" },
    );
    return { data: await blobBytes(blob), mime: "application/step", ext: "step" };
  }

  if (format === "stl") {
    const shape = entries.length === 1 ? entries[0]![1] : (makeCompound(entries.map(([, s]) => s.clone())) as Shape3D);
    const blob = shape.blobSTL({ binary: true, tolerance: 0.01, angularTolerance: 0.1 });
    return { data: await blobBytes(blob), mime: "model/stl", ext: "stl" };
  }

  return { data: build3MF(doc, entries), mime: "model/3mf", ext: "3mf" };
}

/**
 * Merge vertices shared between faces. The kernel meshes each face on its own,
 * so without this every face edge is an open seam and slicers report the 3MF
 * as non-manifold.
 */
export function weld(m: { vertices: number[]; triangles: number[] }): { vertices: number[]; triangles: number[] } {
  const key = new Map<string, number>();
  const remap: number[] = [];
  const vertices: number[] = [];
  for (let i = 0; i < m.vertices.length; i += 3) {
    // ponytail: 1 µm quantization; mesh vertices on a shared edge come from the same edge polyline, so they match exactly or near-exactly.
    const k = `${Math.round(m.vertices[i]! * 1e3)},${Math.round(m.vertices[i + 1]! * 1e3)},${Math.round(m.vertices[i + 2]! * 1e3)}`;
    let idx = key.get(k);
    if (idx === undefined) {
      idx = vertices.length / 3;
      key.set(k, idx);
      vertices.push(m.vertices[i]!, m.vertices[i + 1]!, m.vertices[i + 2]!);
    }
    remap.push(idx);
  }
  const triangles: number[] = [];
  for (let i = 0; i < m.triangles.length; i += 3) {
    const a = remap[m.triangles[i]!]!;
    const b = remap[m.triangles[i + 1]!]!;
    const c = remap[m.triangles[i + 2]!]!;
    if (a !== b && b !== c && a !== c) triangles.push(a, b, c);
  }
  return { vertices, triangles };
}

/** Minimal, valid 3MF (the format modern slicers prefer: units + one object per body). */
function build3MF(doc: WhittleDocument, entries: [Id, Shape3D][]): Uint8Array {
  const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);
  const objects: string[] = [];
  const items: string[] = [];
  const materials: string[] = [];
  entries.forEach(([id, shape], k) => {
    const m = weld(shape.mesh({ tolerance: 0.01, angularTolerance: 0.1 }));
    const color = (doc.bodies[id]?.color ?? "#cccccc").toUpperCase();
    materials.push(`<base name="${esc(doc.bodies[id]?.name ?? id)}" displaycolor="${color}FF" />`);
    const v: string[] = [];
    for (let i = 0; i < m.vertices.length; i += 3) {
      v.push(`<vertex x="${m.vertices[i]!.toFixed(5)}" y="${m.vertices[i + 1]!.toFixed(5)}" z="${m.vertices[i + 2]!.toFixed(5)}" />`);
    }
    const t: string[] = [];
    for (let i = 0; i < m.triangles.length; i += 3) {
      t.push(`<triangle v1="${m.triangles[i]}" v2="${m.triangles[i + 1]}" v3="${m.triangles[i + 2]}" />`);
    }
    const objId = k + 2;
    objects.push(
      `<object id="${objId}" name="${esc(doc.bodies[id]?.name ?? id)}" type="model" pid="1" pindex="${k}"><mesh><vertices>${v.join("")}</vertices><triangles>${t.join("")}</triangles></mesh></object>`,
    );
    items.push(`<item objectid="${objId}" />`);
  });
  const model =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">` +
    `<metadata name="Title">${esc(doc.name)}</metadata><metadata name="Application">Whittle</metadata>` +
    `<resources><basematerials id="1">${materials.join("")}</basematerials>${objects.join("")}</resources>` +
    `<build>${items.join("")}</build></model>`;
  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />` +
    `<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml" /></Types>`;
  const rels =
    `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" /></Relationships>`;
  return zipSync({
    "[Content_Types].xml": strToU8(contentTypes),
    "_rels/.rels": strToU8(rels),
    "3D/3dmodel.model": strToU8(model),
  });
}