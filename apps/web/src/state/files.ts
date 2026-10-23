/**
 * Files: open / save (.whittle), export (STEP, STL, 3MF, images), version
 * history and autosave, on every platform:
 *
 *   desktop  native dialogs, files on disk; every save keeps the previous copy
 *   server   designs live on the server; every save is a new version
 *   browser  File System Access API where available, downloads elsewhere;
 *            every save also keeps a copy in the browser (IndexedDB)
 */
import {
  FILE_EXTENSION,
  type LengthUnit,
  type WhittleDocument,
  deserializeDocument,
  migrate,
  newDocument,
  serializeDocument,
  uid,
  mergeParameterCsv,
} from "@whittle/core";
import type { ExportFormat } from "@whittle/kernel";
import { importFile } from "./actions";
import { placeImage } from "./refImage";
import { startTask, withTask } from "./tasks";
import { deleteStored, listStored, readStored, writeStored } from "./stored";
import { getKernel } from "./kernel";
import { addLocalVersion, listLocalVersions } from "./localHistory";
import { ApiError, api, apiJson, ask, invoke, tauri } from "./platform";
import { commitSession, mutate, replaceDocument, toast, useApp } from "./store";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FileHandle = any;

/** Where the open design lives. */
export type DocLocation =
  | { kind: "none" }
  | { kind: "handle"; handle: FileHandle }
  | { kind: "path"; path: string }
  | { kind: "server"; id: string; version: number };

let location: DocLocation = { kind: "none" };

export function currentLocation(): DocLocation {
  return location;
}

/** Thumbnail provider registered by the viewport. */
export const thumbnailHook: { get: ((size?: number) => string) | null; image: ((scale: number) => string) | null } = { get: null, image: null };

const w = (typeof window === "undefined" ? {} : window) as {
  showOpenFilePicker?: (o: unknown) => Promise<FileHandle[]>;
  showSaveFilePicker?: (o: unknown) => Promise<FileHandle>;
};

const PICKER_TYPES = [{ description: "Whittle design", accept: { "application/vnd.whittle+zip": [FILE_EXTENSION] } }];
const DESIGN_FILTER = [{ name: "Whittle design", extensions: ["whittle"] }];

const platform = () => useApp.getState().platform.kind;
const errText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);
const isAbort = (e: unknown) => (e as Error)?.name === "AbortError";

/* ───────────────────────────── Bytes in and out ───────────────────────────── */

function dataUrlToBytes(url: string): Uint8Array | undefined {
  const b64 = url.split(",")[1];
  if (!b64) return undefined;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function download(bytes: Uint8Array, name: string, mime: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Save the design's parameters as a CSV file (name, formula, kind, value, note). */
export function exportParametersCsv(rows: string[][], designName: string) {
  const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const csv = [["Name", "Formula", "Kind", "Value", "Note"], ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
  download(new TextEncoder().encode(csv), `${safeName(designName)}-parameters.csv`, "text/csv");
}

/** Read a parameter table and merge it in: existing names get the new value, new names are added. */
export async function importParametersCsv() {
  let file: File;
  try {
    file = await pickFileFallback(".csv,text/csv,text/plain");
  } catch {
    return;
  }
  const text = await file.text();
  let result: ReturnType<typeof mergeParameterCsv> | null = null;
  mutate(`Import parameters from ${file.name}`, (d) => void (result = mergeParameterCsv(d.parameters, text, () => uid("p"))));
  const r = result as ReturnType<typeof mergeParameterCsv> | null;
  if (!r || r.updated.length + r.added.length === 0) return toast("warn", "No parameters found. The file needs a Name column and a Formula or Value column.");
  const parts = [r.updated.length && `${r.updated.length} updated`, r.added.length && `${r.added.length} added`, r.skipped.length && `skipped ${r.skipped.join(", ")}`].filter(Boolean);
  toast(r.skipped.length ? "warn" : "info", `Parameters: ${parts.join(", ")}.`);
}

export function safeName(name: string) {
  // No characters a file system refuses, no dots or spaces at the ends (Windows drops them), a sane length,
  // and not one of the device names Windows reserves (CON, NUL, COM1...).
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
    .replace(/^[\s.]+|[\s.]+$/g, "")
    .slice(0, 120)
    .trim();
  if (!cleaned) return "design";
  return /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(cleaned) ? `${cleaned} design` : cleaned;
}

async function desktopWrite(path: string, bytes: Uint8Array) {
  await invoke("write_file", bytes, { headers: { "x-path": encodeURIComponent(path) } });
}

async function desktopRead(path: string): Promise<Uint8Array> {
  return new Uint8Array(await invoke<ArrayBuffer>("read_file", { path }));
}

/**
 * Hand a file to the user: a native Save dialog on the desktop, a download in the browser.
 * Returns false when the user cancelled.
 */
export async function saveBytes(bytes: Uint8Array, name: string, mime: string, filter: { name: string; extensions: string[] }): Promise<boolean> {
  if (tauri()) {
    const path = await invoke<string | null>("save_dialog", { name, filters: [filter] });
    if (!path) return false;
    await desktopWrite(path, bytes);
    return true;
  }
  download(bytes, name, mime);
  return true;
}

function pickFileFallback(accept: string): Promise<File> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => (input.files?.[0] ? resolve(input.files[0]) : reject(new DOMException("", "AbortError")));
    input.oncancel = () => reject(new DOMException("", "AbortError"));
    input.click();
  });
}

