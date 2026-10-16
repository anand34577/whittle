//! Design storage with version history. Each save adds a version file
//! (`designs/<id>/v<n>.whittle`); the database tracks owners and metadata.
//! Saves use optimistic concurrency: send `If-Match: <version>` and a stale
//! save gets 409 instead of silently overwriting newer work.

use std::io::Read;

use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;
use sqlx::Row;

use crate::{auth::CurrentUser, db::now_ms, random_token, ApiError, ApiResult, Shared};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignInfo {
    id: String,
    name: String,
    size: i64,
    version: i64,
    has_thumbnail: bool,
    created_at: i64,
    updated_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionInfo {
    version: i64,
    size: i64,
    created_at: i64,
    author: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    id: String,
    version: i64,
    name: String,
}

/// The most a design's document.json may expand to.
const MAX_DOCUMENT_BYTES: u64 = 256 * 1024 * 1024;

struct Parsed {
    name: String,
    thumbnail: Option<Vec<u8>>,
}

/// Check an upload is a real .whittle (ZIP with document.json) and pull out its name and thumbnail.
fn parse_whittle(bytes: &[u8]) -> Result<Parsed, String> {
    if bytes.len() < 4 || &bytes[..4] != b"PK\x03\x04" {
        return Err("That isn't a Whittle design file".into());
    }
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|_| "The design file is damaged".to_string())?;
    // Only the name is needed, so the document is checked as JSON without building the whole tree in memory.
    #[derive(serde::Deserialize)]
    struct Head {
        name: Option<String>,
    }
    let doc: Head = {
        let mut f = zip.by_name("document.json").map_err(|_| "The design file has no document.json".to_string())?;
        if f.size() > MAX_DOCUMENT_BYTES {
            return Err("The design is too large".into());
        }
        // The size in the ZIP header is only a claim; cap what is actually decompressed.
        let mut s = String::new();
        f.by_ref().take(MAX_DOCUMENT_BYTES + 1).read_to_string(&mut s).map_err(|_| "The design file is damaged".to_string())?;
        if s.len() as u64 > MAX_DOCUMENT_BYTES {
            return Err("The design is too large".into());
        }
        serde_json::from_str(&s).map_err(|_| "The design's document.json isn't valid".to_string())?
    };
    let name = doc.name.as_deref().unwrap_or("Untitled").chars().take(200).collect::<String>();
    let thumbnail = match zip.by_name("thumbnail.png") {
        Ok(mut f) if f.size() <= 4 * 1024 * 1024 => {
            let mut v = Vec::new();
            f.by_ref().take(4 * 1024 * 1024 + 1).read_to_end(&mut v).ok().filter(|_| v.len() <= 4 * 1024 * 1024).map(|_| v)
        }
        _ => None,
    };
    Ok(Parsed { name: if name.trim().is_empty() { "Untitled".into() } else { name }, thumbnail })
}

/// A big upload expands to a lot of memory while it is checked, so only a couple are checked at the same time.
static PARSE_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

async fn parse_upload(body: Bytes) -> ApiResult<(Bytes, Parsed)> {
    let _slot = PARSE_SLOTS.acquire().await.map_err(|_| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "Upload failed"))?;
    let b = body.clone();
    let parsed = tokio::task::spawn_blocking(move || parse_whittle(&b))
        .await
        .map_err(|_| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "Upload failed"))?
        .map_err(|e| ApiError::new(StatusCode::UNSUPPORTED_MEDIA_TYPE, e))?;
    Ok((body, parsed))
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn dir(s: &Shared, id: &str) -> std::path::PathBuf {
    s.config.data.join("designs").join(id)
}

fn version_path(s: &Shared, id: &str, v: i64) -> std::path::PathBuf {
    dir(s, id).join(format!("v{v}.whittle"))
}

/// The design's current head version, if `user` owns it (404 otherwise, so ids don't leak).
async fn owned_head(s: &Shared, user_id: &str, id: &str) -> ApiResult<i64> {
    if !valid_id(id) {
        return Err(ApiError::not_found());
    }
    let row = sqlx::query("SELECT head FROM designs WHERE id = $1 AND owner_id = $2")
        .bind(id)
        .bind(user_id)
        .fetch_optional(&s.db)
        .await?
        .ok_or_else(ApiError::not_found)?;
    Ok(row.try_get("head")?)
}

async fn write_atomic(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension(format!("tmp{}", random_token(4)));
    tokio::fs::write(&tmp, bytes).await?;
    if let Err(e) = tokio::fs::rename(&tmp, path).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(e);
    }
    Ok(())
}

fn file_response(bytes: Vec<u8>, version: i64) -> Response {
    (
        [
            (header::CONTENT_TYPE, "application/vnd.whittle+zip".to_owned()),
            (header::CACHE_CONTROL, "no-store".to_owned()),
            (header::HeaderName::from_static("x-whittle-version"), version.to_string()),
        ],
        bytes,
    )
        .into_response()
}

