# Whittle: Complete Application Reference

**Version:** 0.2.1 · **License:** MPL-2.0 · **Type:** open-source parametric 3D CAD for part design

Whittle is an open-source parametric 3D CAD application: exact solids, a full feature history and real engineering exports, in an app that is light, quick to install and easy to learn. It runs in any modern browser, as a desktop app (Windows, macOS, Linux via Tauri), or self-hosted on a server.

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
│ (left)  │   context bar (top) · orientation cube (top right) │  panel     │
│         │   view dock (bottom) · section card (bottom left) │ (right)    │
├──────────────────────────────── Timeline ───────────────────────────────┤
└────────────────────────────── Status bar ───────────────────────────────┘
```

### Title bar

- File buttons: New, Open, Save, Export, then Undo and Redo (their tooltips name the step).
- **Design name:** click to rename. A dot shows "Saved" or "Unsaved".
- **Find a command** (Ctrl+K), Parameters, theme switch (Graphite dark / Paper light), Help (start screen).

### Toolbar (modelling mode)

Tools are grouped in the order the work flows (create, modify, assemble, construct, inspect, insert), the layout most CAD users already know. Each group label is also a menu listing **every** tool in that group, in labelled sections, with a short description and shortcut. Engineer and designer profiles get a few more buttons on the bar; the menus are the same for everyone.

| Group | Buttons | Also in the group menu |
|---|---|---|
| Start | **Sketch** | |
| Create | Extrude, Revolve, Hole, Box (Sweep and Loft for engineers and designers) | Pipe, Rib, Web, Thread, Coil, Emboss, Engrave, Boundary Fill; primitives (box, cylinder, sphere, cone, torus, tube); 3D curves |
| Modify | Fillet, Chamfer, Shell, Move / Copy, Combine (Press / Pull and Draft for engineers and designers) | Replace / Delete / Split faces, Round or bevel all edges, Mirror, Pattern, Split, Offset, Scale, Align |
| Assemble | (menu) | Make component, Ground, Joint, Interference, Exploded view, Color by component |
| Construct | (menu) | Planes, axes and points |
| Surface | (menu) | Patch, ruled, offset, extend, trim, stitch, merge, thicken… |
| Inspect | Measure, Section | Check geometry, overhangs, draft, minimum radius, curvature, zebra, display styles, orthographic |
| Insert | Parts | Import STEP / STL |
| Export | Export… | Export STEP, Export 3MF, Export STL, Save image, Version history |

Buttons are greyed out when they don't apply, and say why: hover a greyed button, or open its group menu, to read what it needs (for example, Fillet before any body exists: "Needs a body first"). The command palette lists them too, with the same reason, so a search never comes up empty.

### Toolbar (sketch mode)

The toolbar turns orange-tinted and shows sketch tools:

| Group | Tools |
|---|---|
| Draw | Line, Rectangle, Circle, Ellipse, Polygon, Slot |
| Special | Text, Gear, Picture to trace, Import SVG (menu adds: Calibrate picture, Flatten photo, Trace whole picture, Trace one area, Export sketch as SVG, Export sketch as DXF) |
| Arrange | Select, Duplicate, Mirror, Rotate 90°, Construction (menu adds: Mirror up/down, Delete) |
| Constrain | Constrained lines (engineer and designer profiles also show Arc, Circle, Trim, Extend; the menu has all of them plus every constraint) |
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
| Orientation cube | top right | Click a face to look at it; home button for the default view |
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
| "slicer", "3d print" | Export 3MF |
| "transparent" | X-ray |

Arrow keys move, Enter runs, Esc closes. Tools that can't run yet are listed last, dimmed, with what to do first.

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
| Line (outline) | L | Click each point; click the first point (or press Enter) to close; **A** switches arcs on and off; Backspace removes the last point | Length, then angle | Points (each can be an **Arc** point); Smooth curve; Round corners |
| Path (open line) | A | Like Line, but stays open; Enter finishes; **A** while drawing switches arcs on and off | Length, then angle | Points, Arc points, Smooth curve |
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

**Arcs:** while drawing an outline or path, press **A**. The next click sets where the arc ends and the click after that sets a point the arc passes through (a three-point arc). Press **A** again for straight lines. Clicking the first point as an arc's end closes the outline with an arc. In the panel, any point except the ends of a path can be switched to an **Arc** point: it becomes the middle of an arc between its neighbours.

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

### Constraint-driven sketching

Beside the whole shapes above, a sketch can hold **solver geometry**: points, lines, arcs and circles that a
constraint solver (PlaneGCS, the open-source solver from the FreeCAD project, compiled to WebAssembly) positions from the relations you give it.
Both kinds live in the same sketch, so the quick tools stay exactly as they were.

| Tool | Use |
|---|---|
| Constrained line | Click points; click the first point to close the outline, or the last point again (or Enter) to stop. Clicking an existing point joins the lines there. Lines drawn level or upright get Horizontal / Vertical automatically. |
| Constrained arc | Click the start, the end, then a point the arc passes through. |
| Constrained circle | Click the center, then the radius (or type a diameter). |
| Trim | Click the piece of a line, arc or circle to remove, between the nearest crossings. A circle crossed twice becomes an arc; a curve nothing crosses is deleted. Cut ends stay on the curve that cut them. |
| Extend | Click near the end of a line or arc to stretch it to the next curve. |

**Constraining.** With the Select tool, click geometry (Shift+click adds more; the origin and the X/Y axes can be
picked too). The right panel lists every constraint that fits the selection:

| Constraint | Applies to |
|---|---|
| Coincident | two points, or a point and a line / arc / circle |
| Horizontal, Vertical | a line, or two points |
| Parallel, Perpendicular | two lines |
| Tangent | a line and an arc or circle, or two arcs / circles (where they share an end, the join is smooth) |
| Equal | two lines (length), or two arcs / circles (radius) |
| Fixed | anything: pins it where it is |
| Symmetric | two points and a line (mirrored about it), or three points (the first two mirrored about the last one picked) |
| Midpoint | a point and a line: the point sits at the line's middle (on an axis: anywhere along it) |
| Collinear | two lines: both lie on one infinite line |
| Distance | a line (its length), two points, a point and a line, or two parallel lines |
| Radius | a circle or arc |
| Angle | a line (from horizontal) or two lines |

Dimensions (Distance, Radius, Angle) take a number or a **formula**, e.g. `width / 2`; changing the parameter
re-solves the sketch and everything built from it. Edit or scrub a dimension in the panel's constraint list.

**On the canvas.** Each dimension shows its value (or formula) beside what it measures; **double-click** it to edit.
Relations show a small glyph next to each thing they relate: H, V, ∥ (parallel), ⊥ (perpendicular), = (equal),
⌒ (tangent), ⌖ (fixed), ⇔ (symmetric), ½ (midpoint), ⋯ (collinear). Click a label or glyph to select that
constraint (Shift+click adds to the selection), then Del removes it. Coincident constraints aren't labelled: shared
points already show them.

**How defined is it?** While you edit, geometry that can still move is drawn in the normal sketch colour and fully
defined geometry turns **green**; the panel says how many degrees of freedom are left, or "Fully defined".
Constraints that contradict each other turn the geometry and the constraints **red**, and the sketch shows a
plain message naming them (for example "Over-constrained: Horizontal and Vertical can't all be true. Delete one of
the red constraints."). Constraints that repeat what others already say are flagged the same way.

**Dragging** a point or curve moves it; the solver keeps every constraint, so fully defined geometry stays put.

**Solids.** Closed loops of solver lines and arcs become solid regions, with loops inside loops as holes, just like
whole shapes; solver circles do too. Open chains are paths (for sweeps and thin walls), and construction lines can
be revolve axes.

### Arrange tools (selected shape)

| Action | Key | Result |
|---|---|---|
| Duplicate | Ctrl+D | Copy offset by +10, −10 and selected |
| Rotate 90° | Shift+R | Rotates the shape about its own centre |
| Offset | Shift+O | A copy grown outward (positive) or shrunk inward (negative). Sizes stay formulas of the original, so the offset follows later edits. Works on rectangles, circles, slots, ellipses, polygons and straight-sided outlines |
| Mirror ↔ | | Mirrored copy across the sketch's vertical axis |
| Mirror ↕ | | Mirrored copy across the sketch's horizontal axis |
| Copies around origin | | *N* copies evenly spaced around the sketch origin (e.g. a bolt circle) |
| Row → / ↑ | | *N* copies spaced by *Gap* along X or Y |
| Delete | Del | Removes the shape |

These work on shapes whose positions are plain numbers. If a position comes from a formula, Whittle leaves it unchanged and explains why, so formulas are never overwritten. Dragging follows the same rule.

### Pictures to trace over

Put a photo, scan or drawing on the sketch plane and draw over it at true size. Use **Insert ▸ Picture to trace**, **paste** an image (Ctrl+V) while sketching, or **drop** an image file anywhere. Dropping one outside a sketch starts a new sketch on the ground (XY) plane with the picture on it. The picture sits behind the sketch lines and isn't geometry: moving or fading it never triggers a rebuild.

| Step | How | Result |
|---|---|---|
| **Calibrate** | Click two points on the picture, type their real distance (quick picks: credit card, A4 short side, 100 mm ruler) | The picture is scaled about the first point, so that point stays put |
| **Flatten photo** | Click the four corners of something rectangular of known size in the photo, in order around it, then choose its size (A4, US Letter, A3, credit card or your own `w x h`) | The photo is un-skewed (perspective correction) and scaled to true size in one step, centred on the origin. A phone photo of a part lying on a sheet of paper becomes a true-size plan |
| **Trace all** | One click | Every dark shape on light paper (or light on dark: decided from the picture's border) becomes an outline. The threshold is chosen automatically (Otsu); edges are found to a fraction of a pixel (marching squares) and simplified. Round outlines become **exact circles**, ready for holes. Shapes inside shapes become holes, as usual |
| **Trace one area** | Click inside one shape (or a gap) | Like a magic wand: only the clicked area and its holes are outlined, ignoring clutter around it |

The panel also has the picture's **Width**, **X**, **Y**, **Rotate**, **Opacity**, **Show outside this sketch**, **Replace** and **Remove**. Pictures are stored inside the design (shrunk to at most 2400 px, JPEG).

Tip for photos: shoot from above in even light, with the part on plain paper; flatten first, then trace one area.

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

While the panel is open, the feature's shape is tinted by its Result, as in other CAD tools: **blue** for a new body, **green** for join, **red** for what a cut removes, **amber** for keep overlap. Length handles show an arrow pointing the way they pull (red for a cut, red/green/blue for X/Y/Z moves).

### Feature reference

| Feature | Key | How to start | Fields |
|---|---|---|---|
| **Extrude** | E | Uses the selected sketch, or the newest unused one. On a face sketch it defaults to Join | Profile, Distance, Direction (One side / Symmetric / Two sides / **Through all** / **Up to a face**), Flip, **Thin wall** (wall thickness, Inside / Centered / Outside), Taper, Twist, Result, Body |
| **Revolve** | R | Same sketch rule | Profile, Axis (sketch vertical, sketch horizontal, or **a line** drawn in the sketch), Angle (up to 360°), Result |
| **Loft** | | Selected sketches (Shift-click several), or the two newest unused sketches. Click sketches to add or remove profiles | Profiles in order, Add, Straight sides (ruled), Result. Each profile must be a single closed shape |
| **Hole** | D | Select a flat face (the click point becomes the first hole), or click a face after starting. Each click on the face adds a hole | Type (Simple / Counterbore / Countersink), Diameter, Through all or Depth, Head Ø, Head depth (counterbore), position of each hole (X, Y) |
| **Fillet** | F | Select edges or faces first, or click them after starting (click again to deselect). Clicking an edge also takes the edges that continue smoothly from it (a whole rounded outline); switch that off in the panel | Radius |
| **Chamfer** | | Same as fillet | Distance |
| **Shell** | | Click the face(s) to remove (the open side) | Wall thickness |
| **Move / Copy** | M | Selected body or the newest one; click a body to change it | X, Y, Z move; Rotate around X/Y/Z by Angle (about the body's own centre); Keep the original (make a copy) |
| **Combine** | J | Selected bodies (first = target, rest = tools). Click bodies to set the target, then toggle tools | Operation (Join / Cut / Keep overlap), Target, Tools, Keep tool bodies |
| **Mirror** | | Selected body or the newest | Repeat (A whole body / **Features**), Mirror plane (YZ, XZ, XY), Plane offset, Merge with the original |
| **Pattern** | | Selected body or the newest | Repeat (A whole body / **Features**), Type (In a row / Around an axis / Along a path), Direction or axis (X, Y, Z), Count (2–200), Spacing or Total angle, **Second direction** (grid: direction, count, spacing; up to 400 copies), Merge copies |
| **Import** | | Import STEP / STL, or drop a file | Scale (e.g. 25.4 converts a part modelled in inches) |

**Thin wall** extrudes a band along every outline instead of filling it: enclosures, frames, rings and cups in one step. Open paths become **ribs and webs**: draw a path and give it a wall thickness. *Inside* grows the wall into the shape (left of a path), *Outside* away from it.

**Through all** goes through every body in the chosen direction, so a hole or slot stays a through cut however thick the part becomes.

**Up to a face** stops an extrusion exactly at a flat face you click, wherever it is (a boss that always reaches the lid, a pocket that stops at the far wall). It follows the face if you change the model upstream.

**Pattern and mirror features, not just bodies:** choose *Repeat: Features* and tick the earlier features to repeat, for example one boss, one rib or one cut. Whittle repeats exactly what each feature added to or removed from the body, in timeline order, so a boss with a hole repeats as a boss with a hole. Features that make a new body can't be repeated this way: pattern the body instead.

**Cuts on a face** go into the body by default: picking *Cut* on a face sketch flips the direction so material is actually removed. A cut that removes nothing is reported as a warning instead of passing silently.

**Revolve around a line:** draw a straight path (or a construction line) in the profile's sketch, choose *Axis: A line* and pick it. Rings, pulleys and grooves no longer need their profile placed on the sketch axis.

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

## 5b. Construction, curves, surfaces and assemblies

**Construct** (toolbar group): planes (offset or tilted, midplane, through 3 points or 2 edges, at an angle to an edge, tangent to a round face, along a path), axes (through a cylinder, 2 points, 2 planes, an edge, perpendicular to a face) and points (at a corner, 2 edges, 3 planes, a circle's center, an edge and a plane). Planes can be sketched on; axes and points are references that patterns, mirrors, splits and joints can use.

**More solid tools:** Rib (a thin wall from a line), Web, Emboss and Engrave (a sketch raised from or sunk into a face), Thread on a face (a real helical groove on a rod or in a hole), Boundary Fill (keep the overlap regions of bodies), Align (snap one body's face to another's), Replace Face (bring flat faces to a plane or another face), Delete Face (remove a hole, pocket, boss, fillet or chamfer and heal the gap), Split Faces, silhouette (widest outline) split, variable-radius fillets, pattern along a path or around a construction axis, branching pipes and Insert design (bring in the bodies of another `.whittle` file).

**3D curves:** 3D sketch (through clicked points), Include 3D geometry (copy model edges), Intersection curve (where two faces meet) and Project to surface. Sweeps, pipes and path patterns can follow them.

**Sketch extras:** control-point spline, elliptical arc, 2- and 3-tangent circles, stretch, Intersect (the model's outline where it crosses the sketch plane) and DXF import.

**Surfaces:** Extrude, Revolve, Sweep and Loft can output a surface (sides only; open lines work). The Surface group adds Patch, Ruled, Offset, Trim, Untrim, Extend, Stitch (a closed set becomes a solid), Unstitch, Merge, Reverse normal and Thicken. Surface bodies have no volume.

**Assemblies:** bodies can be grouped into components (they move together under joints) and grounded. Joints are rigid, revolute, slider, cylindrical, pin-slot, planar and ball, with optional limits, a joint origin (construction axis and point), a drive slider with Play, motion links (a joint that follows another by a ratio) and collision warnings.

**Inspect extras:** Interference (overlapping bodies, marked with red boxes), Minimum radius (inside corners a cutter can't reach), Curvature map, Accessibility from above and Color by component.

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

**Variants.** In the Parameters panel, *Save current as variant* stores every parameter's value under a name ("Small", "Large", "With lid"). Click a variant to switch the whole design to it; the active one is highlighted. Variants are saved in the file.

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

Coming from another CAD app? **Settings → Navigation** offers the common mouse layouts (middle button pans; middle button orbits, with Ctrl or Shift to pan; right button orbits; trackpad) and two keyboard layouts: Whittle's own, or the classic CAD letters: `H` hole, `J` joint, `Home` home view, and in a sketch `T` trim, `O` offset, `P` project. Tooltips, menus and the shortcut list (`?`) always show the keys of the layout you chose.

The model is lit by a key light above and to the left of the camera and a soft fill from the camera, so the faces of a part read apart at any angle. An empty scene shows a short blue Z axis at the origin so you know which way is up; it hides once there is a model.

| Command | Key | Effect |
|---|---|---|
| Home view | H | Isometric view, fitted |
| Fit to view | Shift+H | Fit the visible bodies, keeping the angle |
| Orientation cube | | Front, back, left, right, top, bottom |
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

The format is plain JSON, open and readable. Format 2 (Whittle 0.4) adds optional `geometry` and `constraints` to sketches; positions there are millimetres (the solver's starting guesses), and dimension values are expressions. Older files are migrated automatically; files from a newer version are refused with a clear message instead of being misread. Imported STEP/STL files are embedded in the design, so a `.whittle` file is self-contained.

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
| **3MF** | Modern 3D-printing slicers | Recommended for 3D printing; units included |
| **STL** | Any slicer or mesh tool | Binary |
| **STEP** | Any other CAD app, CNC and manufacturing | Exact geometry |
| **SVG** | One sketch, for laser and vinyl cutters, plotters and vector editors | True size, in millimetres |
| **DXF** | One sketch, for laser cutters, CNC and CAM, AutoCAD | Units set to millimetres |
| **PNG** | Pictures | Save image |
| **2D drawing (SVG)** | Drawings and documentation | Export dialog. Front, top and right views in third-angle projection plus an isometric view on an A3 sheet, hidden lines dashed, overall dimensions, standard scale (1:50 to 10:1) and a title block. Opens in any browser or vector editor; print to PDF |

**Mesh detail** (top of the Export dialog, remembered) sets how closely 3MF, STL, OBJ, GLB and PLY follow curved faces: **Draft** is about ten times coarser (small files for previews and sharing), **Standard** is 0.01 mm on ordinary parts, **Fine** is about four times finer (smoothest prints of curved parts, bigger files). STEP and drawings are always exact.

### Import

| Format | How | Notes |
|---|---|---|
| STEP (`.step`, `.stp`) | Insert ▸ Import STEP / STL, or drag and drop | Exact geometry, becomes a body |
| STL | Same | Triangles are sewn into a solid and flat areas are merged into clean faces. Limit: 40,000 triangles |
| SVG | In a sketch: Insert ▸ Import SVG into sketch | Closed paths become editable sketch outlines; you choose the width |
| Pictures (PNG, JPEG, WebP, GIF, BMP) | In a sketch: Insert ▸ Picture to trace, paste, or drop anywhere | A reference picture to calibrate, flatten and trace (see *Pictures to trace over*) |

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
| Q | Press / Pull |
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
| Shift+click | Add solver geometry to the selection (for constraints) |
| Del | Delete the selected shape, geometry or constraint |
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
                   stable references; exporters; STL importer; sketch constraint solving (PlaneGCS)
apps/web           React 19 UI, Three.js viewport, sketch tools, commands, styling
apps/desktop       Tauri 2 desktop shell (Rust)
apps/server        Optional Rust/Axum server: serves the app and stores designs
tests/e2e          Browser tests (Playwright driving Edge/Chrome)
docs/              Architecture notes and this reference
```