function thumbnail(): Uint8Array | undefined {
  try {
    return thumbnailHook.get ? dataUrlToBytes(thumbnailHook.get()) : undefined;
  } catch {
    return undefined; // a thumbnail is optional
  }
}

/* ───────────────────────────── New / open ───────────────────────────── */

async function confirmDiscard(): Promise<boolean> {
  if (!useApp.getState().dirty) return true;
  return ask({ title: "Discard unsaved changes?", message: "Your changes to this design haven't been saved. They'll be lost if you continue.", confirmLabel: "Discard changes", danger: true });
}

function show(doc: WhittleDocument, fileName: string | null, loc: DocLocation) {
  location = loc;
  replaceDocument(doc, fileName);
  useApp.setState({ panel: null, viewRequest: { kind: "home", at: Date.now() } });
}

export async function newDesign(units: LengthUnit = useApp.getState().prefs.units, name = "Untitled") {
  if (!(await confirmDiscard())) return false;
  show(newDocument(name, units), null, { kind: "none" });
  return true;
}

/** Load a document that has no file yet (template, recovered work, a copy). */
export function loadDocument(doc: WhittleDocument, fileName: string | null) {
  show(doc, fileName, { kind: "none" });
}

/** Load a template or recovered work, asking first if the current design has unsaved changes. */
export async function loadDocumentConfirm(doc: WhittleDocument, fileName: string | null, unsaved = false) {
  if (!(await confirmDiscard())) return;
  loadDocument(doc, fileName);
  if (unsaved) useApp.setState({ dirty: true }); // recovered work has not been saved to a file
}

/** Open: on the server this shows your designs; elsewhere it picks a file. */
export async function openDesign() {
  if (platform() === "server") {
    useApp.setState({ panel: "welcome" });
    return;
  }
  await openFromComputer();
}

/** Open a .whittle file from this computer (on the server it becomes a new, unsaved design). */
export async function openFromComputer() {
  if (!(await confirmDiscard())) return;
  try {
    if (tauri()) {
      const path = await invoke<string | null>("open_dialog", { filters: DESIGN_FILTER });
      if (path) await openPath(path, false);
      return;
    }
    let file: File;
    let h: FileHandle | null = null;
    if (w.showOpenFilePicker && platform() !== "server") {
      [h] = await w.showOpenFilePicker({ types: PICKER_TYPES, multiple: false });
      file = await h.getFile();
    } else {
      file = await pickFileFallback(FILE_EXTENSION + ",.json");
    }
    const doc = await withTask("Opening the file…", async () => deserializeDocument(new Uint8Array(await file.arrayBuffer())));
    show(doc, file.name, h ? { kind: "handle", handle: h } : { kind: "none" });
    toast("ok", `Opened ${file.name}`);
  } catch (e) {
    if (!isAbort(e)) toast("error", errText(e, "Couldn't open that file."));
  }
}

/** Desktop: open a design by path (recent files, double-click in the OS). */
export async function openPath(path: string, confirm = true) {
  if (confirm && !(await confirmDiscard())) return;
  try {
    const doc = deserializeDocument(await desktopRead(path));
    const name = path.split(/[\\/]/).pop() ?? path;
    show(doc, name, { kind: "path", path });
    toast("ok", `Opened ${name}`);
  } catch (e) {
    toast("error", errText(e, "Couldn't open that file."));
  }
}

