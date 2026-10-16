//! Per-person data kept on the server instead of in the browser: preferences, the AI assistant's settings
//! (including provider keys) and crash-recovery drafts. Each value is a JSON document under a short key.

use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::{auth::CurrentUser, db::now_ms, ApiError, ApiResult, Shared};

/// One value may hold a whole design draft.
const MAX_VALUE_BYTES: usize = 32 * 1024 * 1024;
/// Keys per person (settings plus a recovery draft per design).
const MAX_KEYS: i64 = 40;

fn valid_key(k: &str) -> bool {
    !k.is_empty() && k.len() <= 80 && k.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '_' | '-' | '.'))
}

fn checked(key: &str) -> ApiResult<()> {
    if valid_key(key) {
        Ok(())
    } else {
        Err(ApiError::bad_request("That key isn't allowed"))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    key: String,
    updated_at: i64,
}

#[derive(Deserialize)]
pub struct ListQuery {
    prefix: Option<String>,
}

/// Keys (newest first), optionally only those starting with `?prefix=`.
pub async fn list(State(s): State<Shared>, CurrentUser(u): CurrentUser, Query(q): Query<ListQuery>) -> ApiResult<Json<Vec<Entry>>> {
    let rows = sqlx::query("SELECT key, updated_at FROM user_data WHERE user_id = $1 ORDER BY updated_at DESC").bind(&u.id).fetch_all(&s.db).await?;
    let prefix = q.prefix.unwrap_or_default();
    let mut out = Vec::new();
    for r in rows {
        let key: String = r.try_get("key")?;
        if key.starts_with(&prefix) {
            out.push(Entry { key, updated_at: r.try_get("updated_at")? });
        }
    }
    Ok(Json(out))
}

pub async fn get(State(s): State<Shared>, CurrentUser(u): CurrentUser, Path(key): Path<String>) -> ApiResult<Response> {
    checked(&key)?;
    let row = sqlx::query("SELECT value FROM user_data WHERE user_id = $1 AND key = $2").bind(&u.id).bind(&key).fetch_optional(&s.db).await?;
    let Some(row) = row else { return Err(ApiError::not_found()) };
    let value: String = row.try_get("value")?;
    Ok(([(header::CONTENT_TYPE, "application/json")], value).into_response())
}

pub async fn put(State(s): State<Shared>, CurrentUser(u): CurrentUser, Path(key): Path<String>, body: Bytes) -> ApiResult<StatusCode> {
    checked(&key)?;
    if body.len() > MAX_VALUE_BYTES {
        return Err(ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "That is too large to keep"));
    }
    // Must be JSON, but is not built into a tree: only checked.
    serde_json::from_slice::<serde::de::IgnoredAny>(&body).map_err(|_| ApiError::bad_request("The value isn't valid JSON"))?;
    let value = String::from_utf8(body.to_vec()).map_err(|_| ApiError::bad_request("The value isn't valid text"))?;
    let others: i64 = sqlx::query("SELECT COUNT(*) AS n FROM user_data WHERE user_id = $1 AND key <> $2").bind(&u.id).bind(&key).fetch_one(&s.db).await?.try_get("n")?;
    if others >= MAX_KEYS {
        return Err(ApiError::new(StatusCode::CONFLICT, "Too many saved items. Delete some first."));
    }
    sqlx::query(
        "INSERT INTO user_data (user_id, key, value, updated_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .bind(&u.id)
    .bind(&key)
    .bind(&value)
    .bind(now_ms())
    .execute(&s.db)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn remove(State(s): State<Shared>, CurrentUser(u): CurrentUser, Path(key): Path<String>) -> ApiResult<StatusCode> {
    checked(&key)?;
    sqlx::query("DELETE FROM user_data WHERE user_id = $1 AND key = $2").bind(&u.id).bind(&key).execute(&s.db).await?;
    Ok(StatusCode::NO_CONTENT)
}
