//! Whittle desktop shell.
//!
//! The CAD application (UI + OpenCascade kernel in WebAssembly) runs in the
//! system webview. This shell adds what a desktop app needs: native open/save
//! dialogs, reading and writing files, a recent-files list, local version
//! history (every save keeps the previous copy), file associations and a
//! single running instance, and opening a newer release's download page. No
//! account is involved; the app only goes online for the daily check for a new
//! version (which can be switched off) and for an AI assistant the person sets up.

use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{ipc::Response, AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

/// Versions kept per file in the local history.
const MAX_HISTORY: usize = 50;
const MAX_RECENT: usize = 20;
const OPEN_EVENT: &str = "whittle://open";
const RELEASES: &str = "https://github.com/anand34577/whittle/releases/tag/v";

#[derive(Default)]
struct AppData {
    /// Paths the user chose (dialogs, OS file-open, recent list). Only these can be read or written.
    allowed: Mutex<HashSet<PathBuf>>,
    /// Files opened by the OS before the window was ready.
    pending: Mutex<Vec<String>>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Recent {
    path: String,
    name: String,
    opened_at: u64,
    #[serde(default)]
    exists: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryEntry {
    id: String,
    saved_at: u64,
    size: u64,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

/// Stable short hash of a path (FNV-1a), naming its history folder.
fn path_key(p: &Path) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in p.to_string_lossy().to_lowercase().bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

fn history_dir(app: &AppHandle, p: &Path) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("history").join(path_key(p)))
}

fn is_design(p: &Path) -> bool {
    p.extension().is_some_and(|e| e.eq_ignore_ascii_case("whittle"))
}

fn allow(state: &AppData, p: &Path) {
    state.allowed.lock().unwrap().insert(p.to_path_buf());
}

fn check_allowed(state: &AppData, p: &Path) -> Result<(), String> {
    if state.allowed.lock().unwrap().contains(p) {
        Ok(())
    } else {
        Err("Whittle can only open files you chose. Use Open… to pick it.".into())
    }
}

/* ───────────────────────── Recent files ───────────────────────── */

fn recent_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("recent.json"))
}

fn load_recent(app: &AppHandle) -> Vec<Recent> {
    recent_path(app)
        .ok()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn save_recent(app: &AppHandle, list: &[Recent]) {
    if let (Ok(p), Ok(json)) = (recent_path(app), serde_json::to_vec_pretty(list)) {
        let _ = std::fs::write(p, json);
    }
}

fn touch_recent(app: &AppHandle, p: &Path) {
    if !is_design(p) {
        return;
    }
    let path = p.to_string_lossy().to_string();
    let mut list = load_recent(app);
    list.retain(|r| r.path != path);
    let name = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| path.clone());
    list.insert(0, Recent { path, name, opened_at: now_ms(), exists: true });
    list.truncate(MAX_RECENT);
    save_recent(app, &list);
}

#[tauri::command]
fn recent_files(app: AppHandle) -> Vec<Recent> {
    load_recent(&app)
        .into_iter()
        .map(|mut r| {
            r.exists = Path::new(&r.path).is_file();
            r
        })
        .collect()
}

#[tauri::command]
fn forget_recent(app: AppHandle, path: String) {
    let mut list = load_recent(&app);
    list.retain(|r| r.path != path);
    save_recent(&app, &list);
}

/* ───────────────────────── Dialogs ───────────────────────── */

#[derive(Deserialize)]
struct Filter {
    name: String,
    extensions: Vec<String>,
}

#[tauri::command]
async fn open_dialog(app: AppHandle, state: State<'_, AppData>, filters: Vec<Filter>) -> Result<Option<String>, String> {
    let a = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut d = a.dialog().file();
        for f in &filters {
            let ext: Vec<&str> = f.extensions.iter().map(String::as_str).collect();
            d = d.add_filter(&f.name, &ext);
        }
        d.blocking_pick_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(p) = picked.and_then(|f| f.into_path().ok()) else { return Ok(None) };
    allow(&state, &p);
    Ok(Some(p.to_string_lossy().to_string()))
}