/** Server: open one of your designs. */
export async function openServerDesign(id: string) {
  if (!(await confirmDiscard())) return;
  try {
    const { res, doc } = await withTask("Opening the design…", async () => {
      const res = await api(`/designs/${encodeURIComponent(id)}`);
      return { res, doc: deserializeDocument(new Uint8Array(await res.arrayBuffer())) };
    });
    const version = Number(res.headers.get("x-whittle-version") ?? "1");
    show(doc, doc.name, { kind: "server", id, version });
  } catch (e) {
    toast("error", errText(e, "Couldn't open that design."));
  }
}

/**
 * A design the system handed to the installed app (double-clicking a .whittle file, once the app has been
 * installed and registered for that type). The file's handle also lets Save write back to it.
 */
export async function openLaunchedFile(handle: FileHandle) {
  if (!(await confirmDiscard())) return;
  try {
    const file: File = await handle.getFile();
    const doc = await withTask("Opening the file…", async () => deserializeDocument(new Uint8Array(await file.arrayBuffer())));
    show(doc, file.name, { kind: "handle", handle });
    toast("ok", `Opened ${file.name}`);
  } catch (e) {
    toast("error", errText(e, "Couldn't open that file."));
  }
}

/** Start listening for files the operating system opens with this app. */
export function startLaunchQueue() {
  const queue = (window as unknown as { launchQueue?: { setConsumer(fn: (p: { files?: FileHandle[] }) => void): void } }).launchQueue;
  queue?.setConsumer((p) => {
    const handle = p.files?.[0];
    if (handle) void openLaunchedFile(handle);
  });
}

/** Open a file dropped onto the window. */
export async function openDroppedFile(file: File) {
  if (file.type.startsWith("image/")) return placeImage(file, file.name);
  if (/\.(step|stp|stl)$/i.test(file.name)) {
    useApp.setState({ panel: null });
    await importFile(file);
    return;
  }
  const lower = file.name.toLowerCase();
  if (!lower.endsWith(FILE_EXTENSION) && !lower.endsWith(".json")) {
    toast("warn", "Drop a Whittle design, a STEP or STL file to import it, or a picture to trace over.");
    return;
  }
  if (!(await confirmDiscard())) return;
  try {
    show(deserializeDocument(new Uint8Array(await file.arrayBuffer())), file.name, { kind: "none" });
    toast("ok", `Opened ${file.name}`);
  } catch (e) {
    toast("error", errText(e, "Couldn't open that file."));
  }
}

/* ───────────────────────────── Save ───────────────────────────── */

let saving = false;

export async function saveDesign(saveAs = false): Promise<boolean> {
  if (saving) return false;
  commitSession();
  saving = true;
  const task = startTask("Saving…");
  try {
    const { doc } = useApp.getState();
    const bytes = serializeDocument(doc, thumbnail());
    const suggested = safeName(doc.name) + FILE_EXTENSION;
    let label: string;
    const kind = platform();
    if (kind === "server") {
      label = await saveToServer(bytes, saveAs);
    } else if (kind === "desktop") {
      let path = location.kind === "path" && !saveAs ? location.path : null;
      path ??= await invoke<string | null>("save_dialog", { name: suggested, filters: DESIGN_FILTER });
      if (!path) return false;
      await desktopWrite(path, bytes);
      location = { kind: "path", path };
      label = path.split(/[\\/]/).pop() ?? suggested;
    } else {
      if (w.showSaveFilePicker) {
        let h = location.kind === "handle" && !saveAs ? location.handle : null;
        const write = async (handle: FileHandle) => {
          const writable = await handle.createWritable();
          await writable.write(bytes);
          await writable.close();
        };
        try {
          h ??= await w.showSaveFilePicker({ suggestedName: suggested, types: PICKER_TYPES });
          await write(h);
        } catch (e) {
          // The file was moved or deleted, or permission to it was taken back: ask where to save instead of failing every time.
          if (isAbort(e) || location.kind !== "handle" || saveAs) throw e;
          h = await w.showSaveFilePicker({ suggestedName: suggested, types: PICKER_TYPES });
          await write(h);
        }
        location = { kind: "handle", handle: h };
        label = h.name;
      } else {
        download(bytes, suggested, "application/vnd.whittle+zip");
        label = suggested;
      }
      // The browser has no file history of its own: keep a copy of every save.
      if (doc.id) void addLocalVersion({ docId: doc.id, name: doc.name, at: Date.now(), bytes }).catch(() => {});
    }
    // Edits made while the save was in flight stay unsaved.
    if (useApp.getState().doc === doc) {
      useApp.setState({ dirty: false });
      clearAutosave(); // the saved file is now the safe copy
    }
    useApp.setState({ fileName: label });
    toast("ok", "Saved");
    return true;
  } catch (e) {
    if (!isAbort(e)) toast("error", "Couldn't save: " + errText(e, String(e)));
    return false;
  } finally {
    saving = false;
    task.done();
  }
}

