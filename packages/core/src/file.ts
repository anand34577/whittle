/**
 * The .whittle file format: a ZIP container (like 3MF / OPC) so it is
 * inspectable and robust.
 *
 *   manifest.json   format, schema and app version, units, save time (no checksum: damage shows up when document.json is read)
 *   document.json   the source of truth (parameters + feature timeline)
 *   thumbnail.png   optional preview
 *   imports/<id>.bin  an embedded STEP/STL/Whittle file as raw bytes (inside the document it is base64, 4/3 the size)
 */
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { SCHEMA_VERSION, type WhittleDocument } from "./model";
import { FEATURE_LABELS, uid } from "./factory";
import { version } from "../../../package.json";
import { PARAM_NAME } from "./params";

export const FILE_EXTENSION = ".whittle";
export const MIME_TYPE = "application/vnd.whittle+zip";
/** From the root package.json, so a release changes it in one place fewer (audit X-1). */
export const APP_VERSION: string = version;

interface Manifest {
  format: "whittle";
  schema: number;
  app: string;
  units: string;
  savedAt: string;
}

export function serializeDocument(doc: WhittleDocument, thumbnail?: Uint8Array): Uint8Array {
  const manifest: Manifest = {
    format: "whittle",
    schema: SCHEMA_VERSION,
    app: APP_VERSION,
    units: doc.units,
    savedAt: new Date().toISOString(),
  };
  const files: Record<string, Uint8Array> = {};
  const features = doc.features.map((f) => {
    if (f.type !== "import" || !f.data) return f;
    const bytes = base64ToBytes(f.data);
    if (!bytes) return f; // damaged: keep it as it is, so the error is still reported when it is used
    files[`imports/${f.id}.bin`] = bytes;
    return { ...f, data: "" };
  });
  files["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));
  // The save time is stamped here, not on every edit, so an edit that changes nothing doesn't count as a change.
  files["document.json"] = strToU8(JSON.stringify({ ...doc, features, modifiedAt: manifest.savedAt }, null, 2));
  if (thumbnail) files["thumbnail.png"] = thumbnail;
  return zipSync(files, { level: 6 });
}

export class FileFormatError extends Error {}

function base64ToBytes(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** The largest document.json read from a file: a guard against decompression bombs. */
const MAX_DOCUMENT_BYTES = 256 * 1024 * 1024;

function parseDocumentJson(bytes: Uint8Array): WhittleDocument {
  let json: unknown;
  try {
    json = JSON.parse(strFromU8(bytes));
  } catch {
    throw new FileFormatError("This isn't a Whittle file (or it is damaged).");
  }
  return migrate(json);
}

/** All embedded files of one design together, unpacked (audit C-10: each entry was capped, the total wasn't). */
const MAX_IMPORTS_BYTES = 1024 * 1024 * 1024;

export function deserializeDocument(bytes: Uint8Array): WhittleDocument {
  let files: Record<string, Uint8Array>;
  try {
    // Only document.json first; skipping the rest (and refusing a huge one) keeps a hostile file cheap.
    files = unzipSync(bytes, { filter: (f) => f.name === "document.json" && f.originalSize <= MAX_DOCUMENT_BYTES });
  } catch {
    // Also accept a bare document.json (handy for tests and hand-editing).
    return parseDocumentJson(bytes);
  }
  const raw = files["document.json"];
  if (!raw) throw new FileFormatError("The file is missing its document.json (or it is too large).");
  const doc = parseDocumentJson(raw);
  // Then only the embedded files the document actually uses, up to a total size.
  const wanted = new Set(doc.features.filter((f) => f.type === "import" && !f.data).map((f) => `imports/${f.id}.bin`));
  let total = 0;
  if (wanted.size) {
    files = unzipSync(bytes, {
      filter: (f) => {
        if (!wanted.has(f.name) || f.originalSize > MAX_DOCUMENT_BYTES || total + f.originalSize > MAX_IMPORTS_BYTES) return false;
        total += f.originalSize;
        return true;
      },
    });
  }
  for (const f of doc.features) {
    const bin = f.type === "import" && !f.data ? files[`imports/${f.id}.bin`] : undefined;
    if (f.type === "import" && bin) f.data = bytesToBase64(bin);
  }
  return doc;
}

type Migration = (doc: Record<string, unknown>) => Record<string, unknown>;

/** Forward migrations, indexed by the schema version they upgrade *from*. */
const MIGRATIONS: Record<number, Migration> = {
  // Format 2 adds optional constraint-driven sketch geometry. Nothing to convert; the
  // bump makes older apps refuse these files instead of silently dropping the geometry.
  1: (d) => d,
  // Format 3 keeps embedded files as raw entries in the container; the document in memory is unchanged.
  2: (d) => d,
  // Format 4: Mirror and Surface Trim on the XZ plane use the same normal as sketches and Split (-Y), so an
  // offset of d is at y = -d in every tool. Older files meant +Y: flip their offset (and Trim's side) to keep the shape.
  3: (d) => {
    if (!Array.isArray(d.features)) return d;
    const neg = (e: unknown) => (typeof e === "string" && e.trim() && !/^0+(\.0*)?\s*[a-z]*$/i.test(e.trim()) ? `-(${e})` : typeof e === "number" ? -e : e);
    for (const f of d.features as Record<string, unknown>[]) {
      if (!f || typeof f !== "object" || f.plane !== "XZ" || f.planeRef) continue;
      if (f.type === "mirror") f.offset = neg(f.offset);
      else if (f.type === "surface" && f.op === "trim") {
        f.offset = neg(f.offset);
        f.keep = f.keep === "above" ? "below" : "above";
      }
    }
    return d;
  },
};

export function migrate(input: unknown): WhittleDocument {
  if (!input || typeof input !== "object") throw new FileFormatError("The document is empty.");
  let doc = input as Record<string, unknown>;
  let schema = typeof doc.schema === "number" && Number.isFinite(doc.schema) ? Math.floor(doc.schema) : 1;
  if (schema > SCHEMA_VERSION) {
    throw new FileFormatError(
      `This file was made with a newer version of Whittle (format ${schema}). Please update the app.`,
    );
  }
  while (schema < SCHEMA_VERSION) {
    const m = MIGRATIONS[schema];
    if (!m) throw new FileFormatError(`No upgrade path from format ${schema}.`);
    doc = m(doc);
    schema++;
  }
  if (doc.features !== undefined && !Array.isArray(doc.features)) throw new FileFormatError("The document's feature list is damaged.");
  if (doc.parameters !== undefined && !Array.isArray(doc.parameters)) throw new FileFormatError("The document's parameter list is damaged.");
  if (doc.bodies !== undefined && (doc.bodies === null || typeof doc.bodies !== "object" || Array.isArray(doc.bodies))) {
    throw new FileFormatError("The document's body list is damaged.");
  }
  // The lists may exist but hold junk (null, numbers, half-written entries): the app would fail to draw them.
  const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (Array.isArray(doc.features) && !doc.features.every((f) => isRecord(f) && typeof f.id === "string" && typeof f.type === "string")) {
    throw new FileFormatError("The document's feature list is damaged.");
  }
  if (Array.isArray(doc.parameters) && !doc.parameters.every((p) => isRecord(p) && typeof p.name === "string" && (typeof p.expr === "string" || typeof p.expr === "number"))) {
    throw new FileFormatError("The document's parameter list is damaged.");
  }
  // One level deeper (audit C-10): what the app would otherwise trip over later, with a less helpful message.
  const features = (doc.features ?? []) as Record<string, unknown>[];
  const unknown = features.find((f) => !Object.prototype.hasOwnProperty.call(FEATURE_LABELS, f.type as string));
  if (unknown) throw new FileFormatError(`This file has a step of a kind this version doesn't know ("${String(unknown.type)}"). It may have been made with a newer version of Whittle.`);
  const ids = new Set<string>();
  for (const f of features) {
    if (ids.has(f.id as string)) throw new FileFormatError("The document's feature list is damaged (two steps share an id).");
    ids.add(f.id as string);
    if (f.type === "sketch") {
      if (!Array.isArray(f.entities)) f.entities = [];
      f.entities = (f.entities as unknown[]).filter(isRecord);
      for (const e of f.entities as Record<string, unknown>[]) if (e.type === "text" && typeof e.text !== "string") e.text = "";
      if (f.geometry !== undefined && !Array.isArray(f.geometry)) delete f.geometry;
      if (f.constraints !== undefined && !Array.isArray(f.constraints)) delete f.constraints;
    }
  }
  for (const key of ["variants", "folders", "views"]) if (doc[key] !== undefined && !Array.isArray(doc[key])) delete doc[key];
  if (Array.isArray(doc.parameters)) {
    const bad = (doc.parameters as Record<string, unknown>[]).find((p) => !PARAM_NAME.test(p.name as string));
    if (bad) throw new FileFormatError(`The parameter name "${String(bad.name)}" isn't valid (letters, digits and _; not starting with a digit).`);
  }
  if (doc.id !== undefined && typeof doc.id !== "string") delete doc.id;
  const d = doc as unknown as WhittleDocument;
  d.schema = SCHEMA_VERSION;
  d.parameters ??= [];
  d.features ??= [];
  d.bodies ??= {};
  // A hand-edited or damaged file: an unknown unit would turn every length into NaN, a bad marker would hide every step.
  if (!(typeof d.rollback === "number" && Number.isInteger(d.rollback) && d.rollback >= 0)) d.rollback = null;
  if (!["mm", "cm", "m", "in", "ft"].includes(d.units)) d.units = "mm";
  const kinds = ["length", "angle", "number", "count"];
  for (const p of d.parameters) {
    if (typeof p.id !== "string" || !p.id) p.id = uid("p");
    if (!kinds.includes(p.kind)) p.kind = "length";
    if (typeof p.expr === "number") p.expr = String(p.expr);
  }
  d.id ??= uid("d");
  if (typeof d.name !== "string" || !d.name.trim()) d.name = "Untitled";
  return d;
}