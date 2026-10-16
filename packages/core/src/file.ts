/**
 * The .whittle file format: a ZIP container (like 3MF / OPC) so it is
 * inspectable and robust.
 *
 *   manifest.json   format + app version, units, checksum of document.json
 *   document.json   the source of truth (parameters + feature timeline)
 *   thumbnail.png   optional preview
 */
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { SCHEMA_VERSION, type WhittleDocument } from "./model";
import { uid } from "./factory";

export const FILE_EXTENSION = ".whittle";
export const MIME_TYPE = "application/vnd.whittle+zip";
export const APP_VERSION = "0.7.0";

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
  const files: Record<string, Uint8Array> = {
    "manifest.json": strToU8(JSON.stringify(manifest, null, 2)),
    // The save time is stamped here, not on every edit, so an edit that changes nothing doesn't count as a change.
    "document.json": strToU8(JSON.stringify({ ...doc, modifiedAt: manifest.savedAt }, null, 2)),
  };
  if (thumbnail) files["thumbnail.png"] = thumbnail;
  return zipSync(files, { level: 6 });
}

export class FileFormatError extends Error {}

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

export function deserializeDocument(bytes: Uint8Array): WhittleDocument {
  let files: Record<string, Uint8Array>;
  try {
    // Only document.json is needed; skipping the rest (and refusing a huge one) keeps a hostile file cheap.
    files = unzipSync(bytes, { filter: (f) => f.name === "document.json" && f.originalSize <= MAX_DOCUMENT_BYTES });
  } catch {
    // Also accept a bare document.json (handy for tests and hand-editing).
    return parseDocumentJson(bytes);
  }
  const raw = files["document.json"];
  if (!raw) throw new FileFormatError("The file is missing its document.json (or it is too large).");
  return parseDocumentJson(raw);
}

type Migration = (doc: Record<string, unknown>) => Record<string, unknown>;

/** Forward migrations, indexed by the schema version they upgrade *from*. */
const MIGRATIONS: Record<number, Migration> = {
  // Format 2 adds optional constraint-driven sketch geometry. Nothing to convert; the
  // bump makes older apps refuse these files instead of silently dropping the geometry.
  1: (d) => d,
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
  const d = doc as unknown as WhittleDocument;
  d.schema = SCHEMA_VERSION;
  d.parameters ??= [];
  d.features ??= [];
  d.bodies ??= {};
  d.rollback ??= null;
  d.units ??= "mm";
  d.id ??= uid("d");
  if (typeof d.name !== "string" || !d.name.trim()) d.name = "Untitled";
  return d;
}