async function saveToServer(bytes: Uint8Array, saveAs: boolean): Promise<string> {
  const body = bytes as BlobPart;
  if (location.kind === "server" && !saveAs) {
    const path = `/designs/${encodeURIComponent(location.id)}`;
    try {
      const r = await apiJson<{ id: string; version: number; name: string }>(path, { method: "PUT", body, headers: { "If-Match": String(location.version) } });
      location = { ...location, version: r.version };
      return r.name;
    } catch (e) {
      // Deleted elsewhere (another tab or device): save it as a new design rather than losing the work.
      if (e instanceof ApiError && e.status === 404) {
        const r = await apiJson<{ id: string; version: number; name: string }>("/designs", { method: "POST", body });
        location = { kind: "server", id: r.id, version: r.version };
        return r.name;
      }
      if (!(e instanceof ApiError) || e.status !== 409) throw e;
      if (!(await ask({ title: "There's a newer version", message: `${e.message} Save your changes as the newest version anyway? The other version stays in the history.`, confirmLabel: "Save anyway" }))) {
        throw new DOMException("", "AbortError");
      }
      const r = await apiJson<{ id: string; version: number; name: string }>(path, { method: "PUT", body });
      location = { ...location, version: r.version };
      return r.name;
    }
  }
  const r = await apiJson<{ id: string; version: number; name: string }>("/designs", { method: "POST", body });
  location = { kind: "server", id: r.id, version: r.version };
  return r.name;
}

/** A copy of the design as a .whittle file on this computer. */
export async function downloadCopy() {
  commitSession();
  const { doc } = useApp.getState();
  try {
    if (await saveBytes(serializeDocument(doc, thumbnail()), safeName(doc.name) + FILE_EXTENSION, "application/vnd.whittle+zip", DESIGN_FILTER[0]!)) {
      toast("ok", "Copy saved");
    }
  } catch (e) {
    toast("error", errText(e, "Couldn't save the copy."));
  }
}

/* ───────────────────────────── Export ───────────────────────────── */

const EXPORT_FILTERS: Record<string, { name: string; extensions: string[] }> = {
  step: { name: "STEP", extensions: ["step", "stp"] },
  stl: { name: "STL mesh", extensions: ["stl"] },
  "3mf": { name: "3MF", extensions: ["3mf"] },
  obj: { name: "Wavefront OBJ", extensions: ["obj"] },
  glb: { name: "glTF binary", extensions: ["glb"] },
  ply: { name: "PLY mesh", extensions: ["ply"] },
  png:{ name: "PNG image", extensions: ["png"] },
  svg: { name: "SVG drawing", extensions: ["svg"] },
  dxf: { name: "DXF drawing", extensions: ["dxf"] },
};

export async function exportDesign(format: ExportFormat, bodyId?: string) {
  commitSession();
  const { doc, prefs } = useApp.getState();
  try {
    const file = await withTask(`Exporting ${format.toUpperCase()}…`, () => getKernel().export(doc, format, bodyId ? [bodyId] : undefined, prefs.meshQuality, format === "drawing" ? prefs.drawing : undefined));
    const name = bodyId ? `${safeName(doc.name)} - ${safeName(doc.bodies[bodyId]?.name ?? "body")}` : safeName(doc.name);
    if (await saveBytes(file.data, `${name}.${file.ext}`, file.mime, EXPORT_FILTERS[file.ext]!)) toast("ok", `Exported ${format.toUpperCase()}`);
  } catch (e) {
    toast("error", errText(e, "Export failed."));
  }
}

/**
 * Send to slicer: a 3MF (units, colors, every body) straight into the slicer chosen in Settings, or whatever
 * opens .3mf files. A browser can't start other programs, so there it downloads the file to open.
 */
