# Third-party components

Whittle is MPL-2.0. It builds on these open-source projects:

| Component | License | Notes |
|---|---|---|
| [Open CASCADE Technology](https://dev.opencascade.org/) (via `replicad-opencascadejs`) | LGPL-2.1 (with OCCT exception) | Shipped as a **separate, replaceable** `replicad_single.wasm` file. You may rebuild it from source with the scripts in the `replicad-opencascadejs` package and drop it in. |
| [replicad](https://replicad.xyz) | MIT | JavaScript API over OCCT |
| [three.js](https://threejs.org) | MIT | Viewport rendering |
| [React](https://react.dev) | MIT | UI |
| [zustand](https://github.com/pmndrs/zustand) | MIT | UI state |
| [Immer](https://immerjs.github.io/immer/) | MIT | Undo/redo patches |
| [fflate](https://github.com/101arrowz/fflate) | MIT | .whittle and .3mf containers |
| [IBM Plex Sans](https://github.com/IBM/plex), [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) | SIL OFL 1.1 | Bundled fonts |
| [Tauri](https://tauri.app) | MIT / Apache-2.0 | Desktop shell |
| [Tauri](https://tauri.app) plugins: dialog, single-instance | MIT / Apache-2.0 | Desktop dialogs, one running instance |
| [Axum](https://github.com/tokio-rs/axum), Tokio, tower-http | MIT | Optional server |
| [SQLx](https://github.com/launchbadge/sqlx) | MIT / Apache-2.0 | Server database access |
| [SQLite](https://sqlite.org) | Public domain | Default server database (compiled in) |
| [RustCrypto argon2, sha2](https://github.com/RustCrypto) | MIT / Apache-2.0 | Password hashing, session ids |
| [openidconnect-rs](https://github.com/ramosbugs/openidconnect-rs), reqwest | MIT / Apache-2.0 | Single sign-on |
| [rustls](https://github.com/rustls/rustls), [ring](https://github.com/briansmith/ring) | Apache-2.0 / ISC / MIT | TLS for the server's outgoing connections |
| [zip](https://github.com/zip-rs/zip2) | MIT | Reading .whittle files on the server |

**LGPL compliance:** the OCCT WebAssembly binary is never merged into Whittle's JavaScript bundle; it is loaded at runtime as its own file (`assets/replicad_single-*.wasm`), so users can replace it with their own build.