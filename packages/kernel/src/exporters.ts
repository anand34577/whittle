import type { Id, WhittleDocument } from "@whittle/core";
import { strToU8, zipSync } from "fflate";
import { type Shape3D, exportSTEP, makeCompound } from "replicad";
import { buildDrawingSVG } from "./drawing";
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

  if (format === "drawing") {
    return { data: strToU8(buildDrawingSVG(entries.map(([, s]) => s), { title: doc.name })), mime: "image/svg+xml", ext: "svg" };
  }
  if (format === "obj") return { data: strToU8(buildOBJ(doc, entries)), mime: "model/obj", ext: "obj" };
  if (format === "ply") return { data: buildPLY(entries), mime: "application/x-ply", ext: "ply" };
  if (format === "glb") return { data: buildGLB(doc, entries), mime: "model/gltf-binary", ext: "glb" };
  return { data: build3MF(doc, entries), mime: "model/3mf", ext: "3mf" };
}

const MESH = { tolerance: 0.01, angularTolerance: 0.1 };

/** A colour as six hex digits without the `#` (accepts #rgb and #rrggbb; anything else is a neutral grey). */
export function hex6(color: string | undefined): string {
  const h = (color ?? "").trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(h)) return h.replace(/./g, (c) => c + c);
  return /^[0-9a-f]{6}$/i.test(h) ? h : "cccccc";
}

/** Wavefront OBJ: one named object per body, with a material per body color (inline .mtl names). */
function buildOBJ(doc: WhittleDocument, entries: [Id, Shape3D][]): string {
  const out = [`# ${doc.name}, exported from Whittle (units: millimetres)`];
  let base = 1;
  for (const [id, shape] of entries) {
    const m = weld(shape.mesh(MESH));
    out.push(`o ${(doc.bodies[id]?.name ?? id).replace(/\s+/g, "_")}`);
    for (let i = 0; i < m.vertices.length; i += 3) out.push(`v ${m.vertices[i]!.toFixed(5)} ${m.vertices[i + 1]!.toFixed(5)} ${m.vertices[i + 2]!.toFixed(5)}`);
    for (let i = 0; i < m.triangles.length; i += 3) out.push(`f ${m.triangles[i]! + base} ${m.triangles[i + 1]! + base} ${m.triangles[i + 2]! + base}`);
    base += m.vertices.length / 3;
  }
  return out.join("\n") + "\n";
}

/** Binary PLY mesh (scanning and mesh tools such as MeshLab and CloudCompare). */
function buildPLY(entries: [Id, Shape3D][]): Uint8Array {
  const parts = entries.map(([, shape]) => weld(shape.mesh(MESH)));
  const nv = parts.reduce((a, m) => a + m.vertices.length / 3, 0);
  const nf = parts.reduce((a, m) => a + m.triangles.length / 3, 0);
  const header = strToU8(
    `ply
format binary_little_endian 1.0
comment Whittle (millimetres)
element vertex ${nv}
property float x
property float y
property float z
element face ${nf}
property list uchar int vertex_indices
end_header
`,
  );
  const body = new DataView(new ArrayBuffer(nv * 12 + nf * 13));
  let o = 0;
  for (const m of parts) for (const v of m.vertices) (body.setFloat32(o, v, true), (o += 4));
  let base = 0;
  for (const m of parts) {
    for (let i = 0; i < m.triangles.length; i += 3) {
      body.setUint8(o, 3);
      body.setInt32(o + 1, m.triangles[i]! + base, true);
      body.setInt32(o + 5, m.triangles[i + 1]! + base, true);
      body.setInt32(o + 9, m.triangles[i + 2]! + base, true);
      o += 13;
    }
    base += m.vertices.length / 3;
  }
  const out = new Uint8Array(header.length + body.byteLength);
  out.set(header);
  out.set(new Uint8Array(body.buffer), header.length);
  return out;
}

/**
 * glTF 2.0 binary (.glb): the web, AR, game engines, Blender and renderers.
 * Metres (the glTF unit) and Y-up, one node per body with its color.
 */