| Layer | Technology |
|---|---|
| Geometry kernel | OpenCascade (OCCT) compiled to WebAssembly, used through replicad; runs in a Web Worker |
| Sketch solver | PlaneGCS (the FreeCAD project's 2D constraint solver) compiled to WebAssembly (`@salusoft89/planegcs`); runs in the same worker as part of each rebuild |
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

**Licensing:** Whittle is MPL-2.0. OpenCascade and PlaneGCS (both LGPL) ship as separate, replaceable WASM files. See `THIRD_PARTY_LICENSES.md`.

---

## 18. Testing

| Suite | Command | Covers |
|---|---|---|
| Unit and geometry | `npm test` | 214 tests, including constraint solving (solved profiles extrude to exact volumes, a dimension or parameter change re-solves, named conflicts, tangent slots, revolve about a construction line) and trim / extend; also expressions and units, undo history, file format, sketch extrude, references surviving upstream edits (fillet stays on its edges when the sketch width changes, with an exact volume check), fix suggestions, face sketches, shell, patterns, exports, new shapes, ellipse/gear/text/rounded outlines, holes (counterbore, countersink, misses), loft, move, combine, touching holes, text placement, STEP and STL import round trips, every library part |
| Core browser flow | `node tests/e2e/smoke.mjs [url]` | Start screen, template, parameter change, sketch with typed size, extrude, fillet, 3MF export, theme |
| Feature tour | `node tests/e2e/features.mjs [url]` | Parts library, vase and print check, section, X-ray, new sketch tools, text, arrange tools, extrude, counterbore hole, measure, radial menu, box + combine cut, move copy, image export |
| Modelling depth | `node tests/e2e/modeling.mjs [url]` | Arcs drawn with the mouse, offset, thin extrude, through all, grid, offset mirror, revolve about a line, ribs |
| Constraints | `node tests/e2e/constraints.mjs [url]` | Solver lines drawn with the mouse, automatic Horizontal/Vertical, a distance typed as a formula, degrees of freedom, fully defined (green), a named conflict (red), the `constrain_sketch` API, a parameter change re-solving the extrusion, trimming a circle |
| Audit regressions | `node tests/e2e/audit.mjs [url]` | Rib tool opens, a cut on a face removes material, Q shortcut, selected face brings its edges into Fillet, tangent chains, feature patterns, exploded view, variants, 2D drawing export |
| Pictures | `node tests/e2e/pictures.mjs [url]` | Add a picture, trace all (exact circles), trace one area, calibrate, flatten a photo, extrude the traced shapes |

Both browser suites pass against the dev server and the production build with no console errors.

---

## 19. Known limitations

- **Sketch constraints** work on solver geometry (points, lines, arcs, circles), not on whole shapes such as rectangles or text; there are no symmetric, midpoint or collinear constraints yet (use two Coincident-on-line constraints for collinear). Outlines where three or more lines meet at one point are treated as open paths. Sketches with more than 80 points are coloured as a whole rather than piece by piece.
- **Not yet available:** Form (T-spline) sculpting, sheet metal (bent parts can be modelled with a thin extrude of a filleted path, but there is no flat pattern yet), plastic features (snap fit, lip), mesh repair and conversion, surface fillets, drawings with section views and per-feature dimensions (the drawing export has overall dimensions only), and Delete Face on an opening that isn't flat.
- **Assemblies:** components, ground, joints and an **Exploded view** (Inspect menu; display only, picking is paused while parts are apart) exist, but there is no contact-driven motion study (collisions only warn).
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
| 2. Sketcher | Tools, snapping, typed sizes, text, gears, splines, arrange, arcs, constraints (PlaneGCS) with DOF colouring, trim / extend | Done |
| 3. Part features | Extrude, revolve, loft, holes, fillet, chamfer, shell, move, combine, patterns ✅ · sweep, threads, draft | In progress |
| 4. I/O & polish | Export, STEP/STL import, measure, section, print check, parts library | Done |
| 5. Beta 0.9 | Signed installers, auto-update, docs site, installable web app | Next |
| 6. v1.0 | Performance, accessibility audit, translations | |
| 7. v1.x | Assemblies, drawings, sheet metal, direct editing | |
| 8. v2 | Collaboration, plugins, scripting | |

See `PLAN.md` for the full product plan and `docs/ARCHITECTURE.md` for design notes.
