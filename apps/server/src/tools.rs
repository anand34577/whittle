//! Operator tools behind the command line: backup, restore, database
//! migration (e.g. SQLite to PostgreSQL) and a health check.
//!
//! A backup is one ZIP: `whittle-backup.json` (what and when), each table as
//! JSON lines in `db/`, and every design file in `designs/`. The table dump is
//! database-neutral, so a backup made on SQLite restores into PostgreSQL and
//! the other way round.

use std::{
    fs::File,
    io::{Read, Write},
    path::{Path, PathBuf},
};

use serde_json::{json, Value};
use sqlx::Row;

use crate::{db, Config};

#[derive(Clone, Copy)]
enum Ty {
    Text,
    OptText,
    Int,
    OptInt,
}
use Ty::*;

/// Every table worth keeping, with its columns. Sessions and reset links are
/// deliberately left out: people simply sign in again.
const TABLES: &[(&str, &[(&str, Ty)])] = &[
    (
        "users",
        &[
            ("id", Text),
            ("username", Text),
            ("display_name", Text),
            ("email", OptText),
            ("password_hash", OptText),
            ("oidc_subject", OptText),
            ("is_admin", Int),
            ("disabled", Int),
            ("created_at", Int),
            ("last_login_at", OptInt),
            ("sso_link", Int),
        ],
    ),
    ("designs", &[("id", Text), ("owner_id", Text), ("name", Text), ("size", Int), ("head", Int), ("has_thumbnail", Int), ("created_at", Int), ("updated_at", Int)]),
    ("design_versions", &[("design_id", Text), ("version", Int), ("size", Int), ("created_at", Int), ("author_id", OptText)]),
    ("settings", &[("key", Text), ("value", Text)]),
    ("user_data", &[("user_id", Text), ("key", Text), ("value", Text), ("updated_at", Int)]),
    ("audit_log", &[("id", Text), ("at", Int), ("actor", OptText), ("action", Text), ("target", OptText), ("detail", OptText)]),
];

type Dump = Vec<(String, Vec<Vec<Value>>)>;

async fn dump(pool: &db::Db) -> Result<Dump, String> {
    let mut out = Vec::new();
    for (table, cols) in TABLES {
        let names: Vec<&str> = cols.iter().map(|c| c.0).collect();
        let rows = sqlx::query(&format!("SELECT {} FROM {table}", names.join(", "))).fetch_all(pool).await.map_err(|e| format!("reading {table}: {e}"))?;
        let mut list = Vec::with_capacity(rows.len());
        for r in rows {
            let mut vals = Vec::with_capacity(cols.len());
            for (name, ty) in *cols {
                let v = match ty {
                    Text => json!(r.try_get::<String, _>(*name).map_err(|e| e.to_string())?),
                    OptText => json!(r.try_get::<Option<String>, _>(*name).map_err(|e| e.to_string())?),
                    Int => json!(r.try_get::<i64, _>(*name).map_err(|e| e.to_string())?),
                    OptInt => json!(r.try_get::<Option<i64>, _>(*name).map_err(|e| e.to_string())?),
                };
                vals.push(v);
            }
            list.push(vals);
        }
        out.push((table.to_string(), list));
    }
    Ok(out)
}

async fn load(pool: &db::Db, data: &Dump, wipe: bool) -> Result<(), String> {
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    if wipe {
        for t in ["sessions", "password_resets", "audit_log", "settings", "user_data", "design_versions", "designs", "users"] {
            sqlx::query(&format!("DELETE FROM {t}")).execute(&mut *tx).await.map_err(|e| format!("clearing {t}: {e}"))?;
        }
    }
    for (table, rows) in data {
        let Some((_, cols)) = TABLES.iter().find(|(t, _)| t == table) else { continue };
        let names: Vec<&str> = cols.iter().map(|c| c.0).collect();
        let marks: Vec<String> = (1..=cols.len()).map(|i| format!("${i}")).collect();
        let sql = format!("INSERT INTO {table} ({}) VALUES ({})", names.join(", "), marks.join(", "));
        for row in rows {
            let mut q = sqlx::query(&sql);
            for ((_, ty), v) in cols.iter().zip(row) {
                q = match ty {
                    Text => q.bind(v.as_str().unwrap_or_default().to_owned()),
                    OptText => q.bind(v.as_str().map(str::to_owned)),
                    Int => q.bind(v.as_i64().unwrap_or_default()),
                    OptInt => q.bind(v.as_i64()),
                };
            }
            q.execute(&mut *tx).await.map_err(|e| format!("writing {table}: {e}"))?;
        }
    }
    tx.commit().await.map_err(|e| e.to_string())
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
    if !dir.exists() {
        return Ok(());
    }
    for e in std::fs::read_dir(dir)? {
        let p = e?.path();
        if p.is_dir() {
            walk(&p, out)?;
        } else {
            out.push(p);
        }
    }
    Ok(())
}