function buildGLB(doc: WhittleDocument, entries: [Id, Shape3D][]): Uint8Array {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const bufferViews: object[] = [];
  const accessors: object[] = [];
  const meshes: object[] = [];
  const nodes: object[] = [];
  const materials: object[] = [];
  const push = (data: Uint8Array, target: number) => {
    const pad = (4 - (data.byteLength % 4)) % 4;
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.byteLength, target });
    chunks.push(data, new Uint8Array(pad));
    offset += data.byteLength + pad;
    return bufferViews.length - 1;
  };
  entries.forEach(([id, shape], k) => {
    const m = shape.mesh(MESH);
    // Z-up millimetres -> Y-up metres.
    const pos = new Float32Array(m.vertices.length);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < m.vertices.length; i += 3) {
      const v = [m.vertices[i]! / 1000, m.vertices[i + 2]! / 1000, -m.vertices[i + 1]! / 1000];
      for (let a = 0; a < 3; a++) {
        pos[i + a] = v[a]!;
        min[a] = Math.min(min[a]!, v[a]!);
        max[a] = Math.max(max[a]!, v[a]!);
      }
    }
    const nrm = new Float32Array(m.normals.length);
    for (let i = 0; i < m.normals.length; i += 3) {
      nrm[i] = m.normals[i]!;
      nrm[i + 1] = m.normals[i + 2]!;
      nrm[i + 2] = -m.normals[i + 1]!;
    }
    const idx = Uint32Array.from(m.triangles);
    const pv = push(new Uint8Array(pos.buffer), 34962);
    const nv = push(new Uint8Array(nrm.buffer), 34962);
    const iv = push(new Uint8Array(idx.buffer), 34963);
    const count = pos.length / 3;
    accessors.push({ bufferView: pv, componentType: 5126, count, type: "VEC3", min, max });
    accessors.push({ bufferView: nv, componentType: 5126, count, type: "VEC3" });
    accessors.push({ bufferView: iv, componentType: 5125, count: idx.length, type: "SCALAR" });
    const hex = hex6(doc.bodies[id]?.color);
    const lin = (c: number) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const rgb = [0, 2, 4].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) || 0));
    const look = doc.bodies[id]?.look;
    materials.push({
      name: doc.bodies[id]?.name ?? id,
      pbrMetallicRoughness: { baseColorFactor: [...rgb, look === "glass" ? 0.45 : 1], metallicFactor: look === "metal" ? 0.9 : 0.05, roughnessFactor: look === "metal" ? 0.3 : look === "satin" ? 0.35 : 0.6 },
      ...(look === "glass" ? { alphaMode: "BLEND" } : {}),
    });
    meshes.push({ name: doc.bodies[id]?.name ?? id, primitives: [{ attributes: { POSITION: k * 3, NORMAL: k * 3 + 1 }, indices: k * 3 + 2, material: k }] });
    nodes.push({ name: doc.bodies[id]?.name ?? id, mesh: k });
  });
  const bin = new Uint8Array(offset);
  let at = 0;
  for (const c of chunks) (bin.set(c, at), (at += c.byteLength));
  const json = {
    asset: { version: "2.0", generator: "Whittle" },
    scene: 0,
    scenes: [{ name: doc.name, nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: bin.byteLength }],
  };
  let jsonBytes = strToU8(JSON.stringify(json));
  const jpad = (4 - (jsonBytes.byteLength % 4)) % 4;
  if (jpad) jsonBytes = Uint8Array.from([...jsonBytes, ...new Array(jpad).fill(0x20)]);
  const total = 12 + 8 + jsonBytes.byteLength + 8 + bin.byteLength;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.byteLength, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  const b = 20 + jsonBytes.byteLength;
  dv.setUint32(b, bin.byteLength, true);
  dv.setUint32(b + 4, 0x004e4942, true);
  out.set(bin, b + 8);
  return out;
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
    const color = hex6(doc.bodies[id]?.color).toUpperCase();
    materials.push(`<base name="${esc(doc.bodies[id]?.name ?? id)}" displaycolor="#${color}FF" />`);
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