# Architecture

```
┌──────────────────────── Browser / Tauri webview ────────────────────────┐
│                                                                          │
│  UI thread (apps/web)                       Kernel worker (packages/kernel)
│  ┌───────────────────────────────┐          ┌─────────────────────────────┐
│  │ React chrome (panels, toolbar) │          │ OpenCascade (WASM, replicad)│
│  │ Viewport engine (Three.js)     │  regen   │ Builder: timeline → solids  │
│  │ Sketch controller (snapping)   │ ───────► │  · per-step cache           │
│  │ Store: document + sessions     │ ◄─────── │  · persistent references    │
│  │ History (Immer patches)        │  meshes  │  · friendly errors + fixes  │
│  └───────────────────────────────┘ (transfer)│ 7 export formats (exporters)│
│                                             └─────────────────────────────┘
│  packages/core is shared by both sides: model, formulas, sketch geometry. │
└──────────────────────────────────────────────────────────────────────────┘
          │ optional
          ▼
  apps/server (Rust/Axum): static app, accounts (none / local / OIDC),
  per-user design storage with versions, SQLite or PostgreSQL
```

## Principles in code

| Principle | Where it lives |
|---|---|
| The UI thread never runs geometry | `packages/kernel/src/worker.ts` + `client.ts`; meshes come back as transferable typed arrays |
| Document = data, not geometry | `packages/core/src/model.ts`; the kernel derives everything |
| Only rebuild what changed | `Builder.regen`: each step is cached under a hash of its inputs and everything before it |
| A failing feature doesn't break the model | `Builder.step`: errors become a status; the next step builds on the last good state |
| Errors suggest a fix | `FeatureError` + `largestWorking()` search (fillet, chamfer, shell) |
| Always show the next step | `apps/web/src/state/hints.ts`: derived from state, never hand-placed |
| One command registry | `apps/web/src/state/commands.ts` feeds toolbar, palette and shortcuts |
| Every edit is undoable | `packages/core/src/history.ts` (Immer patches); feature dialogs are "sessions" = one undo step, with step-wise undo inside |

## Persistent references ("topological naming")

Fillets, chamfers, shells and face sketches don't store face/edge *indices*. They store a geometric fingerprint (center/mid-point, normal/tangent, surface/curve type, area/length). On every rebuild `packages/kernel/src/refs.ts` re-resolves it:

1. keep candidates with the same type and orientation;
2. a single candidate is the match even if it moved (however far: today this is silent, so a face that disappeared can be replaced by an unrelated one of the same type and direction);
3. otherwise the closest wins, and an ambiguous choice is flagged as a **warning** so the user confirms instead of getting a silent wrong pick.

`packages/kernel/test/build.test.ts` covers the key case: fillet four edges, change the sketch width 40 → 60, and the fillet stays on the same four edges with the exact expected volume.

While a fillet/chamfer/shell is being edited, the kernel also returns the bodies *before* that feature (`pickBefore`), so edges stay pickable while the live preview shows the result.

## Formulas and units

`packages/core/src/expr.ts` is a small Pratt parser with dimensional analysis. Internally everything is millimetres and radians. Bare numbers adopt the unit of what they're combined with or the field's unit, so beginners can type `30` and experts can type `1.5 in + wall`. Mistakes like `10 mm + 5 deg` get a readable message.

## File format (.whittle)

A ZIP container holding `manifest.json`, `document.json` (the source of truth), an optional `thumbnail.png`, and `imports/<id>.bin` for each embedded STEP/STL file (raw bytes; in memory they are base64 in the document). `migrate()` upgrades older schemas and refuses newer ones with a clear message.

## Swappable kernel

The UI talks to geometry only through the `KernelHost` interface (`client.ts`). Today the default runs OCCT in a Web Worker everywhere. A native OCCT sidecar (desktop) or a remote kernel (server) can implement the same messages later without touching the UI.

## Platforms

The same web app runs in three places. `apps/web/src/state/platform.ts` detects which one at start-up
(Tauri global present → desktop; `/api/config` answers → server; otherwise plain browser), and
`state/files.ts` routes Open, Save, Export and version history accordingly:

| | Open / Save | Version history | Confirmations |
|---|---|---|---|
| Desktop | Rust commands in `apps/desktop/src-tauri/src/lib.rs`: native dialogs; files read and written only if the user picked them (dialog, recent list, OS file-open) | the previous copy is kept in the app data folder on every save | native dialogs |
| Server | `/api/designs` (create, save with `If-Match`, download) | server-side, per design, pruned to `WHITTLE_MAX_VERSIONS` | browser |
| Browser | File System Access API, else downloads | IndexedDB (`state/localHistory.ts`), keyed by the document's stable `id` | browser |

## Server

`apps/server` is a library (`lib.rs`, used by the integration tests) plus a small CLI (`main.rs`).
One portable schema serves SQLite and PostgreSQL through SQLx's `Any` driver; migrations are an
append-only list in `db.rs`. Design files live on disk (`designs/<id>/v<n>.whittle`), metadata in the
database. Sessions are random tokens in HttpOnly cookies, stored hashed. State-changing requests must
carry `X-Whittle: 1` (CSRF guard). The kernel's worker script is the only resource allowed `eval`
(OpenCascade's WebAssembly bindings need it); every other response gets a strict CSP. (The desktop shell's own CSP in `tauri.conf.json` allows `eval` for the whole page.)

