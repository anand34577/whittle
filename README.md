# Whittle

**Open-source parametric 3D CAD for everyone: first-timers, makers, product designers, engineers, teachers and students.**
Sketch → Extrude → Fillet → Export. Use it as a desktop app (Windows, macOS, Linux), host it for your
team or family on your own server, or open it in any modern browser.

Whittle uses a real CAD kernel (OpenCascade, the B-rep engine family behind FreeCAD), so you get exact
solids, true fillets and STEP export, not just meshes. It's built to be easy to start with: the app always
tells you the next step, every value accepts formulas, and errors suggest a fix. And it's built to grow
with you: parameters, a full feature timeline, persistent references and a version history for every
design.

> Status: **0.7, preview.** Part modelling, sketch constraints, joints between bodies and a one-sheet 2D drawing
> export work end to end. Full assemblies (mates, bills of materials), sheet metal and CAM are on the
> [roadmap](PLAN.md#10-roadmap).

## Install

| System | One line |
|---|---|
| **Windows** (PowerShell) | `irm https://raw.githubusercontent.com/anand34577/whittle/main/install.ps1 \| iex` |
| **macOS, Linux** (Terminal) | `curl -fsSL https://raw.githubusercontent.com/anand34577/whittle/main/install.sh \| sh` |
| **Server** (Linux x86_64/arm64, bare metal or LXC) | `curl -fsSL https://raw.githubusercontent.com/anand34577/whittle/main/install.sh \| sh -s -- --server` |
| **Server** (Docker) | `docker run -d --name whittle -p 8080:8080 -v whittle-data:/data --restart unless-stopped ghcr.io/anand34577/whittle:latest` |

Upgrade by running the same line again (the server backs itself up first and rolls back if the new version doesn't start).
Uninstall: add `--uninstall` (macOS/Linux; `--server --uninstall [--purge]` for the server), or on Windows
`$env:WHITTLE_ACTION="uninstall"` before the PowerShell line.

Or download an installer from the [latest release](https://github.com/anand34577/whittle/releases/latest).
Step-by-step guides, configuration, single sign-on and troubleshooting are in the **[wiki](https://github.com/anand34577/whittle/wiki)**.

## Three ways to run it

| | Desktop app | Self-hosted server | Static web |
|---|---|---|---|
| For | one person, offline | teams, families, classrooms, several devices | trying it out, embedding |
| Sign-in | none | none, local accounts, single sign-on (OIDC), or both | none |
| Files | ordinary `.whittle` files anywhere on disk, native Open/Save dialogs, recent files, double-click to open | each person's design library with thumbnails | browser file access or downloads |
| Version history | every save keeps the previous copy (on your computer) | every save is a version on the server, with restore | every save keeps a copy in the browser |
| Get it | [Installation guide](https://github.com/anand34577/whittle/wiki/Installation): `.msi`/`.exe`, `.dmg`, `.AppImage`/`.deb`/`.rpm` | [Self-hosting guide](https://github.com/anand34577/whittle/wiki/Self-Hosting), [Docker](https://github.com/anand34577/whittle/wiki/Docker) | `npm run build`, serve `apps/web/dist` |

## What you can do

- **Sketch** on origin planes (offset or **tilted**) or any flat face: outline (straight, rounded corners or a smooth curve), **open paths**, rectangle (rounded, rotated), circle, ellipse, polygon, slot, **text** and **involute spur gears**. Snapping to points, centers, grid and alignments. **Type exact sizes while drawing.** Shapes inside shapes become holes automatically.
- **Bring in artwork:** **import an SVG** (logos, lettering, traced outlines from Inkscape, Illustrator, Figma) as editable sketch shapes, then extrude, emboss or engrave it.
- **Arrange sketch shapes:** duplicate, mirror, rotate 90°, copies around a circle (bolt circles) or in a row.
- **Create:** extrude (one side, symmetric or two different distances; **draft taper**; **twist**; new body, join, cut, keep overlap), revolve, **loft**, **sweep** along a path, **coils and screw threads**, **holes** (simple, counterbore, countersink, with ISO metric and UNC clearance, tap-drill and heat-set-insert sizes), quick box / cylinder / sphere / cone / torus / tube.
- **Parts library:** spur gear, hex nut, washer, standoff, L bracket, mounting plate, enclosure and lid, knob, name tag, vase, pulley. Each inserts as ordinary, fully editable features with named parameters.
- **Modify:** fillet and chamfer (click edges, or a face to take all its edges, or round every edge at once), shell, **draft faces**, **split**, **offset** (grow/shrink), **scale**, move / rotate / copy, combine bodies (join, cut, keep overlap), mirror, linear and circular patterns.
- **Parameters & formulas** everywhere: `width / 2 + 3 mm`, `2 * pi * r`, `atan(rise/run)`. Rename a parameter and every formula follows.
- **Timeline:** edit any step, suppress, roll back, **drag to reorder** (Whittle refuses moves that would break the design and says why), delete with a dependency warning. Fillets stay on their edges when upstream sketches change.
- **Inspect:** measure (distance, gap, angle, diameter, length, area), section view, **analysis**: overhangs (3D printing), **draft angle** (moulding and casting) and **zebra stripes** (surface quality), display styles, orthographic view, volume, area, size, and mass for 30 materials.
- **Appearance:** body colors and matte, satin, metal or clear finishes; save a high-resolution image.
- **Export:** **STEP** for other CAD, CNC and manufacturing; **glTF (GLB)** and **OBJ** for the web, AR, games and rendering; **3MF** and **STL** for 3D printing; **PLY** for scanning tools; **SVG** and **DXF** of any sketch for laser cutters, vinyl cutters, plotters and CAM. Import STEP and STL.
- **Never lose work:** unlimited undo, autosave and crash recovery, **version history with restore** on every platform, and a warning before a save would overwrite newer work from another device.
- **Ease of use:** a first-run question tunes the workspace (new to 3D, maker, engineer, designer, teacher/student); Ctrl+K command search ("round edges" finds Fillet), right-click radial menu, a hint line that always shows the next step, a guided first part, templates for engineering, product design, woodworking and making, view cube. Every control, dialog and tooltip is Whittle's own: no browser pop-ups.
- **Make it yours:** six themes plus *match system*, seven accent colors, density, interface size, reduced motion, and **mouse navigation like Fusion 360, SolidWorks, Onshape or Blender**.
- **AI assistant (optional):** describe a part or a change and it builds it with Whittle's own tools, as editable, undoable features. Works with **Claude**, **OpenAI** or a **local model** (Ollama, LM Studio). The same [design API](docs/AI_INTEGRATION.md) is open to scripts.
- **Self-hosted server:** accounts with email, password reset, **single sign-on with linking and account merging**, an **administration console** (people, invitations, SMTP email including unencrypted relays, notifications, activity log), and `backup` / `restore` / `migrate-db` / `doctor` commands.

## Quick start (from source)

```bash
npm install
npm run dev          # http://localhost:5173
```

| Command | What it does |
|---|---|
| `npm run dev` | Web app with hot reload |
| `npm run build` | Production web build → `apps/web/dist` |
| `npm test` | Unit + geometry tests (runs the real OCCT kernel in Node) |
| `npm run typecheck` | TypeScript, strict |
| `node tests/e2e/smoke.mjs <url>` | Browser test of the core flow (also `features.mjs`, `advanced.mjs`, and `server.mjs` against a server) |
| `cd apps/server && cargo test` | Server API tests (SQLite; set `WHITTLE_TEST_DATABASE_URL` for PostgreSQL) |

### Desktop app (Tauri 2)

Requires Rust plus the platform toolchain ([Tauri prerequisites](https://tauri.app/start/prerequisites/)). On Windows that means Visual Studio with the **Desktop development with C++** workload.

```bash
cd apps/desktop
npx tauri dev        # development window
npx tauri build      # installers for this OS
```

### Self-hosted server

```bash
npm run build
cargo run --release --manifest-path apps/server/Cargo.toml   # http://localhost:8080, SQLite in ./data
```

Bare metal, LXC (x86_64 / arm64), Docker, PostgreSQL, single sign-on, reverse proxies and backups:
**[docs/SELF_HOSTING.md](docs/SELF_HOSTING.md)**.

## Releases

Push a tag like `v0.2.0` and [`.github/workflows/release.yml`](.github/workflows/release.yml) builds and
publishes: desktop installers for Windows x64, macOS (universal), Linux x64 and arm64; static server
builds for Linux x86_64 and aarch64 with an installer; a multi-arch Docker image on GHCR; and
`SHA256SUMS`. See [CONTRIBUTING.md](CONTRIBUTING.md#releasing).

## Repository layout

```
packages/core     Document model, unit-aware formulas, undo history, file format (.whittle)
packages/kernel   Geometry: OCCT (WASM) in a Web Worker, regeneration engine, persistent references, exporters
apps/web          The app: React UI, Three.js viewport, sketch tools, design system, platform layer
apps/desktop      Tauri 2 shell (Rust): native files, dialogs, recent files, local version history
apps/server       Rust/Axum server: accounts (none / local / OIDC), design storage with versions, SQLite or PostgreSQL
deploy            systemd and OpenRC services, settings template, installer, release Dockerfile
tests/e2e         Browser tests: smoke.mjs (core flow), features.mjs (tools), server.mjs (accounts and storage)
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it fits together, [PLAN.md](PLAN.md) for the product plan,
and [docs/AI_INTEGRATION.md](docs/AI_INTEGRATION.md) for the design API.

## Keyboard

`S` sketch · `E` extrude · `R` revolve · `D` hole · `F` fillet · `M` move · `J` combine · `I` measure · `P` parts library · `H` home view · `Shift+H` fit · `Ctrl+K` find any command · `Ctrl+I` AI assistant · `Ctrl+,` settings · `Ctrl+S` save · `Ctrl+Z` undo · `Esc` cancel / finish sketch · right-click for quick actions · `?` all shortcuts.
In a sketch: `L` line · `A` path · `R` rectangle · `C` circle · `E` ellipse · `P` polygon · `O` slot · `T` text · `G` gear · `V` select · `Ctrl+D` duplicate · `Shift+R` rotate · `X` construction.

## License

[MPL-2.0](LICENSE). Third-party components are listed in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
