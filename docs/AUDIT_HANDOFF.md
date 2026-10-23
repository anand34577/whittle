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

## Left to do (next pickup)

1. Re-run `npm run test:e2e` once to cover the final toast and copy changes.
2. The autosave stale-copy cleanup covers only drafts written in the current session. A recovered design that is emptied keeps its old copy.
3. The narrow-window browser drawer has no close button of its own. Only a tap outside or Escape closes it.
4. Shortcuts search matches only labels and keys. Command `keywords` could be added.
5. Sign-in throttling is per address and username. A per-address cap across usernames would slow password spraying.
6. Parameters on phones: existing rows have no visible name label once the header row is hidden (the inputs keep their aria-labels).
7. Not yet audited deeply: `ViewportView.tsx`, `sketchTools.ts`, `FeatureEditors.tsx`, `Account.tsx`/admin UI, and the desktop (Tauri) shell.
