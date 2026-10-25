# Audit handoff (2026-10-23)

What the October 23 audit fixed, and what is left for the next person.

## Fixed in this round

- **Parameters dialog:** "Used N×" counted JSON field names, so a parameter called `depth` looked used by every extrude. It now counts real formula uses (`parameterUses` in `packages/core/src/params.ts`, with tests). The same fix applies to the parameters lesson check. Unused parameters show an "unused" tag. The Variants and CSV areas got proper padding, and the table scrolls on its own. On phones each parameter is shown as a card.
- **Export dialog:** the cards overflowed past the dialog's bottom edge. Export is now a wide dialog with two columns of formats, and "Only the selected body" sits above the formats.
- **Timeline menus:** they now close on Escape (before Escape deselects anything) and on resize, and they stay inside the window at the right edge.
- **Settings:** the Daylight theme broke stacked fields, which wrapped the Density control.
- **Store:** `moveFeature` used positions from before the open session was committed, so the wrong step could move. `deleteFeature` running while another editor was open could be brought back by Cancel. Both have regression tests in `apps/web/test/undo.test.ts`.
- **Files:**
  - A browser save to a moved or revoked file now asks for a new location instead of failing on every save.
  - Emptying a design removes its stale recovery copy.
  - Screenshot failures are caught.
  - Opening a dropped design confirms with a toast.
- **Import:** a file read error shows a message instead of an unhandled rejection.
- **Global safety net:** uncaught errors and rejections become a readable toast (`App.tsx`).
- **Toasts:**
  - Every toast can be dismissed.
  - An action button runs once and removes its toast.
  - Errors use `role="alert"` and stay up longer.
- **Title bar:** the green "Saved" badge only shows for designs that really are in a file. Others show "New" or "Not saved yet". Clicking the badge saves.
- **Status bar:** "Engine error" is now a button that explains the error and retries (or reloads if the engine never started).
- **Shortcuts dialog:** has a search box.
- **Select control:** gained an optional `short` label and a hover title. The material picker now reads "PLA (default)" instead of "Design def…".
- **Copying:** inspector values (volume, mass…) can be selected. Ctrl+C on selected text copies the text instead of triggering "copy steps".
- **Server:**
  - Sign-in lockout could be bypassed by padding the username with spaces (fixed, with a test).
  - A failed save no longer leaves temp files behind.

Verified with:

- `npm run typecheck`
- `npm test`: 348 passed
- `npm run test:e2e`: 20 suites passed (before the last two small fixes: the toast close button and inspector copy, both checked by hand in the browser)
- `cargo test` in `apps/server`: 17 passed

## Follow-up round (same day)

- **Autosave:** emptying a design now removes its recovery copy even when that copy came from an earlier session (a recovered design).
- **Narrow windows:** the design browser drawer has its own close button.
- **Shortcuts search** also matches command keywords ("round" finds Fillet).
- **Server:** besides the per-name limit, one address gets at most 50 failed sign-ins across all usernames in 15 minutes, which slows password spraying (with a test). A successful sign-in doesn't reset it. The reset-email limit got its own key, so it can't share a count with a user named "reset".
- **Parameters on phones:** each card labels its Name, Value or formula, and Note fields.
- The extra end-to-end suite was renamed `tests/e2e/solids.mjs`.

## Left to do (next pickup)

Not yet audited deeply: `ViewportView.tsx`, `sketchTools.ts`, `FeatureEditors.tsx`, `Account.tsx`/admin UI, and the desktop (Tauri) shell.

# Part-design audit (2026-10-24)

Compared with SolidCraft's part-modeling feature list (sketch, constraints, solid features, construction geometry, inspection, file exchange). Whittle already covers nearly all of it. This round fixed what the comparison and a screen-by-screen pass turned up.

## Fixed

- **Extrude panel:** Result (New body / Join / Cut / Intersect) now sits right under the distance and direction, where it can be seen without scrolling. Start face and start offset moved into a collapsed **Start** section. Output (Solid / Surface) comes after Result in every feature that has both.
- **Choice buttons:** a choice of three or more options takes the panel's full width under its label instead of wrapping into ragged rows ("Around an axis" and "Keep overlap" were clipped). "Keep overlap" is now called **Intersect**, the usual CAD name.
- **Ribbon:** Pattern (with Mirror) is on the Create group. The Assemble group is gone (part design only; joints and components are still in Ctrl+K, and Interference is under Inspect). Groups that are a single menu button now line up with the other tools.
- **Sketch panel:** the constraint list has a "Constraints N" heading and compact rows, and the delete buttons show on hover. The long help text is folded into **Sketching tips**.
- **Body panel:** the Assembly section only shows once the design uses components, grounding or joints.
- **Sketch summary:** the shape count no longer counts line end points as shapes.
- **Mirror:** a body centred on the mirror plane used to mirror onto itself, so nothing seemed to happen. The plane now starts at the body's side.
- **Shell:** the 2 mm default filled thin parts solid and failed at once. Thin parts now start at a quarter of their thinnest side.
- **Import:** Wavefront **OBJ** meshes can be inserted (button, drag and drop), through the same path as STL. The round-trip test covers it.
- **Pattern along a path / Rib:** their sketch lists offered sketches from later in the timeline (which don't exist yet when the step builds). They now only list earlier ones, like every other picker.
- Daylight panels: a read-out table starts right under its title bar (there was an empty band).

## Gaps left on purpose

- **IGES:** the bundled OpenCascade build has no IGES reader or writer. It needs a custom WASM build.
- **Plastic-part features** (boss, snap fit, lip), **blend curve**, **sketch curvature comb**, **compare bodies**: not built yet.
