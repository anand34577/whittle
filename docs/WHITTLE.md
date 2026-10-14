# Whittle: Complete Application Reference

**Version:** 0.2.1 · **License:** MPL-2.0 · **Type:** open-source parametric 3D CAD for part design

Whittle is a parametric 3D CAD application in the same category as Fusion 360, built to be lighter, easier to install and easier to learn. It runs in any modern browser, as a desktop app (Windows, macOS, Linux via Tauri), or self-hosted on a server.

**Audience:** beginners, hobbyists and 3D-printing users, and professional mechanical designers. The defaults are simple and guided; more depth is one click away.

---

## Contents

1. [Getting started](#1-getting-started)
2. [Core concepts](#2-core-concepts)
3. [The interface](#3-the-interface)
4. [Sketching](#4-sketching)
5. [3D features](#5-3d-features)
6. [Parts library](#6-parts-library)
7. [Templates](#7-templates)
8. [Parameters and formulas](#8-parameters-and-formulas)
9. [Timeline and history](#9-timeline-and-history)
10. [Selection and picking](#10-selection-and-picking)
11. [Inspect tools](#11-inspect-tools)
12. [View and display](#12-view-and-display)
13. [Appearance](#13-appearance)
14. [Files, import and export](#14-files-import-and-export)
15. [Errors, warnings and fixes](#15-errors-warnings-and-fixes)
16. [Keyboard and mouse reference](#16-keyboard-and-mouse-reference)
17. [Architecture](#17-architecture)
18. [Testing](#18-testing)
19. [Known limitations](#19-known-limitations)
20. [Roadmap](#20-roadmap)

---

## 1. Getting started

### Requirements

| Use | Needs |
|---|---|
| Web app (development) | Node.js 20+ (tested with 26) |
| Desktop app | Rust + cargo, plus platform build tools (on Windows: Visual Studio "Desktop development with C++") |
| Self-hosted server | Rust + cargo, or Docker |

### Commands (run from the project root)

| Command | What it does |
|---|---|
| `npm install --no-bin-links` | Installs dependencies (the `--no-bin-links` flag is needed on drives without symlink support, such as exFAT) |
| `npm run dev` | Starts the app at http://localhost:5173 |
| `npm run build` | Production build into `apps/web/dist` |
| `npm run preview` | Serves the production build at http://localhost:4173 |
| `npm test` | Unit and geometry tests (Vitest, real OpenCascade engine in Node) |
| `npm run typecheck` | TypeScript type check |
| `npm run test:e2e` | Browser tests (needs the dev server running and Edge or Chrome installed) |

### Desktop and server

- **Desktop:** in `apps/desktop`, run `npx tauri dev` or `npx tauri build`. The installer registers `.whittle` files so they open on double-click.
- **Server:** in `apps/server`, run `cargo build --release`, or use the `Dockerfile`. Accounts, single sign-on, databases and every setting are described in [SELF_HOSTING.md](SELF_HOSTING.md).

### First launch

Every launch opens the **start screen**, which offers:

- **New design** in millimetres or inches.
- **Open a file** (`.whittle`).
- **Continue where you left off** (appears only if an autosave exists).
- **Start from a part** (opens the parts library).
- **Make your first part:** a two-minute guided walkthrough.
- **Templates:** Mounting plate, Project box, Control knob.

---

## 2. Core concepts

| Concept | Meaning |
|---|---|
| **Design** | One document: its parameters, an ordered list of features, and body metadata. Saved as a `.whittle` file. |
| **Feature** | One step in the design's history (a sketch, an extrude, a fillet…). Every feature can be edited later. |
| **Sketch** | A 2D drawing on a plane or on a flat face. Its closed shapes become profiles for 3D features. |
| **Body** | A solid. Features either create a new body or change an existing one. |
| **Parameter** | A named value such as `width = 80 mm` that any field can use in a formula. |
| **Timeline** | The row of features at the bottom. The model is rebuilt from it after every change. |
| **Session** | While a feature's panel is open, changes preview live. **OK** (or Enter) applies them as one undo step; **Cancel** (or Esc) discards them. |

**Parametric means:** the document stores *instructions*, not geometry. Change a parameter or an early feature, and everything after it rebuilds automatically. Later features stay attached to the right edges and faces.

**Units:** the design has a length unit (mm, cm, m, in or ft). Internally everything is millimetres and radians. Plain numbers typed into a field use the design's unit (or degrees for angles).

---

## 3. The interface

```
┌─────────────────────────────── Title bar ───────────────────────────────┐
├──────────────────────────────── Toolbar ────────────────────────────────┤
│ Browser │                  3D viewport                     │ Properties │
│ (left)  │   context bar (top) · view cube (top right)       │  panel     │
│         │   view dock (bottom) · section card (bottom left) │ (right)    │
├──────────────────────────────── Timeline ───────────────────────────────┤
└────────────────────────────── Status bar ───────────────────────────────┘
```

### Title bar

- File buttons: New, Open, Save, Export, then Undo and Redo (their tooltips name the step).
- **Design name:** click to rename. A dot shows "Saved" or "Unsaved".
- **Find a command** (Ctrl+K), Parameters, theme switch (Graphite dark / Paper light), Help (start screen).

### Toolbar (modelling mode)

Tools are grouped. Each group label is also a menu listing **every** tool in that group, with a short description and shortcut.

| Group | Buttons | Also in the group menu |
|---|---|---|
| Start | **Sketch** | |
| Create | Extrude, Revolve, Loft, Hole | Import STEP / STL |
| Shapes | Box, Cylinder, Sphere | Cone, Torus, Tube |
| Modify | Fillet, Chamfer, Shell, Move / Copy | Combine, Mirror, Pattern |
| Inspect | Measure, Section, Print check | Display styles, Orthographic, Save image |
| Library | Parts | |
| Export | Export… | Export STEP, Export 3MF, Export STL, Save image, Version history |

Buttons are greyed out when they don't apply (for example, Fillet before any body exists).

### Toolbar (sketch mode)

The toolbar turns orange-tinted and shows sketch tools:

| Group | Tools |
|---|---|
| Draw | Line, Rectangle, Circle, Ellipse, Polygon, Slot |
| Special | Text, Gear, Import SVG (menu adds: Export sketch as SVG, Export sketch as DXF) |
| Arrange | Select, Duplicate, Mirror, Rotate 90°, Construction (menu adds: Mirror up/down, Delete) |
| | **Finish sketch** button on the right |

### Browser (left panel)

- **Parameters:** each one with its current value; click to open the Parameters dialog.
- **Origin:** XY, XZ and YZ planes; click one to start a sketch on it.
- **Bodies:** colour swatch, name, show/hide eye. Click to select; double-click to edit the feature that made it.
- **Sketches:** click to select, double-click or the pencil to edit. Sketches already used by a feature appear dimmed.

### Properties panel (right)

Shows one of three things:

1. **Feature editor** while a feature is open: its fields, any warning or error with a fix button, and OK / Cancel.
2. **Sketch panel** while sketching: plane offset and tips, or the editor for the selected shape (sizes, solid/hole mode, construction, Arrange tools, Delete).
3. **Inspector** otherwise: for the whole design (features, bodies, volume, mass) or for a selected body (name, colour, finish, volume, mass, size, area), face (surface type, area) or edge (curve type, length).

**Mass** is calculated for a chosen material, in g or kg: plastics (PLA, PETG, ABS, nylon, SLA resin, acrylic), metals (aluminium, steel, stainless steel, brass, copper, titanium), and wood and other materials (pine, oak, plywood, MDF, glass, concrete).

### Viewport overlays

| Overlay | Where | Purpose |
|---|---|---|
| Context bar | top centre | Actions for the current selection (e.g. a face offers Sketch here, Hole, Shell, Measure) |
| Banner | top centre | Shown while picking a sketch plane or measuring, with Cancel / Done |
| View cube | top right | Click a face to look at it; home button for the default view |
| View dock | bottom centre | Display styles, Measure, Section, Print check, Grid, Orthographic, Fit, Save image |
| Section card | bottom left | Section axis, flip and position slider |
| Measure card | near the measured item | Measurement results |
| Radial menu | where you right-clicked | Up to 8 actions for what was clicked |
| Busy bar / loading | top / centre | Rebuild in progress / engine starting |

### Timeline (bottom)

One icon per feature, in order. A red or yellow dot marks an error or warning. Details in [section 9](#9-timeline-and-history).

### Status bar

- Left: the **hint line**, which always says what to do next for the current tool or selection.
- Right: engine state ("Loading engine", "Building", "Built in N ms") and the design unit.

### Command palette (Ctrl+K)

Type what you want in plain words. Every command has synonyms, so for example:

| You type | It finds |
|---|---|
| "round edges" | Fillet |
| "hollow" | Shell |
| "drill", "m3", "screw" | Hole |
| "bolt circle" | (shape Arrange tools) |
| "slicer", "bambu", "prusa" | Export 3MF |
| "transparent" | X-ray |

Arrow keys move, Enter runs, Esc closes. Only commands that apply right now are listed.

### Guided first part (coach)

A step-by-step overlay that walks a new user through sketch → rectangle → extrude → fillet.

---

## 4. Sketching

### Starting a sketch

- Press **S** (or the Sketch button), then click an origin plane or any flat face.
- Or select a flat face first, then press S.
- Or click a plane under *Origin* in the browser.

The camera turns to face the sketch plane, the grid moves onto it and bodies become see-through.

**Sketch plane frame:**

| Plane | X direction | Y direction | Normal |
|---|---|---|---|
| XY | world X | world Y | +Z |
| XZ | world X | world Z | −Y |
| YZ | world Y | world Z | +X |
| A flat face | world X projected onto the face (or horizontal on walls) | perpendicular to X in the face | the face's outward normal |

On a face, the sketch origin is the **world origin projected onto the face's plane**. It doesn't move when the face changes shape. Any sketch can be offset along its normal (the **Plane offset** field).

### Drawing tools

Every tool works with **two clicks** or **press, drag, release**. While drawing, **start typing a number** to enter an exact size; **Tab** moves to the second size, **Enter** places the shape, **Esc** cancels.

| Tool | Key | Input | Typed sizes | Editable fields |
|---|---|---|---|---|
| Line (outline) | L | Click each point; click the first point (or press Enter) to close; Backspace removes the last point | Length, then angle | Points; Smooth curve; Round corners |
| Rectangle | R | Two opposite corners | Width, Height | Width, Height, X, Y, Position from (Corner/Center), Rounded corners, Rotation |
| Circle | C | Centre, then radius | Diameter | Diameter, Centre X, Y |
| Ellipse | E | Centre, then a corner of its bounding box | X radius, Y radius | Radius X, Radius Y, Centre, Rotation |
| Polygon | P | Centre, then a corner (default 6 sides) | Radius | Radius, Sides (3–64), Centre, Rotation |
| Slot | O | Centre of first end, then second end | Length, angle | Length, Width, Centre, Rotation |
| Text | T | One click where the text starts; the text box in the panel takes focus | | Text, Size, Rotation, X, Y, Bold |
| Gear | G | Centre, then drag the size (teeth = pitch diameter ÷ module, module 2) | Pitch diameter | Teeth (6–200), Module, Bore Ø, Centre |
| Select | V | Click a shape to select; drag to move it | | |

**Text** uses IBM Plex Sans (regular or bold). Its outline in the sketch is a dashed box; the real letters show in the shaded fill.

**Gears** are involute spur gears with a 20° pressure angle and standard proportions (addendum 1 × module, dedendum 1.25 × module). Two gears mesh when they share a module; their centre distance is module × (teeth A + teeth B) ÷ 2.

**Outlines:** *Smooth curve* draws a closed spline through the points. *Round corners* rounds every corner with one radius.

### Snapping

- Snaps to endpoints, midpoints, centres, the origin and the grid (half the grid spacing).
- Horizontal and vertical alignment guides appear when the cursor lines up with existing points.
- The snap marker's shape shows what it snapped to.
- Hold **Alt** to place freely, without snapping.

### Solids and holes

Each shape has a **Solid or hole** mode:

- **Automatic** (default): a shape that lies inside another shape becomes a hole. Shapes that touch the outer shape's edge count as inside.
- **Solid:** always adds material.
- **Hole:** always removes material.

A gear's bore is always a hole in that gear. The **shaded area** in the sketch shows exactly what will become solid.

If a hole touches its outline in two separate places (which would split the shape in two), the sketch shows a warning suggesting a slightly smaller hole.

### Construction shapes

**X** toggles construction. Construction shapes are dashed guides for snapping only; they never become solid.

### Arrange tools (selected shape)

| Action | Key | Result |
|---|---|---|
| Duplicate | Ctrl+D | Copy offset by +10, −10 and selected |
| Rotate 90° | Shift+R | Rotates the shape about its own centre |
| Mirror ↔ | | Mirrored copy across the sketch's vertical axis |
| Mirror ↕ | | Mirrored copy across the sketch's horizontal axis |
| Copies around origin | | *N* copies evenly spaced around the sketch origin (e.g. a bolt circle) |
| Row → / ↑ | | *N* copies spaced by *Gap* along X or Y |
| Delete | Del | Removes the shape |

These work on shapes whose positions are plain numbers. If a position comes from a formula, Whittle leaves it unchanged and explains why, so formulas are never overwritten. Dragging follows the same rule.

### Finishing

**Esc** switches back to the Select tool; a second Esc (or **Finish sketch**) closes the sketch as one undo step. **Cancel** in the panel discards all changes. An empty new sketch is discarded automatically.

---

## 5. 3D features

Every feature opens a panel with live preview. Fields accept numbers or formulas. **Drag a field's label to scrub** the value. **Enter** applies, **Esc** cancels.

### Body operations (Result)

Extrude, Revolve, Loft and the quick shapes have a **Result** choice:

| Option | Effect |
|---|---|
| New body | Creates a separate body |
| Join | Adds to a body (default: the most recent) |
| Cut | Removes material (default: every body it touches) |
| Keep overlap | Keeps only the overlapping volume |

A **Body** selector picks a specific target for Join, Cut or Keep overlap.

### Feature reference

| Feature | Key | How to start | Fields |
|---|---|---|---|
| **Extrude** | E | Uses the selected sketch, or the newest unused one. On a face sketch it defaults to Join | Profile, Distance, Direction (One side / Both sides), Flip, Result, Body |
| **Revolve** | R | Same sketch rule | Axis (sketch vertical or horizontal), Angle (up to 360°), Result |
| **Loft** | | Selected sketches (Shift-click several), or the two newest unused sketches. Click sketches to add or remove profiles | Profiles in order, Add, Straight sides (ruled), Result. Each profile must be a single closed shape |
| **Hole** | D | Select a flat face (the click point becomes the first hole), or click a face after starting. Each click on the face adds a hole | Type (Simple / Counterbore / Countersink), Diameter, Through all or Depth, Head Ø, Head depth (counterbore), position of each hole (X, Y) |
| **Fillet** | F | Select edges first, or click them after starting (click again to deselect) | Radius |
| **Chamfer** | | Same as fillet | Distance |
| **Shell** | | Click the face(s) to remove (the open side) | Wall thickness |
| **Move / Copy** | M | Selected body or the newest one; click a body to change it | X, Y, Z move; Rotate around X/Y/Z by Angle (about the body's own centre); Keep the original (make a copy) |
| **Combine** | J | Selected bodies (first = target, rest = tools). Click bodies to set the target, then toggle tools | Operation (Join / Cut / Keep overlap), Target, Tools, Keep tool bodies |
| **Mirror** | | Selected body or the newest | Body, Mirror plane (YZ, XZ, XY), Merge with the original |
| **Pattern** | | Selected body or the newest | Type (In a row / Around an axis), Direction or axis (X, Y, Z), Count (2–200), Spacing or Total angle, Merge copies |
| **Import** | | Import STEP / STL, or drop a file | Scale (e.g. 25.4 converts a part modelled in inches) |

**Hole details:**

- Hole positions are measured on the face from the world origin projected onto the face (on a top face, X and Y equal world X and Y).
- Diameter hint: clearance for M3 = 3.4 mm, M4 = 4.5 mm, M5 = 5.5 mm.
- Countersinks are 90°, with the head diameter at the surface.
- A hole that lands off the body is reported as a warning ("Hole 2 is off the body").

### Quick shapes

All sit on the XY plane at the given position (Z is the base).

| Shape | Fields (defaults) |
|---|---|
| Box | Width 40, Depth 30, Height 20 (centred on X, Y) |
| Cylinder | Radius 15, Height 20 |
| Sphere | Radius 15 (resting on Z) |
| Cone | Bottom radius 15, Top radius 0 (0 = pointed; any value = truncated), Height 30 |
| Torus | Ring radius 20, Tube radius 5 |
| Tube | Outer radius 15, Inner radius 11, Height 20 |

Every shape also has X, Y, Z position and the Result options.

---

## 6. Parts library

Open it with **P**, the toolbar's **Parts** button, or **Start from a part** on the start screen. Filter by category (Mechanical, Fasteners, Enclosures, Everyday) or search.

Each part inserts as **ordinary features** with its own parameters, prefixed with the part name and a number (`gear1_teeth`, `gear2_teeth`, …), so it stays fully editable. Inserting is a single undo step. If bodies already exist, the new part is placed to the right of them with an editable **Place** move step, and the view re-fits.

| Part | Category | Parameters (defaults) | Built from |
|---|---|---|---|
| Spur gear | Mechanical | teeth 24, module 2 mm, thickness 8 mm, bore 5 mm | Gear sketch + extrude |
| Hex nut | Fasteners | across_flats 5.5 mm, height 2.4 mm, hole 3.2 mm (M3) | Hexagon + circle + extrude |
| Washer | Fasteners | outer 10 mm, inner 5.3 mm, thickness 1 mm | Two circles + extrude |
| Hex standoff | Fasteners | across_flats 5 mm, length 10 mm, hole 2.5 mm | Hexagon + circle + extrude |
| L bracket | Mechanical | length 40, height 30, width 20, thickness 4, hole 4.5 mm (M4) | L profile extruded both sides + a hole cut in each leg |
| Mounting plate | Mechanical | width 60, depth 40, thickness 3, hole 3.4 (M3), inset 5 mm | Rounded rectangle with four corner holes |
| Open box | Enclosures | length 70, width 50, height 30, wall 2 mm | Box + shell (top open) |
| Box lid | Enclosures | length 70, width 50, wall 2, fit_gap 0.2 mm | Plate + lip that fits inside the open box |
| Round knob | Everyday | diameter 30 mm, height 16 mm, ridges 18, shaft 6.2 mm | Ridged (gear-shaped) profile + blind shaft hole |
| Name tag | Everyday | width 70, height 24, thickness 3 mm | Rounded plate with key-ring hole + raised bold text "Whittle" |
| Vase | Everyday | height 90, radius 24, wall 1.6 mm | Loft through four circles + shell (top open) |
| Pulley | Mechanical | radius 20, width 10, groove 3, bore 5 mm | V-groove profile revolved |

---

## 7. Templates

Templates replace the current design with a complete, editable example:

| Template | What it shows |
|---|---|
| Mounting plate | Parameters (`width`, `depth`, `thickness`, `hole`, `inset`), rounded plate, four holes driven by formulas, a centre slot |
| Project box | A 3D-printable enclosure: box with rounded corners, shelled to 2 mm walls, driven by length, width, height and wall parameters |
| Control knob | A revolved profile with a shaft hole, built from a sketch |

---

## 8. Parameters and formulas

Open with the **fx** button, Ctrl+K "Parameters", or the browser's Parameters section. Each parameter has a **name**, a **formula**, a **kind** (length, angle, count…) and an optional **comment**. Its value shows next to it, and errors appear immediately.

**Any field in the app accepts a formula**, for example:

```
width / 2 + 3 mm
2 * pi * r
atan(rise / run)
hole / 2
-(depth / 2 - inset)
30°
```

| Supported | Details |
|---|---|
| Operators | `+ - * / ^`, parentheses, unary minus |
| Units | `mm`, `cm`, `m`, `in`, `ft`, `"` (inches), `deg`, `°`, `rad` |
| Functions | `sin cos tan asin acos atan atan2 sqrt abs round floor ceil min max` |
| Constants | `pi`, `tau` |
| Unit checking | Adding a length to an angle is an error, with a clear message |
| Bare numbers | Use the field's unit (the design unit for lengths, degrees for angles) |
| Safety | Names are validated, and circular references are detected and reported |

Changing a parameter rebuilds everything that uses it.

---

## 9. Timeline and history

- **Click** a step to select what it made; **double-click** to edit it.
- **Right-click** a step:
  - **Edit**
  - **Turn off (suppress)** / **Turn back on**
  - **Roll back to before this**
  - **Move earlier** / **Move later**
  - **Delete**: warns and lists the later steps that depend on it.
- **Drag a step** to reorder the timeline. Moves that would break the design (a step placed before something it uses) are refused with the reason.
- **Rollback marker:** drag the orange marker to rebuild only up to that point. New features are inserted at the marker. Buttons: go to start, step back, step forward, go to end.
- Step states: OK, warning (yellow dot), error (red dot), suppressed, rolled back (greyed).

**Undo / redo:** unlimited, with named steps ("Undo Fillet 1"). A whole feature session or sketch session is one undo step; inside an open session, Undo steps back through that session's own changes.

**Rebuild engine:**

- Each step's result is cached, so editing feature #12 of 60 only rebuilds from #12.
- Panels preview at lower mesh quality while open and rebuild at full quality afterwards.
- Geometry runs in a background worker, so the interface never freezes.

**Stable references:** fillets, chamfers, shells, holes and face sketches remember their edges and faces by geometric fingerprint (position, direction, type, size), not by index. They re-attach after upstream edits. If the match is ambiguous, the feature shows a warning asking you to check it.

---

## 10. Selection and picking

- **Click** a face, edge or sketch to select it. **Shift**- or **Ctrl**-click adds or removes.
- **Hover** highlights what will be picked. Edges are easy to hit (a generous pick radius), and edges hidden behind faces can't be picked.
- In a **section view**, the cut-away part can't be picked.
- While a feature is open, clicks feed that feature:

| Open feature | A click picks |
|---|---|
| Fillet / Chamfer | Edges (toggle) |
| Shell | Faces to remove (toggle) |
| Hole | A point on a flat face (adds a hole) |
| Loft | Sketches (toggle, in order) |
| Combine | First the target body, then tool bodies (toggle) |
| Move / Mirror / Pattern | The body to work on |

Edge and face picks during these features refer to the model as it was **before** the feature, shown as a faint outline, so you can re-pick an edge the fillet has already rounded.

**Body commands for a selection:** Hide, Isolate (show only these), Show all bodies, Delete (removes the feature that created the body).

---

## 11. Inspect tools

### Measure (I)

| Picks | Results |
|---|---|
| One edge | Length; for circles and arcs also Diameter and Radius |
| One face | Area and surface type |
| One body | Size (X × Y × Z) and volume |
| Two items | Distance between the clicked points, ΔX ΔY ΔZ, and the angle between them |
| Two parallel flat faces | The perpendicular gap between them |

A third click starts a new measurement. A blue dimension line with end points is drawn in the view. **Esc** or **Done** leaves measure mode.

### Section view

Slices the **view** (the model is not changed). Choose the X, Y or Z axis, **Flip** the side that's kept, and drag the slider through the model. Cut surfaces are drawn in the accent colour so the material is easy to read.

### Print check

Colours faces red where they point downward more than 45° from vertical and aren't on the build plate: these are the overhangs that usually need support when 3D printing.

### Inspector numbers

Volume (cm³ or in³), mass for the chosen material, size, surface area, feature count, body count.

---

## 12. View and display

**Navigation:**

| Action | Mouse |
|---|---|
| Orbit | Left-drag (in a sketch: right-drag) |
| Pan | Right-drag or middle-drag |
| Zoom | Wheel (zooms toward the cursor) |
| Orbit (alternative) | Shift + middle-drag |

The camera orbits around the vertical (Z) axis and never tilts the horizon. Views animate smoothly (instantly if the system asks for reduced motion).

| Command | Key | Effect |
|---|---|---|
| Home view | H | Isometric view, fitted |
| Fit to view | Shift+H | Fit the visible bodies, keeping the angle |
| View cube | | Front, back, left, right, top, bottom |
| Look at sketch | (automatic) | Faces the sketch plane when a sketch opens |

**Display styles:**

| Style | Shows |
|---|---|
| Shaded with edges | Default |
| Shaded | No edge lines |
| Wireframe | Edges only |
| X-ray | See-through bodies with edges |

**Other view options:**

- **Grid:** show or hide; spacing adapts to the zoom level.
- **Orthographic:** parallel projection, no perspective.
- **Save image:** a PNG at twice the screen resolution.
- **Themes:** Graphite (dark) and Paper (light); the choice is remembered.

Rendering only happens when something changes, so an idle window uses almost no GPU.

---

## 13. Appearance

For a selected body (Inspector):

- **Colour:** seven material-inspired swatches, or any colour with the colour picker.
- **Finish:**

| Finish | Look |
|---|---|
| Matte | Printed plastic, cast resin |
| Satin | Injection-moulded plastic |
| Metal | Machined aluminium or steel |
| Clear | Translucent (PETG, acrylic, resin) |

- **Name:** click the name to rename the body.
- **Visibility:** the eye in the browser, or Hide / Isolate / Show all.

---

## 14. Files, import and export

### The `.whittle` format

A ZIP file containing:

| Entry | Content |
|---|---|
| `manifest.json` | Format and schema version |
| `document.json` | The full design: parameters, features, body metadata, rollback position, timestamps |
| `thumbnail.png` | 256 px preview image |

The format is plain JSON, open and readable. Older files are migrated automatically; files from a newer version are refused with a clear message instead of being misread. Imported STEP/STL files are embedded in the design, so a `.whittle` file is self-contained.

### Saving and opening

- **Save** (Ctrl+S) and **Save as** (Ctrl+Shift+S) use the system file dialog where the browser supports it (Chrome, Edge, the desktop app); otherwise they download the file.
- **Open** with Ctrl+O, or **drag and drop** a `.whittle` file onto the window.
- **Autosave:** the design is saved in the browser about a second after every change. After a crash, the start screen offers **Continue where you left off**.
- Closing with unsaved changes asks for confirmation.
- Desktop app: double-clicking a `.whittle` file opens it.
- **Version history** (Export ▸ Version history, or Ctrl+K "history"): every save keeps the previous version, on your computer (desktop app), in the browser (web), or on the server (self-hosted). Restore one, or open it as a copy.
- **Self-hosted server:** Save stores the design in your library on the server; if it was saved elsewhere in the meantime, you're asked before anything is overwritten.

### Export

| Format | Use | Notes |
|---|---|---|
| **3MF** | Slicers (Bambu Studio, PrusaSlicer, OrcaSlicer, Cura) | Recommended for 3D printing; units included |
| **STL** | Any slicer or mesh tool | Binary |
| **STEP** | Other CAD (Fusion 360, SolidWorks, Onshape, FreeCAD), CNC and manufacturing | Exact geometry |
| **SVG** | One sketch, for laser and vinyl cutters, plotters, Inkscape, Illustrator | True size, in millimetres |
| **DXF** | One sketch, for laser cutters, CNC and CAM, AutoCAD | Units set to millimetres |
| **PNG** | Pictures | Save image |

### Import

| Format | How | Notes |
|---|---|---|
| STEP (`.step`, `.stp`) | Create ▸ Import, or drag and drop | Exact geometry, becomes a body |
| STL | Same | Triangles are sewn into a solid and flat areas are merged into clean faces. Limit: 40,000 triangles |
| SVG | In a sketch: Special ▸ Import SVG | Closed paths become editable sketch outlines; you choose the width |

Files up to 40 MB. Each import has a **Scale** field.

---

## 15. Errors, warnings and fixes

A failing feature never breaks the whole model: later features keep building from the last good state, and the timeline marks the problem.

**Messages are written for people**, for example:

- "A 50 mm fillet radius is too large for these edges. The largest that fits is about 9.8 mm." with a one-click **[Use 9.8 mm]** button. Whittle searches for the largest working value.
- "A 4 mm wall is too thick for this body. About 2.1 mm fits." with **[Use 2.1 mm]**.
- "The head diameter must be larger than the hole." with **[Use 9 mm]**.
- "The cut doesn't touch any body. Try flipping its direction."
- "Hole 2 is off the body, so nothing was drilled there."
- "A hole touches its outline in two places, which would split the shape in two."
- "Some edges moved after an upstream change. Please check the selection."
- "This shape's position comes from parameters, so it can't be dragged."

**States:**

| State | Meaning |
|---|---|
| OK | Built normally |
| Warning | Built, but worth checking |
| Waiting | The feature needs input (e.g. "Click the edges you want to soften"); not an error |
| Error | Couldn't build; the message says why |

---

## 16. Keyboard and mouse reference

Press **?** in the app for the full list.

### Modelling

| Key | Command |
|---|---|
| S | Sketch |
| E | Extrude |
| R | Revolve |
| D | Hole |
| F | Fillet |
| M | Move / Copy |
| J | Combine |
| I | Measure |
| P | Parts library |
| H | Home view |
| Shift+H | Fit to view |
| Enter | Apply (OK) |
| Esc | Cancel / leave mode / clear selection |
| Del / Backspace | Delete selection |

### Sketch

| Key | Command |
|---|---|
| L | Line |
| R | Rectangle |
| C | Circle |
| E | Ellipse |
| P | Polygon |
| O | Slot |
| T | Text |
| G | Gear |
| V | Select |
| X | Toggle construction |
| Ctrl+D | Duplicate shape |
| Shift+R | Rotate shape 90° |
| 0–9 | Type a size while drawing |
| Tab | Next size field |
| Enter | Place / close outline |
| Backspace | Remove last outline point |
| Alt (hold) | Place without snapping |
| Esc | Select tool, then finish sketch |

### General

| Key | Command |
|---|---|
| Ctrl+K | Find any command |
| Ctrl+Z | Undo |
| Ctrl+Shift+Z / Ctrl+Y | Redo |
| Ctrl+S | Save |
| Ctrl+Shift+S | Save as |
| Ctrl+O | Open |
| ? | Shortcuts |

### Mouse

| Action | Result |
|---|---|
| Click | Select |
| Shift/Ctrl+click | Add to selection |
| Double-click | Edit the feature |
| Right-click (no drag) | Radial quick-action menu |
| Drag a field label | Scrub its value |
| Drop a file | Open `.whittle` or import STEP/STL |

---

## 17. Architecture

```
packages/core      Document model, expressions, parameters, sketch geometry, history, file format (pure TypeScript)
packages/kernel    Geometry: OpenCascade (WASM, via replicad) in a Web Worker; rebuild engine;
                   stable references; exporters; STL importer
apps/web           React 19 UI, Three.js viewport, sketch tools, commands, styling
apps/desktop       Tauri 2 desktop shell (Rust)
apps/server        Optional Rust/Axum server: serves the app and stores designs
tests/e2e          Browser tests (Playwright driving Edge/Chrome)
docs/              Architecture notes and this reference
```

| Layer | Technology |
|---|---|
| Geometry kernel | OpenCascade (OCCT) compiled to WebAssembly, used through replicad; runs in a Web Worker |
| UI | React 19, Zustand (state), Immer (immutable edits and undo patches) |
| 3D view | Three.js with on-demand rendering, fat lines for edges, raycast and screen-space picking |
| Language / build | TypeScript (strict), Vite, Vitest |
| Desktop | Tauri 2 (uses the system WebView: WebView2, WebKit) |
| Server | Rust, Axum 0.8, tower-http |
| Fonts | IBM Plex Sans (UI and sketch text), JetBrains Mono (numbers) |

**Data flow:**

1. Every edit is an Immer change to the document, recorded as undo patches.
2. A change schedules a rebuild: the document is sent to the worker.
3. The worker rebuilds from the first changed step (cached by a hash of each step and everything before it) and returns triangle meshes, edge lines, face and edge fingerprints, volumes and status messages.
4. The viewport displays the result; the panels show statuses.

Newer rebuild requests replace older pending ones.

**Server API** (optional): `GET /api/health`; `GET /api/designs`; `GET`, `PUT`, `DELETE /api/designs/{id}`. Uploads are checked to be ZIP files and written atomically. An optional bearer token protects the API.

**Licensing:** Whittle is MPL-2.0. OpenCascade (LGPL) ships as a separate, replaceable WASM file. See `THIRD_PARTY_LICENSES.md`.

---

## 18. Testing

| Suite | Command | Covers |
|---|---|---|
| Unit and geometry | `npm test` | 42 tests: expressions and units, undo history, file format, sketch extrude, references surviving upstream edits (fillet stays on its edges when the sketch width changes, with an exact volume check), fix suggestions, face sketches, shell, patterns, exports, new shapes, ellipse/gear/text/rounded outlines, holes (counterbore, countersink, misses), loft, move, combine, touching holes, text placement, STEP and STL import round trips, every library part |
| Core browser flow | `node tests/e2e/smoke.mjs [url]` | Start screen, template, parameter change, sketch with typed size, extrude, fillet, 3MF export, theme |
| Feature tour | `node tests/e2e/features.mjs [url]` | Parts library, vase and print check, section, X-ray, new sketch tools, text, arrange tools, extrude, counterbore hole, measure, radial menu, box + combine cut, move copy, image export |

Both browser suites pass against the dev server and the production build with no console errors.

---

## 19. Known limitations

- **Sketches** have no constraints yet (coincident, tangent, equal). Arcs as separate entities and trim/offset aren't available.
- **Not yet available:** sweep, threads, draft, thicken and split.
- **Construction geometry:** only origin planes, face planes and offsets; no angled planes or axes.
- **Timeline:** steps can't be reordered.
- **Assemblies:** none; Whittle designs parts, which can be placed as several bodies in one design.
- **STL import:** limited to 40,000 triangles; very dense meshes should be simplified first.
- **Gears:** only involute spur gears (no helical or internal).
- **Fonts:** one family (IBM Plex Sans, regular and bold), Latin characters.
- **Face sketches from v0.1:** they are now measured from the projected world origin rather than the face centre, so older v0.1 face sketches with offsets may shift.
- **Desktop and server builds:** require platform build tools (on Windows: Visual Studio "Desktop development with C++").
- **Name:** "Whittle" is also the name of a mining software product (GEOVIA); check trademarks before a public launch.

---

## 20. Roadmap

| Phase | Content | Status |
|---|---|---|
| 0. Spike | OCCT in a worker; sketch → extrude → fillet → edit survives | Done |
| 1. Foundations | Design system, document model, undo, rebuild cache, viewport, file format | Done |
| 2. Sketcher | Tools, snapping, typed sizes, text, gears, splines, arrange ✅ · constraints (PlaneGCS), arcs, trim | In progress |
| 3. Part features | Extrude, revolve, loft, holes, fillet, chamfer, shell, move, combine, patterns ✅ · sweep, threads, draft | In progress |
| 4. I/O & polish | Export, STEP/STL import, measure, section, print check, parts library | Done |
| 5. Beta 0.9 | Signed installers, auto-update, docs site, installable web app | Next |
| 6. v1.0 | Performance, accessibility audit, translations | |
| 7. v1.x | Assemblies, drawings, sheet metal, direct editing | |
| 8. v2 | Collaboration, plugins, scripting | |

See `PLAN.md` for the full product plan and `docs/ARCHITECTURE.md` for design notes.
