# Whittle audit report

Date: 16 October 2026 · Version audited: 0.7.0 (`main` at `8869d8c`) · Fix branch: `audit/phase4-fixes` (10 commits)

This is a deliverable of the audit, not a source of truth for future audits. Everything here was re-derived
from the code and from running it; comments, README, `PLAN.md`, `docs/*.md` and the untracked
`docs/AUDIT.md` were treated as claims. Anything I could not confirm is marked **UNVERIFIED** with what
would confirm it.

Two limits shape this report, and they are stated up front:

1. **The Rust code (`apps/server`, `apps/desktop`) could not be compiled on this machine**: the MSVC linker
   is not installed (Git Bash's `link` shadows it) and the installed MinGW toolchain lacks `libgcc_eh`;
   WSL has no distribution. So `cargo clippy`, `cargo test` and every server/desktop behaviour below come
   from reading the source, not from running it. I did not change any Rust file, because I could not
   build the change.
2. The geometry kernel is **not custom**: it is OpenCascade (WASM) through `replicad` 1.1.0. The brief's
   "Rust + React" description fits the server/desktop shell and UI only; the CAD logic is TypeScript.

---

## 1. Executive summary

**Overall health: good for a 0.7 preview, with a few real gaps.** The core modelling path (document model →
feature timeline → OpenCascade → meshes → viewport) is coherent, well layered and unusually well tested
(kernel 88 % and core 84 % line coverage, 9 browser suites green, `npm audit` clean). I found no data-loss
bug and no confirmed security vulnerability. I did find one silent-wrong-geometry bug, one
"one bad input blocks the whole model" bug, one data-corruption-on-edit bug, and a set of scale and
resilience limits. Ten were fixed with tests; the rest are listed below.

### Top 10 risks (most important first)

| # | Risk | ID | Status |
|---|---|---|---|
| 1 | No geometry-validity check exists anywhere after any operation; an invalid solid can be reported "ok" | A-02 | Open / Needs decision |
| 2 | A bow-tie outline extruded to an invalid solid and was reported "ok" | A-01 | **Fixed** |
| 3 | A sketch with many shapes is super-linear: 200 circles take 6 s, 600 take 132 s, blocking the kernel with no cancel | J-01 | Open |
| 4 | A face or edge reference silently re-binds to an unrelated face when it is the only candidate of its type | A-03 | Needs decision |
| 5 | One damaged embedded import made every rebuild, export and inspection of the design fail | C-01 | **Fixed** |
| 6 | Renaming a parameter rewrote word fields (plane kind, axis, direction, joint type, arc markers) | C-02 | **Fixed** |
| 7 | The kernel worker has no crash/timeout recovery and the whole document (with embedded files) is cloned to it on every edit | D-01, J-03 | Open / UNVERIFIED |
| 8 | Server rate limits are keyed on the socket peer, so behind the documented reverse proxy they are global (a stranger can lock out a username; 5 reset emails per 15 min for everyone) | I-01 | Needs decision / UNVERIFIED |
| 9 | Server accepts up to 256 MB of decompressed JSON per upload and parses it into `serde_json::Value` (memory amplification by an authenticated user) | I-02 | Needs decision / UNVERIFIED |
| 10 | Desktop CSP allows `eval` for the whole page and blocks every outbound `connect`, so the AI assistant probably cannot work on desktop | I-03 | Needs decision / UNVERIFIED |

### What is solid (verified)

- **Error isolation in the rebuild**: a failing feature becomes a status; later features build on the last good
  state, and the model recovers when the cause is fixed (`build.ts` `step()`; probe: width 0 → error cascade →
  width 20 → all `ok`).
- **Undo/redo**: every design-API tool, feature dialog, reorder and delete round-trips exactly (new test file
  `apps/web/test/undo.test.ts`, 4 tests).
- **File format**: ZIP container, forward migrations, newer files refused, decompression cap that holds even
  when the ZIP header lies (probe P9: a 300 MB document with a forged 100-byte header decompressed to 100 bytes).
- **Exports are structurally valid** (probe E): 3MF has 0 non-manifold edges and in-range indices; GLB chunk
  lengths are consistent; PLY and binary STL sizes match their headers; OBJ indices are in range; STEP round
  trips exactly (volume difference 3e-13, 12 faces → 12 faces).
- **Constraint solver** (PlaneGCS): under/full/over/redundant states are reported correctly, with named
  conflicting constraints; absurd values (1e300) fail cleanly (`state: error`).
- **Server security basics** (by reading): Argon2id, session tokens stored hashed, CSRF header, strict CSP,
  per-owner design access (404 on foreign ids), bounded zip parsing, SSRF-safe OIDC (no redirects), open-redirect
  guard, state cookie bound to the browser, no `unsafe` Rust in either crate.
- **Web hygiene**: no `innerHTML`/`dangerouslySetInnerHTML`/`eval`/`new Function` anywhere in `apps/web/src`;
  SVG import strips scripts, `on*` handlers and external hrefs; all 145 registered commands have unique ids and
  no dangling references from the toolbar.
- **Tests**: 227 unit/geometry tests and 9 browser suites pass on the fix branch.

---

## 2. Baseline (Phase 1)

### 2.1 Inventory

| Module | Language | LOC (code, excluding tests) | Role |
|---|---|---|---|
| `packages/core` | TypeScript | 4,423 | Document model, units and formula language, parameters, undo history, file format, sketch geometry, constraints, DXF reader |
| `packages/kernel` | TypeScript | 4,170 | Regeneration engine on OpenCascade (replicad), persistent references, solver glue, exporters, worker + client |
| `apps/web` | TypeScript/React | 18,190 (+4,708 CSS) | UI, Three.js viewport, sketch tools, design API, platform layer |
| `apps/server` | Rust (axum 0.8.9, sqlx 0.8.6) | 3,131 (+563 tests) | Optional server: accounts, OIDC, design storage with versions, admin, backup tools |
| `apps/desktop/src-tauri` | Rust (tauri 2.12.3) | 414 | Native file dialogs, recent files, local version history |
| Tests | TS / mjs | 3,857 (unit) + 1,839 (browser) | Vitest, 9 Playwright suites |

Entry points: `apps/web/src/main.tsx` (UI; also exposes `window.whittle`), `packages/kernel/src/worker.ts`
(kernel worker), `apps/server/src/main.rs` (CLI + server), `apps/desktop/src-tauri/src/main.rs`.
Build: root `package.json` + Vite 8 (no workspaces; packages are wired by TS/Vite aliases).
Key dependencies (locked): react 19.3.0, three 0.186.1, replicad 1.1.0, replicad-opencascadejs 1.1.0,
@salusoft89/planegcs 1.3.0 (PlaneGCS WASM), immer 11.1.21, zustand 5.0.15, fflate 0.8.3,
@anthropic-ai/sdk 0.134.0, vite 8.3.4, vitest 4.1.11, typescript 5.9.3, playwright-core 1.64.1;
Rust: tokio 1.53.3, argon2 0.5.3, openidconnect 4.0.1, lettre 0.11.23, zip 2.4.2, rustls 0.23.46, wry 0.57.0.
Web bundle: main JS 1.36 MB (385 KB gzip), worker 525 KB, OpenCascade WASM 23 MB (7.3 MB gzip).

### 2.2 Build, tests, static analysis

| Check | Command | Result |
|---|---|---|
| Typecheck (strict) | `npm run typecheck` | **Pass**, 0 errors (9 s) |
| Unit + geometry tests | `npm test` | **Pass**: 26 files / 214 tests before changes; 29 files / 227 tests after (the 13 new tests are mine) |
| Web build | `npm run build` | **Pass**, no warnings beyond chunk size |
| Browser tests | `tests/e2e/{smoke,features,advanced,modeling,constraints,pictures,shapes,sketching,audit}.mjs` against `vite preview` (Edge) | **9/9 pass** before and after the fixes; no console errors |
| Dependency audit | `npm audit` | **0 vulnerabilities** |
| Unused code | `tsc --noUnusedLocals --noUnusedParameters` | 7 findings (see H-02) |
| ESLint / Prettier | none configured in the repo | n/a (there are `eslint-disable` comments but no ESLint) |
| Rust build, `cargo clippy`, `cargo test` (server), desktop `cargo test --lib` | `cargo ...` | **Could not run** (see top). CI runs them (`ci.yml`); I did not see a result. **UNVERIFIED** |
| `cargo audit` | not installed | **UNVERIFIED** (no advisory check of `Cargo.lock`) |
| Server browser test `tests/e2e/server.mjs` | needs the server binary | **Not run** |

Coverage (v8, unit tests only; the browser suites are not instrumented; plugin installed with `--no-save`):

| Area | Lines covered |
|---|---|
| `packages/kernel` | 88.4 % (2,056 / 2,325) |
| `packages/core` | 83.7 % (1,510 / 1,804) |
| `apps/web/src/state` | 18.2 % (608 / 3,335) |
| `apps/web/src/ui`, `apps/web/src/viewport` | 0 % (3,747 lines; exercised only by the browser suites) |
| Whole repo | 36.9 % |

Modules with **zero unit tests**: `kernel/client.ts`, `kernel/worker.ts`, `web/state/{ai, commands, constraintOps, hints, inspect, measure, sectionCurves, sketchOps}.ts`
(`designApi.ts`, `store.ts` now covered by `undo.test.ts`), all of `web/ui`, all of `web/viewport`, `desktop/lib.rs` beyond 2 tests.
The server has 15 integration tests in `tests/api.rs` that I could not run.

### 2.3 Architecture, from the code

```
UI thread (apps/web)                                 Kernel worker (packages/kernel)
 React chrome ── commands.ts / actions.ts ──┐         worker.ts  ── queue, drops superseded regens
 Zustand store (document + sessions)        │ regen   Builder.walk(): per-feature snapshot cache
 Immer History (undo)                       ├───────► Builder.step()/apply(): replicad / OpenCascade
 Three.js Viewport ◄── meshes (transferred) │ meshes  refs.ts: persistent face/edge references
 files.ts: open/save/export/autosave        │         solver.ts: PlaneGCS sketch constraints
 platform.ts: browser | desktop(Tauri) | server(API)  exporters.ts: STEP/STL/3MF/OBJ/GLB/PLY/SVG drawing
                          packages/core: model, formulas, sketch geometry, file format (shared)
```

Data flow: user action → `commands.ts`/`actions.ts` → `store.mutate` (Immer patch → `History`) → `kernel.ts`
schedules a regen on `requestAnimationFrame` → `WorkerKernel.regen` posts the **whole document** to the worker →
`Builder` walks the timeline, reusing cached snapshots → typed-array meshes are transferred back → `Viewport`.
Layering is clean in one direction: `core` imports nothing from the other packages; `kernel` imports only `core`;
`apps/web` imports both. **Cycles (H-01)**: `kernel/{build,extra,surface}.ts` import each other;
`web/state/{files,drawings,refImage}.ts`; `web/ui/{Dialogs,Settings,Assistant}.tsx` (found with a Tarjan SCC
script; no layering violations between packages).

---

## 3. Findings

Severity: **Critical** crash/data loss/corrupt geometry/security · **High** wrong results or broken feature ·
**Medium** · **Low** · **Info**. Status: Fixed · Open · Needs decision · Unverified.
"Evidence" points at code I read and, where noted, a probe or test I ran (`docs/audit-probes/`, regression tests).

### 3.1 Geometry and kernel (area A)

| ID | Sev | File:line | Description | Evidence | Status |
|---|---|---|---|---|---|
| A-01 | High | `packages/kernel/src/build.ts:274-280` (`sketchDrawing`) | A closed outline whose edges cross (bow-tie) extruded to a solid that OpenCascade's `BRepCheck_Analyzer` reports **invalid**, with volume ≈ 5.7e-14, and the feature status was `ok` with no message. | Probe Q3: `status ok`, `vol 5.68e-14`, `valid: false`. Test `audit2.test.ts › self-intersecting outlines` failed before the fix. | **Fixed** `3c4bd34` (sketch rejects crossing outlines; touching and concave outlines still build) |
| A-02 | Medium | whole kernel | **No validity check after any operation** (`grep -rn "isValid\|BRepCheck\|ShapeFix"` finds nothing but a draft `IsDone`). Booleans, sweeps, lofts, imports can yield invalid or non-manifold solids that are shown, measured and exported as if fine. Only `FRIENDLY` messages handle thrown errors. | Grep result; A-01 shows the consequence. A fused pair of boxes touching only along an edge is "valid" per OCC but non-manifold for printing (probe Q3c: 1 body, 12 faces). | Needs decision (ND-2) |
| A-03 | Medium | `packages/kernel/src/refs.ts:106` | Persistent references: when exactly one candidate has the same surface/curve type and direction, it is returned with `uncertain:false` **however far it moved**. A hole on a boss top silently re-binds to the base plate's top face when the boss is suppressed. Contradicts "never a silent wrong pick". | Probe P1: after suppressing the boss the hole feature stays `ok`, no warning, and drills the plate (volume 15,937.17 = plate − hole). | Needs decision (ND-1) |
| A-04 | Low | `packages/kernel/src/build.ts:1554` | Import cache key is the feature id + data length + first/last 64 base64 chars. Two different files of the same length with the same ends collide and the second is ignored. No UI path edits `data` in place (a re-import makes a new feature id), so I could not reach it. | Code only; collision conditions demonstrated at key level (probe P5). | Open (Info) |
| A-05 | Low | `packages/kernel/src/exporters.ts:40,53` | STL/OBJ/GLB/3MF are meshed at a fixed 0.01 mm tolerance regardless of model size; a metre-scale part produces very large meshes. Not measured. | Code. | Open, UNVERIFIED impact |
| A-06 | Low | `packages/kernel/src/stl.ts` | STL import sews triangles into a solid with ≤ 40,000 triangles; a curved part comes back faceted (round trip of a 12-face part gives **8,260 faces**; volume off by 0.002 %). 8k triangles take 2.8 s, 20k take 7.1 s. No unit handling (assumes mm). | Probes E, S. | Open (limitation) |

### 3.2 Sketching and constraints (B)

| ID | Sev | File:line | Description | Evidence | Status |
|---|---|---|---|---|---|
| B-01 | Info | `packages/kernel/src/solver.ts` | Verified working: 4-line rectangle = 4 DOF, full = 0, conflicting `Distance 20/25` named in the message, duplicate dimension reported as redundant, impossible values reported as `error`. Positions stay at the last good solution on failure (no NaN spread). | Probes B, P7. | Verified |
| B-02 | Low | `packages/kernel/src/solver.ts:161` | A distance of 0 is accepted (`d < 0` is the only check); the sketch then fails later with no solver message (state `under`, empty message). | Probe B "impossible dim". | Open |
| B-03 | Low | `packages/core/src/sketchShapes.ts:135` | Ellipses, text and gears cannot be converted to constrainable geometry (message says so). | Code. | Limitation |

### 3.3 Parametric / history model (C)

| ID | Sev | File:line | Description | Evidence | Status |
|---|---|---|---|---|---|
| C-01 | High | `packages/kernel/src/build.ts` `prepareImports` (was line 486) | `atob(f.data)` ran **outside** the per-import `try`. A design with an Import feature holding invalid base64 made `prepareImports` throw before any feature was built, so every rebuild, export and inspect failed for the whole design (the worker posts an error for all requests). | Probe P4 (`InvalidCharacterError`); test `audit2.test.ts › damaged imports` failed before. | **Fixed** `88c062a` |
| C-02 | Medium | `packages/core/src/params.ts:121` (`NOT_EXPR`) | `renameParameter` rewrote any string that looked like the old name, except under a denylist of keys. Missing keys: `kind`, `axis2`, `thinSide`, `direction`, `joint`, `origin`, `source`, and the `"arc"`/`"spline"` marker in outline points. Renaming a parameter called `y`, `axis`, `inside`, `center`, `face`, `tangent`, `arc`, `spline`, `project`, `revolute`, `origin` or `construction` silently changed the matching setting. | Probe P2 (`direction: "axis"` → `"shaft"`, `thinSide: "inside"` → `"wall"`); the new test checks every word a feature can hold: 11 names failed before. | **Fixed** `b32b2fd` |
| C-03 | Low | `packages/kernel/src/build.ts` (`bodyForRefs`) | After an upstream failure, dependants say "The body this feature was applied to no longer exists" instead of naming the failed feature. | Probe C. | Open (UX) |
| C-04 | Info | `packages/core/src/params.ts` | Cycles in parameters are detected and both parameters are flagged; evaluation errors propagate by name. | Read + probe C ("Parameter "width" has an error…"). | Verified |

### 3.4 Document, undo, state (D)

| ID | Sev | File:line | Description | Evidence | Status |
|---|---|---|---|---|---|
| D-01 | Medium | `packages/kernel/src/client.ts:40` | `worker.onerror` rejects in-flight requests but the worker is never replaced; later `regen()` calls post to a dead worker, the promise never settles and `regenBusy` stays true. WASM out-of-memory kills the worker the same way. | Code. **UNVERIFIED** (I could not crash the worker deliberately). | Open |
| D-02 | Low | `apps/web/src/state/store.ts:171` (`touch`) | Every edit stamped a new `modifiedAt`, so setting a field to its current value still created an undo step, marked the design dirty and re-ran the rebuild. | Probe (undo label became `noop`; `historyTick` rose on identical updates); test `undo.test.ts › an edit that changes nothing…` failed before. | **Fixed** `178f979` (time is stamped at save) |
| D-03 | Low | `apps/web/src/state/files.ts:475-513` | Autosave/crash recovery uses **one** `localStorage` slot for all designs and tabs, is never cleared after a save (the start screen offers "Continue where you left off" for a design you already saved), a recovered document shows "Saved", and it silently stops (after one toast) when the design exceeds the ~5 MB quota (an imported STEP is stored as base64 inside the document). | Code. Multi-tab clobbering **UNVERIFIED**. | Open |
| D-04 | Info | `store.ts`, `history.ts` | Verified: sessions = one undo step, cancel restores, `redo` disabled inside a session, history limit 500, merge window 1.5 s. | `undo.test.ts` (4 tests). | Verified |

### 3.5 File I/O and interoperability (E)

| ID | Sev | File:line | Description | Evidence | Status |
|---|---|---|---|---|---|
| E-01 | Medium | `packages/core/src/file.ts:79` (`migrate`) | `migrate` checked only that the lists were arrays; a `null` entry in `features` got through and blanked the whole UI (see G-01). | Browser probe: `features:[null]` → `#root` empty; unit test failed before. | **Fixed** `0f9ad5e` (entries must be objects with `id`/`type`; parameters need `name`/formula) |
| E-02 | Low | `packages/core/src/dxf.ts` | DXF import passed NaN (malformed numbers) and zero-radius circles into the sketch, where they became the text "—" and failed the whole sketch. | Probe P8; test failed before. | **Fixed** `b8cd465` (entities skipped and named in the "Skipped:" note) |
| E-03 | Low | `packages/core/src/dxf.ts` | DXF limits: ASCII only; no block/`INSERT` expansion (reported as skipped); extrusion direction (code 210-230, mirrored arcs) ignored; `$INSUNITS` ignored (the user picks a scale). | Code. | Limitation |
| E-04 | Info | `files.ts`, `exporters.ts` | Real exports: STEP, STL, 3MF, OBJ, glTF binary, PLY, SVG drawing, sketch SVG/DXF. Real imports: STEP, STL, `.whittle`, sketch SVG/DXF, reference images. **No** IGES, 3MF/OBJ/glTF import, PDF, DXF of 3D, JT, Parasolid. | Code. | Verified |
| E-05 | Low | `apps/web/src/state/actions.ts:300` | Imports are embedded as base64 in the document (40 MB file → 53 MB of JSON). This inflates autosave, saves, version history and every worker message (J-03). | Code. | Open |

### 3.6 Rendering and viewport (F)

| ID | Sev | File:line | Description | Evidence | Status |
|---|---|---|---|---|---|
| F-01 | Low | `apps/web/src/viewport/Viewport.ts:253` | `dispose()` disconnects the observer, cancels the frame and disposes the renderer, but not the scene environment/background textures, body geometries/materials, or the WebGL context (`forceContextLoss`). Matters only if the viewport is ever unmounted (it is not in the app today). Per-object disposal elsewhere (`disposeObject`) is thorough. | Code. Leak **UNVERIFIED**. | Open |
| F-02 | Info | `Viewport.ts` | Analysis modes (overhang, draft, zebra, curvature, access), section, ortho, x-ray, exploded view exist and ran in browser suites (`advanced`, `audit`). Picking uses per-face index ranges returned by the kernel. | e2e. | Verified |

### 3.7 UI and workflow (G)

| ID | Sev | File:line | Description | Evidence | Status |
|---|---|---|---|---|---|
| G-01 | High | `apps/web/src/main.tsx` | **No React error boundary.** Any exception while drawing unmounted the entire app: blank page, no way to save the open design. | Browser probe; `audit.mjs` step 10 timed out waiting for a recovery screen on the old build. | **Fixed** `a77e569` (`ErrorBoundary`: Try again / Save a copy / Reload) |
| G-02 | Medium | kernel worker | **No cancel, timeout or progress for long operations.** A heavy rebuild blocks the single worker until it ends (J-01). `widestSection` runs 41 booleans (`extra.ts:65`). | Code + J-01 measurements. | Open |
| G-03 | Low | `apps/web/src/main.tsx:23` | `window.whittle` (store, design API, command registry) is exposed in production builds. Same-origin script already has full access, but it widens the impact of any XSS. The e2e suites rely on it. | Code. | Open (Low) |
| G-04 | Info | `commands.ts` | 145 commands, unique ids, no missing references from the toolbar/menus. Keyboard shortcuts documented in the README exist in the registry. | Script cross-check; e2e `04-shortcuts`. | Verified |

### 3.8 Code quality (H)

| ID | Sev | File:line | Description | Evidence | Status |
|---|---|---|---|---|---|
| H-01 | Low | `kernel/src/{build,extra,surface}.ts`; `web/state/{files,drawings,refImage}.ts`; `web/ui/{Dialogs,Settings,Assistant}.tsx` | Three import cycles. They work today because the cross-imports are only used at call time. | SCC script. | Open |
| H-02 | Low | various | Dead code: unused `point`, `EDGE_SELECTOR` (`designApi.ts:73,80`), `downAt` (`sketchTools.ts:164`), `cplaneFrames` (`Viewport.ts:179`), parameter `sk` (`sketchCopy.ts:206`), `latestRegen` (`client.ts:16`), import `basicFaceExtrusion` (`surface.ts:10`); the `ask_dialog` Tauri command (`desktop lib.rs:187`) is registered but never called by the web app. | `tsc --noUnused*`, grep. | Open |
| H-03 | Low | `packages/kernel/src/worker.ts:23` | The worker rewrites `console.error` to `console.debug` for the whole worker, hiding real failures along with OpenCascade's noisy dumps. | Code. | Open |
| H-04 | Low | `build.ts` (`sketchWarning`, `CELL_INFO` in `extra.ts:92`) | Module-level mutable state used as a side channel between calls; safe only because the worker is single-threaded and synchronous. | Code. | Open |
| H-05 | Info | whole repo | **TODO/FIXME/HACK/XXX markers: none** in TS, TSX, Rust or mjs. `ponytail:` comments mark known shortcuts (e.g. 1 µm weld quantization, 5× miter cap, probe limit 80). No placeholders or stubbed implementations found; each registered feature type has a code path in `Builder.apply`. | Grep. | Verified |
| H-06 | Info | `build.ts` `hashKey` | New: the rebuild cache key is a 53-bit hash plus length. A collision (≈ 2⁻⁵³ per comparison) would reuse a stale step. Accepted; two independent hashes would remove it (ND-7). | Design note. | Accepted |
| H-07 | Info | Rust | No `unsafe`. Remaining `unwrap/expect`: `auth.rs:126` (ASCII cookie), `settings.rs:125`, `tools.rs:142,146` (serializing known structures), desktop `Mutex::lock().unwrap()` (poison only). | Grep. | Verified |

### 3.9 Security and robustness (I) — Rust findings are from reading only

| ID | Sev | File:line | Description | Evidence | Status |
|---|---|---|---|---|---|
| I-01 | Medium | `apps/server/src/auth.rs:196-205,256,467-484` | The client address for rate limiting comes only from the socket peer (`ConnectInfo`). `docs/SELF_HOSTING.md:75-100` tells operators to run behind nginx/Caddy, whose example forwards only `Host` and `X-Forwarded-Proto`, so every client shares the proxy's address. Login lockout is keyed `address|username` (10 failures / 15 min): **anyone can lock out any username**. The forgot-password limit is `address|reset` (5 / 15 min): **5 reset requests per 15 minutes for the whole server**. | Code and doc. **UNVERIFIED at runtime.** | Needs decision (ND-3) |
| I-02 | Medium | `apps/server/src/designs.rs:50-75`; `file.ts:44` | Uploads are capped at 64 MB compressed, but `document.json` may expand to 256 MB and is then parsed into a `serde_json::Value` in a blocking task. A few KB of highly compressible JSON (e.g. an array of zeros) needs several GB as `Value`; several concurrent uploads by one signed-in user can exhaust memory. The size claimed in the ZIP header is correctly ignored. The browser has the same 256 MB ceiling. | Code. **UNVERIFIED** (not run; amplification estimated, not measured). | Needs decision (ND-5) |
| I-03 | Medium | `apps/desktop/src-tauri/tauri.conf.json:33` | Desktop CSP: `script-src … 'unsafe-eval'` applies to the whole page (the server grants it only to the worker script), contradicting `ARCHITECTURE.md`. `connect-src` has no `https:`/`localhost`, so the AI assistant (`ai.ts` fetches Anthropic/OpenAI/Ollama directly) is probably **blocked in the desktop app**, while the README advertises it for all platforms. `withGlobalTauri: true` exposes the IPC global to page scripts. | Config read. **UNVERIFIED** (desktop build impossible here). | Needs decision (ND-4) |
| I-04 | Low | `apps/server/src/auth.rs:321` | Setup race: `first = user_count()==0` is read without a lock, so two simultaneous first registrations both become administrators; and whoever reaches a fresh internet-facing server first becomes the administrator (documented in SELF_HOSTING.md:135, but no setup token). | Code. | Needs decision (ND-6) |
| I-05 | Low | `apps/server/src/{tools.rs:124,settings.rs:34}` | `backup` writes a ZIP (default file mode) containing password hashes and the **SMTP password in plain text** (stored in the `settings` table). `backup`/`doctor` also run database migrations as a side effect. | Code. | Open |
| I-06 | Low | `apps/server/src/tools.rs:169-222`, `admin.rs:149` | `restore` wipes the database, then replaces design files; a failure in between leaves a mismatched state. Admin `update` applies several changes one by one, so a later failure leaves earlier ones applied. | Code. | Open |
| I-07 | Low | `apps/server/src/config.rs:109`, `oidc.rs:273-288` | `WHITTLE_OIDC_AUTO_CREATE` defaults to true and the first single-sign-on user becomes administrator. With a public identity provider anyone with an account there can sign up. Documented (SELF_HOSTING.md:168), but a risky default. The pending-sign-in table (1,000) can be filled by anonymous callers to block sign-ins for 10 minutes. Accounts created from an unverified provider email can duplicate another account's email, which then breaks email sign-in for both (it requires exactly one match). | Code. | Needs decision |
| I-08 | Low | `apps/web/src/state/ai.ts:52,151` | AI provider API keys are stored in plain text in `localStorage` and the Anthropic SDK runs in the browser (`dangerouslyAllowBrowser`). Disclosed in the code comments; the risk is the same-origin exposure in G-03 and the server CSP allowing `https:` connects when the assistant is on. | Code. | Open (by design) |
| I-09 | Low | `install.sh:143`, `install.sh` | Installers verify downloads against `SHA256SUMS` fetched from the same release, so this is integrity, not authenticity (no signature). macOS: the script strips the Gatekeeper quarantine attribute from an ad-hoc-signed app. Server install runs `deploy/install.sh` as root from the downloaded tarball. | Code. | Open (Info) |
| I-10 | Info | `npm audit` | 0 known vulnerabilities in 68 top-level npm packages. Rust advisories: not checked. | Command. | Verified / Unverified (Rust) |
| I-11 | Info | `apps/desktop/src-tauri/src/lib.rs:83-89` | File access is limited to paths the user picked (dialog, OS open, recent list), writes go through a temp file + rename, and the previous copy is kept in the history folder. The allow-list is rebuilt from `recent.json`, which is user-writable (a local attacker who can edit it already has file access). | Code. | Verified |

### 3.10 Performance and scale (J)

All timings: Node 26, Windows 11, preview-quality meshes, single run; the worker uses the same code path.

| ID | Sev | File:line | Description | Evidence | Status |
|---|---|---|---|---|---|
| J-01 | High | `packages/kernel/src/build.ts:290` (`result.fuse(d)` in a loop) | Fusing the shapes of a sketch is roughly cubic: 50 circles 0.3 s, 100 → 1.0 s, 200 → 6.2 s (8.0 s in the sketch step alone), **600 → 132 s**. A balanced-tree fuse is no faster (probe Q4b). A DXF import, perforated plate or bolt-hole array of a few hundred holes freezes the kernel for minutes with no cancel (G-02). | Probes Q4, Q4b. | Open |
| J-02 | Medium | `build.ts` `walk` | The cache key of step *n* contained the JSON of every earlier step: 300 features held 7.6 M characters of keys, **1,500 held 192 M**, 10,000 would need ~8 GB. | Probe Q5 / P3; test failed before (20,153-char key at 120 features). | **Fixed** `85e6707` |
| J-03 | Medium | `packages/kernel/src/client.ts:70` | `postMessage` clones the **entire document** to the worker on every regen, including base64 imports (up to 53 MB) and reference-image data URLs. Not measured. | Code. | Open, UNVERIFIED impact |
| J-04 | Info | `Builder` | 1,500 independent boxes: first rebuild 4.6 s (221 MB heap), unchanged rebuild 0.23 s, editing the last feature 0.09 s (1 step), editing the first feature 4.6 s (all 1,500 steps: each step depends on the key of everything before it, even when it does not depend on it). | Probe Q5. | Info |

### 3.11 Testing, build, docs (K)

| ID | Sev | Description | Status |
|---|---|---|---|
| K-01 | Low | No coverage tooling or threshold in CI; no lint configuration; UI and viewport have no unit tests (browser suites only, headless software GL). | Open |
| K-02 | Low | CI uses floating toolchains and tag-pinned actions (`dtolnay/rust-toolchain@stable`, `actions/*@v4`), `npx --yes wait-on@8`; no `npm audit`/`cargo audit` step; the `rust-version = 1.80` minimum is never tested. | Open |
| K-03 | Low | The version is written in five places: `package.json`, `apps/desktop/.../tauri.conf.json`, both `Cargo.toml` files (all checked by `release.yml`) and `APP_VERSION` in `packages/core/src/file.ts` (**not** checked, so it can drift into saved manifests). | Open |
| K-04 | Info | Browser suites that exited non-zero would show as exit 0 in my first background run only because of a pipe to `tail`; I re-ran them and read each log. `package.json` has `test:e2e` that chains all nine. | Info |
| K-05 | Info | I found no flaky unit test in two full runs; the kernel suite takes ~107 s of test time because it runs real OpenCascade. | Info |

---

## 4. Documentation versus reality

| Claim (where) | Reality | Action |
|---|---|---|
| `README.md` "Status: **0.2, early preview** … Assemblies, 2D drawings … on the roadmap" | App is 0.7.0; joints (`JointFeature`, `extra.ts` `applyJoint`) and a one-sheet drawing export (`kernel/drawing.ts`) exist. Full assemblies (mates, BOM), sheet metal are indeed absent. | Corrected `ad65620` |
| `docs/ARCHITECTURE.md` "Exporters: STEP, STL, 3MF" | Seven formats (adds OBJ, GLB, PLY, SVG drawing). | Corrected |
| `ARCHITECTURE.md` "ambiguity becomes a warning, never a silent wrong pick" | A single same-type candidate is accepted silently, however far it moved (A-03). | Doc corrected; behaviour is ND-1 |
| `ARCHITECTURE.md` "The kernel's worker script is the only resource allowed eval" | True for the server; the desktop CSP allows it for the whole page (I-03). | Doc corrected |
| `packages/core/src/file.ts` header: manifest has a "checksum of document.json" | No checksum is written or read. | Comment corrected |
| `PLAN.md` status "v0.2 … Sketch next: symmetric / midpoint / collinear constraints ⏳" | Implemented (`solver.ts` cases, tested). Plan not updated since v0.2. | **Not changed** (product plan; owner should refresh) |
| `README.md` "AI assistant … Claude, OpenAI or a local model" on all platforms | Likely blocked by the desktop CSP (I-03, UNVERIFIED). | Open |
| `README.md` "Never lose work: … autosave and crash recovery" | One shared slot, never cleared, silently stops for large designs (D-03). | Open |
| `README.md` "version history with restore on every platform" | Implemented (`files.ts`, `localHistory.ts`, server `designs.rs`, desktop `keep_history`); verified by reading. | OK |
| `docs/AUDIT.md` (untracked, earlier audit) "every source file read" | Not verifiable. Spot-checked claims were true: native dialogs replaced by `DialogHost` and `audit.mjs` fails on any native dialog; per-body mesh cache (`Builder.meshes`); hole standards, sweep, coil exist. | Left as is |
| `docs/WHITTLE.md`, `docs/SELF_HOSTING.md`, `docs/AI_INTEGRATION.md` (long) | Only grepped (installation, proxy, SSO, auto-create, first admin): consistent with code except the proxy rate-limit gap (I-01: the nginx example omits `X-Forwarded-For`, but the server would not read it either). | Open |
| `PLAN.md` "Monorepo: the D: drive is exFAT" | Historical note; the repo is on another drive now. | Info |

---

## 5. Feature gap analysis (Phase 3)

Legend: ✅ complete and verified · ⚠️ partial · ❌ absent · 🐞 present but broken. "Verified" = a test or browser
suite exercises it, or I traced the code path to an output. Baselines: FreeCAD, Fusion 360, Onshape, SolidWorks.

### 5.1 Feature matrix

| Area | Feature | Status | Notes |
|---|---|---|---|
| Sketching | Line/arc/circle/ellipse/polygon/slot/rect/text/gear/spline entities | ✅ | `model.ts`, shapes tests, e2e `shapes`/`sketching` |
| | Geometric + dimensional constraints, DOF colouring, conflict/redundancy naming | ✅ | PlaneGCS; 14 constraint types; e2e `constraints` |
| | Trim/extend/offset/mirror/pattern/fillet corner | ✅ | `constraints.ts`, `sketchCopy.ts` |
| | Project/intersect model edges; reference images; SVG/DXF import; SVG/DXF export | ✅ | DXF import limits E-03 |
| | Constraining ellipses/text/gears; conic/slot-driven constraints | ⚠️ | Not convertible |
| | Self-intersection detection | ✅ | Added in this audit (A-01) |
| Solid modeling | Extrude (symmetric, two-sided, taper, twist, thin, to-face, through), revolve, sweep, loft | ✅ | Loft: no guide rails or tangency ⚠️ |
| | Fillet (constant/variable), chamfer, shell, draft, press/pull, replace/delete face | ✅ / ⚠️ | Chamfer has one distance only (no asymmetric/angle); no setbacks, no face-fillet |
| | Holes with standards, threads (modelled), coil/spring, ribs | ✅ | Cosmetic threads ❌ |
| | Mirror, linear/circular/path patterns, feature patterns, split, offset, scale, combine, boundary fill | ✅ | Pattern along sketch-driven points ❌ |
| | Boolean robustness / validity | ⚠️ | No validity checks (A-02); pattern/boolean cost grows fast (J-01) |
| | Topological naming | ⚠️ | Fingerprint matching; silent single-candidate rebind (A-03) |
| Surface modeling | Patch, ruled, offset, trim, untrim, extend, stitch, unstitch, merge, reverse, thicken | ✅ | `surfaces.test.ts` |
| | Loft with rails, G2 blends, NURBS editing, curvature-continuity tools | ❌ | Zebra + curvature display exist |
| Mesh/direct | STL → solid (≤ 40k triangles, faceted), STEP direct edit via press/pull, delete-face | ⚠️ | Mesh repair, remesh, mesh→NURBS ❌ |
| Assemblies | Joints (rigid, revolute, slider, cylindrical, planar, ball, pin-slot), limits, motion links, grounding, components by name, collision warning, exploded view | ⚠️ | Positions bodies inside one document; not a mates solver |
| | Mates between faces/edges, multi-file assemblies, in-context edit, BOM, motion study | ❌ | `.whittle` import brings a derived copy only |
| | Interference check | ✅ | `inspect.ts` (coverage 100 %) |
| 2D drawings | One A3 sheet: front/top/right + iso, hidden lines, overall dimensions, title block, scale | ⚠️ | SVG only |
| | Section/detail/auxiliary views, real dimensions/GD&T/annotations/BOM tables, multi-sheet, PDF/DXF output | ❌ | |
| Analysis | Measure (distance, gap, angle, diameter, length, area); volume, area, centre of mass, mass for 30 materials; section view | ✅ | |
| | Overhang, draft, zebra, curvature, tool-access shading; minimum-radius check | ✅ | |
| | Wall-thickness analysis, moment of inertia, tolerance stack | ❌ | |
| Manufacturing | Sheet metal, weldments | ❌ | |
| | CAM / toolpaths / G-code | ❌ | |
| | 3D-print prep: 3MF/STL export (welded, manifold in probe), overhang shading | ⚠️ | Slicing hooks, supports, mesh repair ❌ |
| | Simulation/FEA hooks | ❌ | |
| Scripting | Documented JSON design API (`designApi.ts`, `window.whittle.api`, AI tool-use) | ⚠️ | No sandboxed macro/plugin runtime, no Python |
| Configuration | Named parameters, units-aware formulas, variants (named value sets) | ✅ | Spreadsheets/design tables ❌ (CSV export of parameters only) |
| Appearance | Body colour, 4 finishes, 30 materials, 6 themes | ✅ | Ray-traced rendering/environment export ❌ (GLB export for external renderers) |
| Collaboration | Version history per platform, optimistic-concurrency save | ✅ | Real-time collaboration, diff/merge, comments ❌ |
| Units | mm, cm, m, in, ft; degrees/radians; internal mm | ✅ | Mass units fixed |
| Import | STEP, STL, `.whittle`, SVG, DXF (2D), images | ✅ | IGES, 3MF, OBJ, glTF, DXF-3D, Parasolid ❌ |
| Export | STEP, STL, 3MF, OBJ, GLB, PLY, SVG drawing, sketch SVG/DXF | ✅ | IGES, PDF drawings ❌ |
| Platforms | Browser, Tauri desktop (Win/macOS/Linux per CI config), self-hosted server | ⚠️ | Desktop/server **UNVERIFIED** here (could not build); AI on desktop doubtful |

I found no feature that is registered but broken (🐞) other than the behaviours already listed as findings.

### 5.2 Prioritised roadmap (value × feasibility, with dependencies)

| Rank | Item | Value | Effort | Depends on |
|---|---|---|---|---|
| 1 | **Validity pass** (`BRepCheck_Analyzer` on tool shapes and on the final body, `ShapeFix` where cheap, a visible "geometry check" status) | High | Medium | ND-2 |
| 2 | **Sketch region build without N-way fuse** (group by overlap, compound for disjoint shapes, or build holes by cutting a prism) | High | Medium | none |
| 3 | **Worker resilience**: respawn on crash, per-request timeout and cancel, progress messages | High | Medium | none (enables 4) |
| 4 | **Slim documents**: store imports and reference images as separate ZIP entries; send the worker an id/hash instead of the bytes | Medium | Medium | file format v3 + migration |
| 5 | Reference-resolution confidence (ND-1) and a "re-pick" UI path | High | Medium | A-03 decision |
| 6 | Drawings v2: section and detail views, real dimensions, PDF/DXF | High | Large | `drawing.ts`; HLR already in use |
| 7 | Import 3MF/OBJ; export IGES via OCCT | Medium | Small-Medium | none |
| 8 | Mates + BOM + multi-document components | High | Large | component model; 4 |
| 9 | Scripting runtime (sandboxed worker running the existing JSON API) | Medium | Medium | stable API (exists) |
| 10 | Sheet metal, then CAM | High | Very large | 1, 8 |
| 11 | Real-time collaboration and diff/merge (documents are already data + Immer patches) | Medium | Large | 4 |

---

## 6. Fixes made (Phase 4)

Branch `audit/phase4-fixes`, each commit is one logical fix and includes the test that failed before it.

| Commit | Fix | Test (failed before, passes after) |
|---|---|---|
| `88c062a` | C-01 Damaged embedded import fails only its own feature | `packages/kernel/test/audit2.test.ts` › damaged imports |
| `3c4bd34` | A-01 Reject self-crossing outlines (`crossesItself` in `core/sketch.ts`, used by `sketchDrawing`) | `audit2.test.ts` › self-intersecting outlines (plus a concave/touching outline that must still build) |
| `85e6707` | J-02 Hash the chained rebuild cache key | `audit2.test.ts` › rebuild cache keys (key < 200 chars at 120 features; unchanged → 0 rebuilt, one edit → 1) |
| `b32b2fd` | C-02 Parameter rename leaves word fields alone | `packages/core/test/audit2.test.ts` › renaming a parameter (all 11 colliding names; real references still renamed) |
| `0f9ad5e` | E-01 `migrate` refuses junk entries in the feature/parameter lists | `core/test/audit2.test.ts` › opening damaged files |
| `b8cd465` | E-02 DXF import skips unreadable entities | `core/test/audit2.test.ts` › DXF import |
| `178f979` | D-02 Save time stamped when writing, not on every edit; undo/redo regression tests | `apps/web/test/undo.test.ts` (4 tests; the "no-op edit" test failed before), `core/test/audit2.test.ts` › saving |
| `a77e569` | G-01 Error boundary with recovery screen | `tests/e2e/audit.mjs` step 10 (timed out on the old build, passes on the new) |
| `ad65620` | Documentation corrections (section 4) | n/a |
| branch tip | This report and `docs/audit-probes/` (measurement scripts for the open findings) | n/a |
| `c5bf9d8` | Updated the existing round-trip test: a saved document now differs from the original only in `modifiedAt` | `core/test/expr.test.ts` › round-trips a document |

**After the fixes**: `tsc --noEmit` clean · 29 files / **227 tests pass** (was 214) · production build OK · all nine
browser suites pass on the rebuilt app · `npm audit` still 0. Before/after for the performance fix: key length at 120
features 20,153 → under 200 characters (test), rebuild results unchanged.

Not changed on purpose: all Rust files (cannot build), anything needing a design decision (section 7), and large
refactors (J-01, J-03, D-01, H-01).

---

## 7. Needs decision

| ID | Question | Options and trade-offs |
|---|---|---|
| ND-1 | A-03: how should a reference behave when it matches only one same-type candidate far from where it was? | (a) Warn when the candidate's area/length differs by more than ~4× or it moved more than ~3× its own size. Cheap, catches the demonstrated case, but is a heuristic and will add some warnings to existing designs. (b) Warn whenever it moved at all (breaks the documented "survive a width change" behaviour and the existing `build.test.ts` expectation). (c) Keep, and rely on the doc correction. |
| ND-2 | A-02: validity checking | (a) `BRepCheck_Analyzer` on every tool shape and final body: catches the most, costs tens to hundreds of ms on big bodies each rebuild. (b) Check only at export/print-check and on a "Check geometry" command: no rebuild cost, finds problems late. (c) Check tool shapes only (extrude/revolve/sweep/loft/import): cheap, covers the A-01 class. I lean to (c) now and (b) for the whole body. |
| ND-3 | I-01: client address behind a reverse proxy | (a) New `WHITTLE_TRUST_PROXY` setting that reads the first `X-Forwarded-For` entry (and document it in the nginx/Caddy examples). (b) Also add a per-username limit independent of address. (c) Leave and document that lockout is global behind a proxy. A change needs the Rust build to be verified. |
| ND-4 | I-03: desktop CSP and the AI assistant | (a) Add `https:` and `http://localhost:*` to `connect-src` and drop `unsafe-eval` from `script-src` in favour of a worker-only policy (needs a Tauri-side header for the worker). (b) Hide the assistant on desktop and document it. (c) Leave. The AI feature is optional; widening `connect-src` increases exfiltration surface. |
| ND-5 | I-02: decompression limit | (a) Lower `MAX_DOCUMENT_BYTES` to ~64 MB and reject ratios above ~100×. (b) Validate by streaming (do not build a `Value`). (c) Keep at 256 MB but limit concurrent parses. Large embedded STEP files make a hard cap awkward until imports are stored as separate entries (roadmap 4). |
| ND-6 | I-04: first-run administrator claim | (a) Print a one-time setup token at start-up that the first registration must present. (b) Bind to localhost until an admin exists. (c) Keep (documented). Also make the first-user check atomic. |
| ND-7 | H-06: cache-key collisions | Accept the 53-bit hash, or combine two independent hashes (cheap) for ~2⁻¹⁰⁶. |
| ND-8 | J-01: how to build many-shape sketches | (a) Union only overlapping groups (bounding-box graph), keep disjoint shapes as a compound. (b) Build a single face with holes by cutting a prism. (c) Offer a "pattern" fast path for repeated identical holes. (a) is the most general; needs checking against sketch semantics (holes, auto-hole detection). |

---

## 8. Coverage statement and limitations

### 8.1 Read line by line (complete)

- `packages/core/src/*` (15 files) · `packages/kernel/src/*` (14 files).
- `apps/web/src/state/{store, files, kernel, platform, ai, designApi, actions, drawings, localHistory}.ts`, `App.tsx`, `main.tsx`.
- `apps/server/src/*` (all 11 files) · `apps/desktop/src-tauri/src/{lib,main}.rs`, `tauri.conf.json`, `capabilities/default.json`, `Cargo.toml`.
- `install.sh`, `.github/workflows/ci.yml` (fully), `release.yml` (first 120 lines), `README.md`, `docs/ARCHITECTURE.md`, `PLAN.md` (first 80 lines), `docs/AUDIT.md` (first 80 lines).
- Existing tests read: `kernel/test/{build, import, audit}.test.ts`, `core/test/audit.test.ts`, `web/test/parts.test.ts` (head), `tests/e2e/audit.mjs`.

### 8.2 Reviewed only partially or by structure

- `apps/web/src/state/`: `commands.ts` (id cross-check only), `constraintOps.ts`, `sketchOps.ts`, `refImage.ts`, `imageMath.ts`, `templates.ts`, `parts.ts`, `measure.ts`, `inspect.ts`, `hints.ts`, `edgeChain.ts`, `sectionCurves.ts`, `dialogs.ts`, `prefs.ts` (first 60 lines).
- `apps/web/src/ui/*` (19 files) and `apps/web/src/viewport/*` (`Viewport.ts` constructor, dispose, disposal helpers, analysis entry points; `sketchTools.ts`, `looks.ts`, `theme.ts` not read). These were exercised through the nine browser suites and the probes, and searched for injection sinks, not read line by line.
- CSS (`styles/*`), `index.html`, icons: not reviewed.
- `docs/WHITTLE.md`, `docs/SELF_HOSTING.md`, `docs/AI_INTEGRATION.md`, `CONTRIBUTING.md`: grepped for specific claims.
- `deploy/*` scripts, `Dockerfile*`, `install.ps1`, `.github/workflows/installers.yml`, rest of `release.yml`: not reviewed (`deploy/install.sh` runs as root; worth its own pass).
- Unit tests other than those listed in 8.1, `tests/e2e/*.mjs` other than `audit.mjs`, `apps/server/tests/api.rs`: not read (the browser suites were run).

### 8.3 Not run

- Anything Rust: build, clippy, server tests, desktop tests, `tests/e2e/server.mjs`, PostgreSQL mode, SMTP, OIDC. All server/desktop findings are source-reading findings.
- The desktop app and its CSP behaviour; macOS and Linux behaviour; browsers other than Edge; real GPUs (the viewport ran on software GL).
- Fuzzing of STEP/STL parsers beyond a handful of malformed inputs; a large-model profile beyond the 1,500-feature and 600-circle runs; multi-tab behaviour; a deliberate worker crash.
- Third-party validators (glTF validator, slicers) for the exported files; I checked structure myself.

### 8.4 Everything marked UNVERIFIED

A-05 (export mesh size), D-01 (worker crash), D-03 (multi-tab autosave), F-01 (viewport leak), I-01 (proxy rate limits),
I-02 (upload memory), I-03 (desktop CSP / AI), I-05 to I-07 and I-09 (server/installer behaviour from reading), J-03 (clone cost),
Rust advisories (`cargo audit`), `cargo clippy` results, whole-repo Rust compile status, and the "Platforms" row of the feature matrix.

### 8.5 Environment notes

Node 26.1.0, npm 11.13, Rust 1.99 (MSVC target, no linker), Windows 11. I installed `@vitest/coverage-v8@4.1.11` with
`--no-save` to measure coverage (it is in `node_modules` only; `package.json` and the lockfile are unchanged). A
`vite preview` server I started on port 4173 was stopped at the end. `docs/AUDIT.md` was untracked before I started and is
untouched; a stray `Claude-2.cmd` appeared in the repo root during the session (I did not create it) and is also untouched. Measurement scripts live in `docs/audit-probes/`.