pub async fn list(State(s): State<Shared>, CurrentUser(u): CurrentUser) -> ApiResult<Json<Vec<DesignInfo>>> {
    let rows = sqlx::query(
        "SELECT id, name, size, head, has_thumbnail, created_at, updated_at FROM designs WHERE owner_id = $1 ORDER BY updated_at DESC",
    )
    .bind(&u.id)
    .fetch_all(&s.db)
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        out.push(DesignInfo {
            id: r.try_get("id")?,
            name: r.try_get("name")?,
            size: r.try_get("size")?,
            version: r.try_get("head")?,
            has_thumbnail: r.try_get::<i64, _>("has_thumbnail")? != 0,
            created_at: r.try_get("created_at")?,
            updated_at: r.try_get("updated_at")?,
        });
    }
    Ok(Json(out))
}

pub async fn create(State(s): State<Shared>, CurrentUser(u): CurrentUser, body: Bytes) -> ApiResult<(StatusCode, Json<Saved>)> {
    let (bytes, parsed) = parse_upload(body).await?;
    let id = random_token(12);
    tokio::fs::create_dir_all(dir(&s, &id)).await?;
    write_atomic(&version_path(&s, &id, 1), &bytes).await?;
    if let Some(t) = &parsed.thumbnail {
        write_atomic(&dir(&s, &id).join("thumb.png"), t).await?;
    }
    let now = now_ms();
    let mut tx = s.db.begin().await?;
    sqlx::query(
        "INSERT INTO designs (id, owner_id, name, size, head, has_thumbnail, created_at, updated_at) VALUES ($1, $2, $3, $4, 1, $5, $6, $6)",
    )
    .bind(&id)
    .bind(&u.id)
    .bind(&parsed.name)
    .bind(bytes.len() as i64)
    .bind(parsed.thumbnail.is_some() as i64)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO design_versions (design_id, version, size, created_at, author_id) VALUES ($1, 1, $2, $3, $4)")
        .bind(&id)
        .bind(bytes.len() as i64)
        .bind(now)
        .bind(&u.id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(Saved { id, version: 1, name: parsed.name })))
}

pub async fn download(State(s): State<Shared>, CurrentUser(u): CurrentUser, Path(id): Path<String>) -> ApiResult<Response> {
    let head = owned_head(&s, &u.id, &id).await?;
    let bytes = tokio::fs::read(version_path(&s, &id, head)).await?;
    Ok(file_response(bytes, head))
}

/// Store `bytes` as the next version. `expected` = the head the client last saw.
async fn add_version(s: &Shared, user_id: &str, id: &str, head: i64, expected: Option<i64>, bytes: &[u8], parsed: &Parsed) -> ApiResult<i64> {
    if expected.is_some_and(|e| e != head) {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            format!("This design was saved somewhere else since you opened it (now version {head})."),
        ));
    }
    let next = head + 1;
    let path = version_path(s, id, next);
    // A name of its own: two saves racing for the same version must not share one file.
    let tmp = path.with_extension(format!("pending-{}", random_token(6)));
    tokio::fs::write(&tmp, bytes).await?;
    let now = now_ms();
    let mut tx = s.db.begin().await?;
    let moved = sqlx::query(
        "UPDATE designs SET head = $1, name = $2, size = $3, has_thumbnail = $4, updated_at = $5 WHERE id = $6 AND head = $7",
    )
    .bind(next)
    .bind(&parsed.name)
    .bind(bytes.len() as i64)
    .bind(parsed.thumbnail.is_some() as i64)
    .bind(now)
    .bind(id)
    .bind(head)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if moved != 1 {
        drop(tx);
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(ApiError::new(StatusCode::CONFLICT, "Another save happened at the same time. Try again."));
    }
    sqlx::query("INSERT INTO design_versions (design_id, version, size, created_at, author_id) VALUES ($1, $2, $3, $4, $5)")
        .bind(id)
        .bind(next)
        .bind(bytes.len() as i64)
        .bind(now)
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    tokio::fs::rename(&tmp, &path).await?;
    tx.commit().await?;
    let thumb = dir(s, id).join("thumb.png");
    match &parsed.thumbnail {
        Some(t) => write_atomic(&thumb, t).await?,
        None => {
            let _ = tokio::fs::remove_file(&thumb).await;
        }
    }
    prune(s, id).await?;
    Ok(next)
}

async fn prune(s: &Shared, id: &str) -> ApiResult<()> {
    let rows = sqlx::query("SELECT version FROM design_versions WHERE design_id = $1 ORDER BY version DESC")
        .bind(id)
        .fetch_all(&s.db)
        .await?;
    for r in rows.iter().skip(s.config.max_versions as usize) {
        let v: i64 = r.try_get("version")?;
        sqlx::query("DELETE FROM design_versions WHERE design_id = $1 AND version = $2").bind(id).bind(v).execute(&s.db).await?;
        let _ = tokio::fs::remove_file(version_path(s, id, v)).await;
    }
    Ok(())
}

