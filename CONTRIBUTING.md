# Contributing to Whittle

Thanks for helping! A few ground rules keep Whittle simple and pleasant.

1. **Run the checks:** `npm run typecheck && npm test`; for UI changes also the browser suites (`tests/e2e/smoke.mjs`, `features.mjs`, and `server.mjs` against a running `whittle-server`); for server changes `cargo test` in `apps/server`. CI runs all of them, plus the server tests on PostgreSQL.
2. **Geometry changes need a test** in `packages/kernel/test`. Assert volumes, face counts and statuses, not just "it didn't throw".
3. **UI follows the design system:** use tokens from `apps/web/src/styles/tokens.css`, icons from `apps/web/src/ui/icons.tsx`, one accent color (marking orange), and cyan only for selection. No gradients-for-decoration, no emoji icons.
4. **Every new command goes into `state/commands.ts`** (label, keywords/synonyms, hint) so it appears in the toolbar, the palette and the shortcut list automatically.
5. **Errors must be human:** say what went wrong in the user's terms and, where possible, offer a fix.
6. **Work everywhere:** Whittle runs as a desktop app, on a self-hosted server and as a static site. File, dialog and storage code goes through `state/files.ts` and `state/platform.ts`, never straight to `window` APIs.
7. **Licensing:** Whittle is MPL-2.0. Don't add GPL dependencies.

## Releasing

1. Bump the version in `package.json`, `apps/desktop/src-tauri/tauri.conf.json`, `apps/desktop/src-tauri/Cargo.toml`, `apps/server/Cargo.toml` and `APP_VERSION` in `packages/core/src/file.ts`.
2. Tag and push: `git tag v0.3.0 && git push origin v0.3.0`.
3. `.github/workflows/release.yml` checks the versions match, runs the tests, builds the desktop installers (Windows, macOS universal, Linux x64 and arm64), the static server builds (Linux x86_64 and aarch64), the Docker image, writes `SHA256SUMS`, and publishes the release.