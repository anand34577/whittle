# Whittle: Product & Technical Plan

> **Name:** Whittle (shaping material by hand, simply). **License:** MPL-2.0.
> **Audience:** beginners, hobbyists & 3D-printing users, and professional mechanical designers. Defaults are simple and guided; depth is one click away ("progressive disclosure").
> **Goal:** an open-source parametric 3D CAD app in Fusion 360's category: lighter, easier to install, easier to learn, nicer to use. It runs on Windows, macOS and Linux, and in any modern browser when hosted.
> **Status (v0.2):** Phases 0–1 are done; 3 and 4 are nearly complete and 2 is partly done (constraints are next). See the [status table](#status).

---

## 1. Product principles

1. **The viewport is the product.** Chrome recedes; the model gets the space.
2. **Always show the next step.** A hint line derived from state tells you what Whittle expects.
3. **Live preview, never modal.** Feature panels edit the model in real time.
4. **Errors explain and suggest.** "A 50 mm fillet is too large. About 9.8 mm fits. [Use 9.8 mm]"
5. **Nothing is lost.** Unlimited undo, autosave, session recovery.
6. **Do fewer things, well.** No CAM/FEA/generative design in 1.0; plugins later.
7. **Local-first.** Fully offline, no account. The server is optional.

## 2. Scope

### v1.0: Part design
| Area | Features | Status |
|---|---|---|
| Sketch | outline (straight, rounded corners, smooth spline), rectangle (rounded, rotated), circle, ellipse, polygon, slot, text, spur gear; construction; snapping (points, centers, mids, grid, H/V alignment); typed dimensions; automatic holes (touching edges included, with a warning when a hole would split a shape); shaded solid regions; duplicate/mirror/rotate/circular and row copies | ✅ |
| Sketch, next | arcs, trim/offset, **constraints via PlaneGCS** (coincident, tangent, equal…), DOF colouring | ⏳ |
| Features | extrude (one side/both, new/join/cut/intersect), revolve, loft, holes (simple/counterbore/countersink), fillet, chamfer, shell, move/rotate/copy, combine, box/cylinder/sphere/cone/torus/tube | ✅ |
| Features, next | sweep, threads, draft, thicken, split | ⏳ |
| Parts library | gear, nut, washer, standoff, L bracket, plate, open box + lid, knob, name tag, vase, pulley; inserted as editable features with prefixed parameters | ✅ |
| Repeat | mirror, linear/circular pattern | ✅ |
| Construction | origin planes, face sketches with offset | ✅ · offset/angled planes, axes ⏳ |
| Parameters | named, unit-aware formulas, dependency-checked | ✅ |
| Timeline | edit, suppress, roll back (drag marker), delete with dependency warning, drag to reorder with dependency check | ✅ |
| Inspect | volume, area, size, mass by material; measure (distance, parallel gap, angle, diameter); section view; print check (overhangs); display styles; orthographic; image export | ✅ |
| I/O | .whittle, export 3MF/STL/STEP, import STEP/STL (drag and drop), SVG into sketches, sketch export to SVG/DXF | ✅ |
| Interaction | Ctrl+K palette, right-click radial menu, grouped toolbar with full menus, floating view dock, context bar | ✅ |

### v1.x
Assemblies & joints, 2D drawings (OCCT HLR → PDF/DXF), sheet metal, direct editing for imported STEP.
### v2+
Real-time collaboration (Yjs/yrs), plugin & scripting API, optional AI assistant (plugin, off by default).

> Fusion `.f3d` is proprietary and can't be opened. Users move models over by exporting STEP from Fusion.

## 3. Technology

| Layer | Choice | Why |
|---|---|---|
| Geometry kernel | **OpenCascade (OCCT)** in **WebAssembly** via `replicad` + `replicad-opencascadejs` | The only mature open-source B-rep kernel; prebuilt WASM let Phase 0 skip a multi-hour custom OCCT build. A custom slimmer build is planned. |
| Sketch solver (next) | **PlaneGCS** (FreeCAD) → WASM | Proven; LGPL (SolveSpace is GPL) |
| App language | TypeScript (strict) | One codebase for web + desktop |
| UI | React 19 + Vite 8; custom design system (CSS tokens, own icon set) | No template look |
| Viewport | Three.js (imperative engine, WebGL2; WebGPU later) | Mature, fast, on-demand rendering |
| State | zustand + Immer patches | Undo/redo, sessions, future collab |
| Desktop | **Tauri 2** | ~15–40 MB installers vs 150 MB+ Electron |
| Server (optional) | **Rust + Axum**, one binary, SQLite or PostgreSQL, Docker | Serves app, accounts (none / local / OIDC), design storage with versions |
| Tests | Vitest (incl. real OCCT in Node), Playwright smoke test | Geometry golden tests |

**Licensing:** MPL-2.0. OCCT is LGPL-2.1 and ships as a separate, replaceable `.wasm`. See `THIRD_PARTY_LICENSES.md`.

**Monorepo note:** the D: drive is exFAT (no symlinks), so instead of npm workspaces the packages are wired with Vite/TS path aliases from one root `package.json`. The folder layout is the same.

## 4. Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Key points:
- The UI thread never runs geometry: OCCT lives in a Web Worker behind the `KernelHost` interface (a native sidecar or remote kernel can be added later).
- The document is data: parameters plus an ordered feature timeline. Geometry is derived.
- The regeneration engine caches every step by input hash, so editing step 12 of 60 rebuilds only 12 onwards.
- Failing features don't break the model; they report a friendly message and, where possible, a fix.
- **Persistent references** (the topological naming problem): fingerprints (position + orientation + type) re-resolved on each rebuild; ambiguity becomes a warning, never a silent wrong pick. Tested: change an upstream sketch and the fillet survives.
- `.whittle` = ZIP{manifest.json, document.json, thumbnail.png} with forward migrations.

## 5. UX strategy

Layout: title bar → intent-grouped toolbar → browser | **viewport** | properties → timeline → hint line.
- **Ctrl+K command palette** with synonyms ("round edges" → Fillet, "hollow" → Shell).
- **Contextual action bar:** select a face → Sketch here / Shell; edges → Fillet / Chamfer; sketch → Extrude / Revolve.
- **Typed dimensions while drawing**: start typing; Tab switches W/H; Enter places.
- **Scrubbable labels:** drag any field label to change the value; arrows nudge it (Shift ×10, Alt ×0.1).
- **Guided first part** checklist, starter templates, start screen with session recovery.
- **View cube**, home/fit views, turntable navigation that never rolls the horizon.
- Accessibility: keyboard-reachable controls, focus rings, reduced motion respected, no colour-only states.

## 6. Visual design: "Drafting Table"

Avoided on purpose: purple-blue gradients, glassmorphism, default shadcn/Tailwind look, emoji icons.
- Colour: warm graphite / paper neutrals; one signal accent, **marking orange**; **blueprint cyan** reserved for selection.
- Type: IBM Plex Sans (UI) + JetBrains Mono with tabular numerals for every number.
- Shape: 2–4 px radii, 1 px hairlines, ruler tick marks on numeric fields.
- Custom icon set (20 px grid, 1.5 px stroke, isometric hints).
- Themes: **Graphite** (dark, default) and **Paper** (light), from one token file; the viewport palette matches.

## 7. Repository

```
packages/core   packages/kernel   apps/web   apps/desktop   apps/server   tests/e2e   docs
```

## 8. Delivery

| Target | Package |
|---|---|
| Windows | MSI / NSIS (Tauri), WebView2 bootstrapper embedded |
| macOS | DMG (sign + notarize in CI) |
| Linux | AppImage, deb, rpm (Flatpak later) |
| Browser | static build, installable as PWA (manifest next) |
| Self-host | `docker run -p 8080:8080 -v whittle-data:/data whittle` |

CI (`.github/workflows/ci.yml`) runs typecheck, unit and geometry tests, the web build, the server build, and desktop bundles on all three OSes.

## 9. Quality

- Geometry tests run the real OCCT kernel in Node: volumes, face counts, statuses, reference survival, fix suggestions, export validity.
- Expression, history and file-format unit tests.
- Browser smoke test: start screen → template → parameter change → sketch with typed size → extrude → fillet → 3MF download → theme switch, failing on any console error.
- No telemetry by default.

## 10. Roadmap

| Phase | Content | Status |
|---|---|---|
| 0. Spike | OCCT WASM in a worker, sketch → extrude → fillet → edit survives | ✅ done |
| 1. Foundations | design system, document model, undo, regen cache, viewport, file format | ✅ done |
| 2. Sketcher | tools, snapping, typed dims, text, gears, splines, arrange ✅ · **constraints (PlaneGCS)**, arcs, trim ⏳ | in progress |
| 3. Part features | extrude, revolve, loft, holes, fillet, chamfer, shell, move, combine, patterns ✅ · sweep, threads, draft ⏳ | in progress |
| 4. I/O & polish | export, import STEP/STL, measure, section view, print check, parts library ✅ | done |
| 4b. Platforms | desktop file handling + local history, self-hosted accounts/storage/versions, release pipeline | ✅ done |
| 5. Beta 0.9 | code-signed installers, auto-update, docs site, PWA | next |
| 6. v1.0 | performance, accessibility audit, translations | |
| 7. v1.x | assemblies, drawings, sheet metal, direct edit | |
| 8. v2 | collaboration, plugins, scripting, optional AI | |

## 11. Risks

| Risk | Mitigation |
|---|---|
| Reference breakage on edit | fingerprint resolution + warnings + tests (done); add face-history naming from `BRepTools_History` |
| OCCT failures | friendly messages + fix search (done); fuzzy-boolean retries |
| WASM performance on big models | worker + step cache (done); LOD meshing; native sidecar option |
| Linux WebKitGTK graphics | WebGL2 baseline; test early |
| LGPL | separate replaceable WASM (done) |
| Scope creep | principle 6, plugin API |

<a id="status"></a>
## 12. Status of this build (v0.2)

Working and verified: web app, kernel, every feature marked ✅ above; 53 unit/geometry tests; 7 server API tests (SQLite locally, PostgreSQL in CI); browser suites for the core flow (8 steps), tools (18 steps) and server mode (sign-up, save, versions, restore, sign-in) passing against production builds; desktop shell compiled and unit-tested.
CI builds and tests everything on each push; `.github/workflows/release.yml` publishes desktop installers (Windows, macOS universal, Linux x64/arm64), static server builds (Linux x86_64/aarch64) and a multi-arch Docker image from a version tag.
Not yet: code signing certificates (macOS builds are ad-hoc signed), auto-update.