/// A new file only its owner can read: a backup holds password hashes and the mail password.
fn create_private(path: &Path) -> std::io::Result<File> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

/// Write a complete backup to `file`. Safe while the server runs (SQLite WAL / PostgreSQL MVCC).
pub async fn backup(config: &Config, file: &Path) -> Result<String, String> {
    let pool = db::connect(&config.database_url).await.map_err(|e| format!("cannot open the database: {e}"))?;
    let data = dump(&pool).await?;
    let mut files = Vec::new();
    let designs = config.data.join("designs");
    walk(&designs, &mut files).map_err(|e| e.to_string())?;
    let out = create_private(file).map_err(|e| format!("cannot create {}: {e}", file.display()))?;
    let mut zip = zip::ZipWriter::new(out);
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let manifest = json!({
        "format": "whittle-backup",
        "version": 1,
        "app": env!("CARGO_PKG_VERSION"),
        "createdAt": db::now_ms(),
        "tables": data.iter().map(|(t, r)| json!({ "name": t, "rows": r.len() })).collect::<Vec<_>>(),
        "files": files.len(),
    });
    zip.start_file("whittle-backup.json", opts).map_err(|e| e.to_string())?;
    zip.write_all(serde_json::to_string_pretty(&manifest).unwrap().as_bytes()).map_err(|e| e.to_string())?;
    for (table, rows) in &data {
        zip.start_file(format!("db/{table}.jsonl"), opts).map_err(|e| e.to_string())?;
        for r in rows {
            zip.write_all(serde_json::to_string(r).unwrap().as_bytes()).map_err(|e| e.to_string())?;
            zip.write_all(b"\n").map_err(|e| e.to_string())?;
        }
    }
    // Design files are already compressed ZIPs: store them as they are.
    let stored = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for f in &files {
        let rel = f.strip_prefix(&config.data).map_err(|e| e.to_string())?.to_string_lossy().replace('\\', "/");
        if rel.contains(".pending") || rel.contains(".tmp") {
            continue;
        }
        zip.start_file(rel, stored).map_err(|e| e.to_string())?;
        let mut src = File::open(f).map_err(|e| e.to_string())?;
        std::io::copy(&mut src, &mut zip).map_err(|e| e.to_string())?;
    }
    zip.finish().map_err(|e| e.to_string())?;
    let users = data.iter().find(|(t, _)| t == "users").map(|(_, r)| r.len()).unwrap_or(0);
    let designs_n = data.iter().find(|(t, _)| t == "designs").map(|(_, r)| r.len()).unwrap_or(0);
    Ok(format!("backed up {users} accounts, {designs_n} designs and {} files to {}", files.len(), file.display()))
}

/// Restore a backup into the configured database and data directory.
/// Refuses to overwrite existing accounts unless `force`.
pub async fn restore(config: &Config, file: &Path, force: bool) -> Result<String, String> {
    let f = File::open(file).map_err(|e| format!("cannot open {}: {e}", file.display()))?;
    let mut zip = zip::ZipArchive::new(f).map_err(|_| "that isn't a Whittle backup (not a ZIP file)".to_string())?;
    {
        let mut m = zip.by_name("whittle-backup.json").map_err(|_| "that isn't a Whittle backup (no whittle-backup.json)".to_string())?;
        let mut s = String::new();
        m.read_to_string(&mut s).map_err(|e| e.to_string())?;
        let v: Value = serde_json::from_str(&s).map_err(|e| e.to_string())?;
        if v["format"] != "whittle-backup" {
            return Err("that isn't a Whittle backup".into());
        }
        if v["version"].as_i64().unwrap_or(0) > 1 {
            return Err("this backup was made by a newer Whittle. Upgrade the server first.".into());
        }
    }
    // A fresh machine has no data directory yet (SQLite can't create its file without one).
    std::fs::create_dir_all(config.data.join("designs")).map_err(|e| format!("cannot create {}: {e}", config.data.display()))?;
    let mut data: Dump = Vec::new();
    for (table, _) in TABLES {
        let Ok(mut f) = zip.by_name(&format!("db/{table}.jsonl")) else { continue };
        let mut s = String::new();
        f.read_to_string(&mut s).map_err(|e| e.to_string())?;
        let rows = s.lines().filter(|l| !l.trim().is_empty()).map(|l| serde_json::from_str::<Vec<Value>>(l).map_err(|e| e.to_string())).collect::<Result<Vec<_>, _>>()?;
        data.push((table.to_string(), rows));
    }
    let pool = db::connect(&config.database_url).await.map_err(|e| format!("cannot open the database: {e}"))?;
    let existing = db::user_count(&pool).await.map_err(|e| e.to_string())?;
    if existing > 0 && !force {
        return Err(format!("the database already has {existing} account(s). Restore into an empty server, or add --force to replace everything."));
    }
    load(&pool, &data, true).await?;
    // Then the design files.
    let designs = config.data.join("designs");
    if force && designs.exists() {
        std::fs::remove_dir_all(&designs).map_err(|e| e.to_string())?;
    }
    let mut n = 0;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let Some(rel) = entry.enclosed_name() else { continue };
        if !rel.starts_with("designs") || entry.is_dir() {
            continue;
        }
        let dest = config.data.join(rel);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out = File::create(&dest).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        n += 1;
    }
    let users = data.iter().find(|(t, _)| t == "users").map(|(_, r)| r.len()).unwrap_or(0);
    Ok(format!("restored {users} accounts and {n} design files. Everyone signs in again."))
}