#[tauri::command]
async fn save_dialog(app: AppHandle, state: State<'_, AppData>, name: String, filters: Vec<Filter>) -> Result<Option<String>, String> {
    let a = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut d = a.dialog().file().set_file_name(&name);
        for f in &filters {
            let ext: Vec<&str> = f.extensions.iter().map(String::as_str).collect();
            d = d.add_filter(&f.name, &ext);
        }
        d.blocking_save_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(p) = picked.and_then(|f| f.into_path().ok()) else { return Ok(None) };
    allow(&state, &p);
    Ok(Some(p.to_string_lossy().to_string()))
}

#[tauri::command]
async fn ask_dialog(app: AppHandle, title: String, message: String, ok_label: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .message(message)
            .title(title)
            .buttons(MessageDialogButtons::OkCancelCustom(ok_label, "Cancel".into()))
            .blocking_show()
    })
    .await
    .map_err(|e| e.to_string())
}

/* ───────────────────────── Files ───────────────────────── */

#[tauri::command]
fn read_file(app: AppHandle, state: State<'_, AppData>, path: String) -> Result<Response, String> {
    let p = PathBuf::from(&path);
    check_allowed(&state, &p)?;
    let bytes = std::fs::read(&p).map_err(|e| format!("Couldn't read {path}: {e}"))?;
    touch_recent(&app, &p);
    Ok(Response::new(bytes))
}

/// Write the request body to the path in the `x-path` header (percent-encoded).
/// Before a design is overwritten, its previous contents go to the local history.
#[tauri::command]
fn write_file(app: AppHandle, state: State<'_, AppData>, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("Expected raw bytes".into()) };
    let encoded = request.headers().get("x-path").and_then(|v| v.to_str().ok()).ok_or("Missing path")?;
    let path = percent_decode(encoded)?;
    let p = PathBuf::from(&path);
    check_allowed(&state, &p)?;
    if is_design(&p) && p.is_file() {
        if let Err(e) = keep_history(&app, &p) {
            eprintln!("history: {e}");
        }
    }
    // Write next to the target, then rename: a crash never leaves a half-written file.
    let tmp = p.with_extension(format!("{}.tmp", p.extension().and_then(|e| e.to_str()).unwrap_or("")));
    std::fs::write(&tmp, bytes).map_err(|e| format!("Couldn't save {path}: {e}"))?;
    std::fs::rename(&tmp, &p).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Couldn't save {path}: {e}")
    })?;
    touch_recent(&app, &p);
    Ok(())
}

fn percent_decode(s: &str) -> Result<String, String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = std::str::from_utf8(b.get(i + 1..i + 3).ok_or("Bad path")?).map_err(|_| "Bad path")?;
            out.push(u8::from_str_radix(hex, 16).map_err(|_| "Bad path")?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "Bad path".into())
}

fn keep_history(app: &AppHandle, p: &Path) -> Result<(), String> {
    let dir = history_dir(app, p)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let _ = std::fs::write(dir.join("source.txt"), p.to_string_lossy().as_bytes());
    std::fs::copy(p, dir.join(format!("{}.whittle", now_ms()))).map_err(|e| e.to_string())?;
    let mut versions = history_files(&dir);
    versions.sort_by_key(|v| std::cmp::Reverse(v.0));
    for (_, old) in versions.into_iter().skip(MAX_HISTORY) {
        let _ = std::fs::remove_file(old);
    }
    Ok(())
}

