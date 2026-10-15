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
export const APP_VERSION = "0.3.0";

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
    "document.json": strToU8(JSON.stringify(doc, null, 2)),
  };
  if (thumbnail) files["thumbnail.png"] = thumbnail;
  return zipSync(files, { level: 6 });
}

export class FileFormatError extends Error {}

export function deserializeDocument(bytes: Uint8Array): WhittleDocument {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    // Also accept a bare document.json (handy for tests and hand-editing).
    try {
      return migrate(JSON.parse(strFromU8(bytes)));
    } catch {
      throw new FileFormatError("This isn't a Whittle file (or it is damaged).");
    }
  }
  const raw = files["document.json"];
  if (!raw) throw new FileFormatError("The file is missing its document.json.");
  return migrate(JSON.parse(strFromU8(raw)));
}

type Migration = (doc: Record<string, unknown>) => Record<string, unknown>;

/** Forward migrations, indexed by the schema version they upgrade *from*. */
const MIGRATIONS: Record<number, Migration> = {};

export function migrate(input: unknown): WhittleDocument {
  if (!input || typeof input !== "object") throw new FileFormatError("The document is empty.");
  let doc = input as Record<string, unknown>;
  let schema = typeof doc.schema === "number" ? doc.schema : 1;
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
  const d = doc as unknown as WhittleDocument;
  d.schema = SCHEMA_VERSION;
  d.parameters ??= [];
  d.features ??= [];
  d.bodies ??= {};
  d.rollback ??= null;
  d.units ??= "mm";
  d.id ??= uid("d");
  return d;
}