export async function sendToSlicer() {
  commitSession();
  const { doc, prefs } = useApp.getState();
  if (!useApp.getState().regen?.bodies.length) return toast("info", "There's nothing to print yet: make a body first.");
  try {
    const file = await withTask("Preparing for the slicer…", () => getKernel().export(doc, "3mf", undefined, prefs.meshQuality === "draft" ? "standard" : prefs.meshQuality));
    if (tauri()) {
      await invoke("open_in_slicer", file.data, { headers: { "x-name": encodeURIComponent(safeName(doc.name)), "x-slicer": encodeURIComponent(prefs.slicer ?? "") } });
      toast("ok", `Opened in ${prefs.slicer || "your slicer"}`);
    } else {
      download(file.data, `${safeName(doc.name)}.3mf`, file.mime);
      toast("info", "Downloaded as 3MF: open it in your slicer (PrusaSlicer, Bambu Studio, OrcaSlicer, Cura). The desktop app opens it there for you.");
    }
  } catch (e) {
    toast("error", errText(e, "Couldn't send it to the slicer."));
  }
}

/** Save text (SVG / DXF drawings). */
export async function exportText(text: string, name: string, ext: "svg" | "dxf") {
  try {
    const mime = ext === "svg" ? "image/svg+xml" : "application/dxf";
    if (await saveBytes(new TextEncoder().encode(text), `${safeName(name)}.${ext}`, mime, EXPORT_FILTERS[ext]!)) toast("ok", `Exported ${ext.toUpperCase()}`);
  } catch (e) {
    toast("error", errText(e, "Export failed."));
  }
}

/** Save a high-resolution PNG of the current view. */
export async function saveScreenshot() {
  if (!thumbnailHook.image) return;
  try {
    const bytes = dataUrlToBytes(thumbnailHook.image(2));
    if (!bytes) throw new Error("Couldn't capture the view.");
    if (await saveBytes(bytes, `${safeName(useApp.getState().doc.name)}.png`, "image/png", EXPORT_FILTERS.png!)) toast("ok", "Image saved");
  } catch (e) {
    toast("error", errText(e, "Couldn't save the image."));
  }
}

/* ───────────────────────────── Version history ───────────────────────────── */

export interface VersionItem {
  id: string;
  at: number;
  size: number;
  author?: string | null;
  /** The version that is in the file / on the server right now. */
  current: boolean;
}

/** Earlier versions of the open design (newest first), or null if it has no history yet. */
export async function listVersions(): Promise<VersionItem[] | null> {
  const doc = useApp.getState().doc;
  if (location.kind === "server") {
    const list = await apiJson<{ version: number; size: number; createdAt: number; author: string | null }[]>(
      `/designs/${encodeURIComponent(location.id)}/versions`,
    );
    const head = location.version;
    return list.map((v) => ({ id: String(v.version), at: v.createdAt, size: v.size, author: v.author, current: v.version === head }));
  }
  if (location.kind === "path") {
    const list = await invoke<{ id: string; savedAt: number; size: number }[]>("list_history", { path: location.path });
    return list.map((v) => ({ id: v.id, at: v.savedAt, size: v.size, current: false }));
  }
  if (platform() === "browser" && doc.id) {
    const list = await listLocalVersions(doc.id);
    return list.map((v, i) => ({ id: String(v.key), at: v.at, size: v.bytes.byteLength, current: i === 0 && !useApp.getState().dirty }));
  }
  return null;
}

async function versionBytes(item: VersionItem): Promise<Uint8Array> {
  if (location.kind === "server") {
    const res = await api(`/designs/${encodeURIComponent(location.id)}/versions/${item.id}`);
    return new Uint8Array(await res.arrayBuffer());
  }
  if (location.kind === "path") return new Uint8Array(await invoke<ArrayBuffer>("read_history", { path: location.path, id: item.id }));
  const v = (await listLocalVersions(useApp.getState().doc.id ?? "")).find((x) => String(x.key) === item.id);
  if (!v) throw new Error("That version is no longer stored in this browser.");
  return v.bytes;
}

/** Make an old version the current one (the version it replaces stays in the history). */
export async function restoreVersion(item: VersionItem) {
  if (!(await confirmDiscard())) return;
  const task = startTask("Restoring the version…");
  try {
    if (location.kind === "server") {
      const loc = location;
      const r = await apiJson<{ version: number }>(`/designs/${encodeURIComponent(loc.id)}/versions/${item.id}/restore`, { method: "POST" });
      location = { ...loc, version: r.version };
      await reopenServer(loc.id);
      toast("ok", `Restored. It's now version ${r.version}.`);
      return;
    }
    const doc = deserializeDocument(await versionBytes(item));
    const loc = location;
    replaceDocument(doc, useApp.getState().fileName);
    location = loc;
    useApp.setState({ panel: null, dirty: true });
    if (loc.kind === "path" || loc.kind === "handle") await saveDesign();
    else toast("info", "Version loaded. Save to keep it.");
  } catch (e) {
    toast("error", errText(e, "Couldn't restore that version."));
  } finally {
    task.done();
  }
}