fn history_files(dir: &Path) -> Vec<(u64, PathBuf)> {
    std::fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(Result::ok)
                .filter_map(|e| {
                    let p = e.path();
                    let stamp = p.file_stem()?.to_str()?.parse::<u64>().ok()?;
                    is_design(&p).then_some((stamp, p))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Earlier saves of a design, newest first.
#[tauri::command]
fn list_history(app: AppHandle, state: State<'_, AppData>, path: String) -> Result<Vec<HistoryEntry>, String> {
    let p = PathBuf::from(&path);
    check_allowed(&state, &p)?;
    let mut list: Vec<HistoryEntry> = history_files(&history_dir(&app, &p)?)
        .into_iter()
        .map(|(stamp, f)| HistoryEntry { id: stamp.to_string(), saved_at: stamp, size: f.metadata().map(|m| m.len()).unwrap_or(0) })
        .collect();
    list.sort_by_key(|e| std::cmp::Reverse(e.saved_at));
    Ok(list)
}

#[tauri::command]
fn read_history(app: AppHandle, state: State<'_, AppData>, path: String, id: String) -> Result<Response, String> {
    let p = PathBuf::from(&path);
    check_allowed(&state, &p)?;
    if !id.chars().all(|c| c.is_ascii_digit()) {
        return Err("Bad version id".into());
    }
    let f = history_dir(&app, &p)?.join(format!("{id}.whittle"));
    std::fs::read(f).map(Response::new).map_err(|e| e.to_string())
}

/* ───────────────────────── Opening files from the OS ───────────────────────── */

fn design_args(args: &[String]) -> Vec<String> {
    args.iter().skip(1).filter(|a| a.to_lowercase().ends_with(".whittle")).cloned().collect()
}

/// Files the OS asked us to open before the UI was listening.
#[tauri::command]
fn startup_files(state: State<'_, AppData>) -> Vec<String> {
    std::mem::take(&mut *state.pending.lock().unwrap())
}

fn open_from_os(app: &AppHandle, paths: Vec<String>) {
    let state = app.state::<AppData>();
    for p in &paths {
        allow(&state, Path::new(p));
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
    for p in paths {
        // Queue it too, in case the page is still loading and misses the event.
        state.pending.lock().unwrap().push(p.clone());
        let _ = app.emit(OPEN_EVENT, p);
    }
}

/// A release version as the app compares them: three plain numbers (1.2.3).
fn release_version(v: &str) -> bool {
    let parts: Vec<&str> = v.split('.').collect();
    parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.len() <= 6 && p.bytes().all(|b| b.is_ascii_digit()))
}

/// Open a release's download page in the default browser. Only that page can be opened this way.
#[tauri::command]
fn open_release(version: String) -> Result<(), String> {
    if !release_version(&version) {
        return Err("That isn't a version number.".into());
    }
    let url = format!("{RELEASES}{version}");
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("rundll32");
        c.args(["url.dll,FileProtocolHandler", &url]);
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.arg(&url);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(&url);
        c
    };
    cmd.spawn().map(|_| ()).map_err(|e| format!("Couldn't open the browser: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // Must be first: a second launch (e.g. double-clicking another design) goes to the open window.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let files = design_args(&args);
            if files.is_empty() {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
            } else {
                open_from_os(app, files);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(AppData::default())
        .invoke_handler(tauri::generate_handler![
            startup_files,
            open_dialog,
            save_dialog,
            ask_dialog,
            read_file,
            write_file,
            recent_files,
            forget_recent,
            list_history,
            read_history,
            open_release
        ])
        .setup(|app| {
            let state = app.state::<AppData>();
            let args: Vec<String> = std::env::args().collect();
            let files = design_args(&args);
            for f in &files {
                allow(&state, Path::new(f));
            }
            state.pending.lock().unwrap().extend(files);
            for r in load_recent(app.handle()) {
                allow(&state, Path::new(&r.path));
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while starting Whittle");

    app.run(|_app, _event| {
        // macOS delivers double-clicked files as an event, not as arguments.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = _event {
            let files: Vec<String> = urls
                .iter()
                .filter_map(|u| u.to_file_path().ok())
                .filter(|p| is_design(p))
                .map(|p| p.to_string_lossy().to_string())
                .collect();
            if !files.is_empty() {
                open_from_os(_app, files);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_paths() {
        assert_eq!(percent_decode("C%3A%5CUsers%5CAda%20L%5Cpart.whittle").unwrap(), "C:\\Users\\Ada L\\part.whittle");
        assert_eq!(percent_decode("/home/ada/caf%C3%A9.whittle").unwrap(), "/home/ada/café.whittle");
        assert!(percent_decode("%zz").is_err());
    }

    #[test]
    fn only_release_versions_open_a_page() {
        assert!(release_version("0.11.0"));
        assert!(release_version("12.3.45"));
        for bad in ["0.11", "0.11.0-beta", "1.2.3/../../x", "v1.2.3", "1..3", "", "1.2.3.4"] {
            assert!(!release_version(bad), "{bad}");
        }
    }

    #[test]
    fn path_keys_are_stable() {
        assert_eq!(path_key(Path::new("/a/b.whittle")), path_key(Path::new("/A/B.whittle")));
        assert_ne!(path_key(Path::new("/a/b.whittle")), path_key(Path::new("/a/c.whittle")));
    }
}