pub async fn save(State(s): State<Shared>, CurrentUser(u): CurrentUser, Path(id): Path<String>, headers: HeaderMap, body: Bytes) -> ApiResult<Json<Saved>> {
    let head = owned_head(&s, &u.id, &id).await?;
    let expected = match headers.get(header::IF_MATCH).and_then(|v| v.to_str().ok()) {
        Some(v) => Some(v.trim().trim_matches('"').parse::<i64>().map_err(|_| ApiError::bad_request("Bad If-Match header"))?),
        None => None,
    };
    let (bytes, parsed) = parse_upload(body).await?;
    let version = add_version(&s, &u.id, &id, head, expected, &bytes, &parsed).await?;
    Ok(Json(Saved { id, version, name: parsed.name }))
}

pub async fn remove(State(s): State<Shared>, CurrentUser(u): CurrentUser, Path(id): Path<String>) -> ApiResult<StatusCode> {
    owned_head(&s, &u.id, &id).await?;
    delete_design(&s, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_design(s: &Shared, id: &str) -> ApiResult<()> {
    sqlx::query("DELETE FROM design_versions WHERE design_id = $1").bind(id).execute(&s.db).await?;
    sqlx::query("DELETE FROM designs WHERE id = $1").bind(id).execute(&s.db).await?;
    let _ = tokio::fs::remove_dir_all(dir(s, id)).await;
    Ok(())
}

/// Remove every design a user owns (used when an administrator deletes the account).
pub async fn delete_all_for(s: &Shared, user_id: &str) -> ApiResult<()> {
    let rows = sqlx::query("SELECT id FROM designs WHERE owner_id = $1").bind(user_id).fetch_all(&s.db).await?;
    for r in rows {
        let id: String = r.try_get("id")?;
        delete_design(s, &id).await?;
    }
    Ok(())
}

pub async fn thumbnail(State(s): State<Shared>, CurrentUser(u): CurrentUser, Path(id): Path<String>) -> ApiResult<Response> {
    owned_head(&s, &u.id, &id).await?;
    let bytes = tokio::fs::read(dir(&s, &id).join("thumb.png")).await.map_err(|_| ApiError::not_found())?;
    Ok(([(header::CONTENT_TYPE, "image/png"), (header::CACHE_CONTROL, "private, no-cache")], bytes).into_response())
}

pub async fn versions(State(s): State<Shared>, CurrentUser(u): CurrentUser, Path(id): Path<String>) -> ApiResult<Json<Vec<VersionInfo>>> {
    owned_head(&s, &u.id, &id).await?;
    let rows = sqlx::query(
        "SELECT v.version, v.size, v.created_at, u.display_name FROM design_versions v LEFT JOIN users u ON u.id = v.author_id
         WHERE v.design_id = $1 ORDER BY v.version DESC",
    )
    .bind(&id)
    .fetch_all(&s.db)
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        out.push(VersionInfo {
            version: r.try_get("version")?,
            size: r.try_get("size")?,
            created_at: r.try_get("created_at")?,
            author: r.try_get("display_name")?,
        });
    }
    Ok(Json(out))
}

async fn version_exists(s: &Shared, id: &str, v: i64) -> ApiResult<()> {
    sqlx::query("SELECT version FROM design_versions WHERE design_id = $1 AND version = $2")
        .bind(id)
        .bind(v)
        .fetch_optional(&s.db)
        .await?
        .map(|_| ())
        .ok_or_else(ApiError::not_found)
}

pub async fn download_version(State(s): State<Shared>, CurrentUser(u): CurrentUser, Path((id, v)): Path<(String, i64)>) -> ApiResult<Response> {
    owned_head(&s, &u.id, &id).await?;
    version_exists(&s, &id, v).await?;
    let bytes = tokio::fs::read(version_path(&s, &id, v)).await?;
    Ok(file_response(bytes, v))
}

/// Make an old version the newest one (history is kept: this adds a version).
pub async fn restore(State(s): State<Shared>, CurrentUser(u): CurrentUser, Path((id, v)): Path<(String, i64)>) -> ApiResult<Json<Saved>> {
    let head = owned_head(&s, &u.id, &id).await?;
    version_exists(&s, &id, v).await?;
    let bytes = tokio::fs::read(version_path(&s, &id, v)).await?;
    let (bytes, parsed) = parse_upload(Bytes::from(bytes)).await?;
    let version = add_version(&s, &u.id, &id, head, None, &bytes, &parsed).await?;
    Ok(Json(Saved { id, version, name: parsed.name }))
}