/// Copy everything from the configured database into another one (designs on disk stay put).
pub async fn migrate_db(config: &Config, to: &str, force: bool) -> Result<String, String> {
    if to == config.database_url {
        return Err("the target is the database already in use".into());
    }
    let from = db::connect(&config.database_url).await.map_err(|e| format!("cannot open the current database: {e}"))?;
    let target = db::connect(to).await.map_err(|e| format!("cannot open the target database: {e}"))?;
    let existing = db::user_count(&target).await.map_err(|e| e.to_string())?;
    if existing > 0 && !force {
        return Err(format!("the target already has {existing} account(s). Use an empty database, or add --force to replace its contents."));
    }
    let data = dump(&from).await?;
    load(&target, &data, true).await?;
    let summary: Vec<String> = data.iter().map(|(t, r)| format!("{t}: {}", r.len())).collect();
    Ok(format!("copied {}.\nNow set WHITTLE_DATABASE_URL to the new database and restart the server.", summary.join(", ")))
}

/// Check the configuration and everything the server depends on. Returns (report, all ok).
pub async fn doctor(config: &Config) -> (String, bool) {
    let mut lines = Vec::new();
    let mut ok = true;
    // Some(true) ok, Some(false) failure, None for information.
    let mut check = |good: Option<bool>, what: String| {
        ok &= good != Some(false);
        lines.push(format!("{} {what}", match good { Some(true) => "ok  ", Some(false) => "FAIL", None => "info" }));
    };
    check(Some(true), format!("whittle-server {}", env!("CARGO_PKG_VERSION")));
    let web = config.web.join("index.html").exists();
    check(Some(web), format!("web app at {}", config.web.display()));
    let probe = config.data.join(".doctor");
    let writable = std::fs::create_dir_all(&config.data).and_then(|_| std::fs::write(&probe, b"ok")).and_then(|_| std::fs::remove_file(&probe)).is_ok();
    check(Some(writable), format!("data directory {} is writable", config.data.display()));
    match db::connect(&config.database_url).await {
        Ok(pool) => {
            let users = db::user_count(&pool).await.unwrap_or(-1);
            check(Some(true), format!("database ({}) opens and is up to date; {users} account(s)", if config.database_url.starts_with("postgres") { "PostgreSQL" } else { "SQLite" }));
            match crate::settings::ServerSettings::load(&pool, config).await {
                Ok(s) if s.smtp.configured() => check(Some(true), format!("email via {}:{} ({:?})", s.smtp.host, s.smtp.port, s.smtp.security)),
                Ok(_) => check(None, "email isn't set up (password reset and notifications are off)".into()),
                Err(e) => check(Some(false), format!("settings: {e}")),
            }
        }
        Err(e) => check(Some(false), format!("database: {e}")),
    }
    let mode = if config.auth_none { "none (no sign-in)".to_owned() } else { [config.auth_local.then_some("local"), config.oidc.as_ref().map(|_| "oidc")].into_iter().flatten().collect::<Vec<_>>().join(" + ") };
    check(Some(true), format!("sign-in: {mode}"));
    if let Some(o) = &config.oidc {
        let url = format!("{}/.well-known/openid-configuration", o.issuer.trim_end_matches('/'));
        let reachable = match tokio::time::timeout(std::time::Duration::from_secs(8), reqwest_get(&url)).await {
            Ok(Ok(code)) => code == 200,
            _ => false,
        };
        check(Some(reachable), format!("single sign-on provider reachable ({url})"));
    }
    if config.public_url.is_none() {
        check(None, "WHITTLE_PUBLIC_URL isn't set: \"Forgot password?\" stays off, and links in emails sent by administrators use the address they browse to".into());
    }
    (lines.join("\n"), ok)
}

async fn reqwest_get(url: &str) -> Result<u16, String> {
    let client = openidconnect::reqwest::Client::new();
    client.get(url).send().await.map(|r| r.status().as_u16()).map_err(|e| e.to_string())
}