async function reopenServer(id: string) {
  const res = await api(`/designs/${encodeURIComponent(id)}`);
  const version = Number(res.headers.get("x-whittle-version") ?? "1");
  show(deserializeDocument(new Uint8Array(await res.arrayBuffer())), null, { kind: "server", id, version });
}

/** Open an old version as a separate, unsaved copy. */
export async function openVersionAsCopy(item: VersionItem) {
  if (!(await confirmDiscard())) return;
  try {
    const doc = deserializeDocument(await versionBytes(item));
    doc.id = uid("d");
    doc.name = `${doc.name} (${new Date(item.at).toLocaleString()})`;
    loadDocument(doc, null);
    useApp.setState({ dirty: true });
  } catch (e) {
    toast("error", errText(e, "Couldn't open that version."));
  }
}

/* ───────────────────────────── Autosave ───────────────────────────── */

/** One recovery copy per design (so two tabs or two designs don't overwrite each other). */
const draftKey = (docId?: string) => `draft:${docId ?? "design"}`;
const WEEK_MS = 7 * 24 * 3600 * 1000;

interface Draft {
  doc: WhittleDocument;
  fileName: string | null;
  at: string;
}

/** The most recent recovery copy of any design. */
export async function readAutosave(): Promise<Draft | null> {
  try {
    const newest = (await listStored("draft:"))[0];
    if (!newest) return null;
    const data = await readStored<Draft>(newest.key);
    return data ? { doc: migrate(data.doc), fileName: data.fileName ?? null, at: data.at } : null;
  } catch {
    return null;
  }
}

function clearAutosave() {
  void deleteStored(draftKey(useApp.getState().doc.id));
}

export function startAutosave() {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last = useApp.getState().doc;
  let warned = false;
  // Recovery copies written in this session (so emptying a design removes its copy once, not on every change).
  const drafted = new Set<string>();
  useApp.subscribe((s) => {
    if (s.doc === last) return;
    last = s.doc;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const { doc, fileName, session } = useApp.getState();
      const toSave = session ? session.base : doc;
      // An empty design needs no recovery copy, and an older one of it must not come back.
      if (toSave.features.length === 0) {
        if (drafted.delete(draftKey(toSave.id))) void deleteStored(draftKey(toSave.id)).catch(() => {});
        return;
      }
      drafted.add(draftKey(toSave.id));
      writeStored(draftKey(toSave.id), { doc: toSave, fileName, at: new Date().toISOString() })
        .then(async () => {
          // Copies of other designs go after a week, so they don't pile up.
          for (const e of await listStored("draft:")) {
            if (e.key !== draftKey(toSave.id) && e.updatedAt && Date.now() - e.updatedAt > WEEK_MS) void deleteStored(e.key);
          }
        })
        .catch(() => {
          if (!warned) {
            warned = true;
            toast("warn", "This design is too large for crash recovery. Save it regularly.");
          }
        });
    }, 800);
  });
  window.addEventListener("beforeunload", (e) => {
    if (useApp.getState().dirty) e.preventDefault();
  });
}

/* ───────────────────────────── Desktop integration ───────────────────────────── */

/** Desktop: open files passed by the OS (double-click, "Open with"), now and later. */
export async function startDesktop() {
  const t = tauri();
  if (!t) return;
  const openAll = async () => {
    const files = await invoke<string[]>("startup_files").catch(() => []);
    if (files[0]) await openPath(files[0]);
  };
  await t.event.listen<string>("whittle://open", () => void openAll());
  await openAll();
  // Ask before closing a window with unsaved work.
  const win = (window as unknown as { __TAURI__?: { window?: { getCurrentWindow(): { onCloseRequested(cb: (e: { preventDefault(): void }) => unknown): Promise<unknown> } } } }).__TAURI__?.window;
  await win?.getCurrentWindow().onCloseRequested(async (e) => {
    if (useApp.getState().dirty && !(await ask({ title: "Close without saving?", message: "You have unsaved changes. Close Whittle anyway?", confirmLabel: "Close without saving", danger: true }))) e.preventDefault();
  });
}

export interface RecentFile {
  path: string;
  name: string;
  openedAt: number;
  exists: boolean;
}

export async function recentFiles(): Promise<RecentFile[]> {
  return tauri() ? invoke<RecentFile[]>("recent_files").catch(() => []) : [];
}

export async function forgetRecent(path: string) {
  await invoke("forget_recent", { path }).catch(() => {});
}
