//! Accounts and sessions: local username/password (Argon2id), cookie
//! sessions, brute-force protection, and administrator user management.
//! In "none" mode every request acts as the built-in `local` user.

use std::{net::SocketAddr, time::{Duration, Instant}};

use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use axum::{
    extract::{ConnectInfo, FromRequestParts, Path, State},
    http::{header, request::Parts, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use sqlx::Row;

use crate::{
    db::{self, now_ms, NewUser, User, USER_COLUMNS},
    random_token, ApiError, ApiResult, Shared,
};

pub const COOKIE: &str = "whittle_session";
const MAX_FAILURES: u32 = 10;
const FAILURE_WINDOW: Duration = Duration::from_secs(15 * 60);

/* ───────────────────────── Passwords ───────────────────────── */

pub async fn hash_password(password: String) -> ApiResult<String> {
    tokio::task::spawn_blocking(move || {
        let salt = SaltString::generate(&mut OsRng);
        Argon2::default().hash_password(password.as_bytes(), &salt).map(|h| h.to_string())
    })
    .await
    .map_err(|_| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "Hashing failed"))?
    .map_err(|_| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "Hashing failed"))
}

async fn verify_password(password: String, hash: String) -> bool {
    tokio::task::spawn_blocking(move || {
        PasswordHash::new(&hash).is_ok_and(|h| Argon2::default().verify_password(password.as_bytes(), &h).is_ok())
    })
    .await
    .unwrap_or(false)
}

pub fn check_password_rules(p: &str) -> Result<(), String> {
    if p.chars().count() < 8 {
        return Err("Use at least 8 characters for the password".into());
    }
    if p.len() > 1024 {
        return Err("That password is too long".into());
    }
    Ok(())
}

pub fn check_username(u: &str) -> Result<(), String> {
    let ok = (1..=64).contains(&u.len()) && u.chars().all(|c| c.is_ascii_alphanumeric() || "._-@".contains(c));
    if !ok {
        return Err("Usernames use letters, digits and . _ - @ (up to 64 characters)".into());
    }
    if u.eq_ignore_ascii_case("local") {
        return Err("\"local\" is reserved".into());
    }
    Ok(())
}

/* ───────────────────────── Sessions ───────────────────────── */

fn session_id(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn cookie_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|kv| kv.trim().split_once('='))
        .find(|(k, _)| *k == COOKIE)
        .map(|(_, v)| v.to_owned())
}

fn session_cookie(s: &Shared, token: &str, max_age_secs: i64) -> HeaderValue {
    let secure = if s.config.secure_cookies { "; Secure" } else { "" };
    HeaderValue::from_str(&format!("{COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age_secs}{secure}"))
        .expect("cookie is ASCII")
}

/// Start a session for `user_id` and return the Set-Cookie header value.
pub async fn start_session(s: &Shared, user_id: &str) -> ApiResult<HeaderValue> {
    let token = random_token(32);
    let now = now_ms();
    let ttl = s.config.session_days * 24 * 3600;
    sqlx::query("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)")
        .bind(session_id(&token))
        .bind(user_id)
        .bind(now)
        .bind(now + ttl * 1000)
        .execute(&s.db)
        .await?;
    // Opportunistic cleanup of expired sessions.
    sqlx::query("DELETE FROM sessions WHERE expires_at < $1").bind(now).execute(&s.db).await?;
    Ok(session_cookie(s, &token, ttl))
}

/// The signed-in user. Rejects with 401 when there is none.
pub struct CurrentUser(pub User);

impl FromRequestParts<Shared> for CurrentUser {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, s: &Shared) -> Result<Self, Self::Rejection> {
        if s.config.auth_none {
            let u = db::user_by(&s.db, "id", "local").await?.ok_or_else(ApiError::not_found)?;
            return Ok(CurrentUser(u));
        }
        let unauthorized = || ApiError::new(StatusCode::UNAUTHORIZED, "Please sign in");
        let token = cookie_token(&parts.headers).ok_or_else(unauthorized)?;
        let row = sqlx::query("SELECT user_id FROM sessions WHERE id = $1 AND expires_at > $2")
            .bind(session_id(&token))
            .bind(now_ms())
            .fetch_optional(&s.db)
            .await?
            .ok_or_else(unauthorized)?;
        let user_id: String = row.try_get("user_id")?;
        let user = db::user_by(&s.db, "id", &user_id).await?.ok_or_else(unauthorized)?;
        if user.disabled {
            return Err(ApiError::new(StatusCode::FORBIDDEN, "This account is disabled"));
        }
        Ok(CurrentUser(user))
    }
}

/// The signed-in user, who must be an administrator.
pub struct AdminUser(pub User);

impl FromRequestParts<Shared> for AdminUser {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, s: &Shared) -> Result<Self, Self::Rejection> {
        let CurrentUser(u) = CurrentUser::from_request_parts(parts, s).await?;
        if !u.is_admin {
            return Err(ApiError::new(StatusCode::FORBIDDEN, "Only administrators can do that"));
        }
        Ok(AdminUser(u))
    }
}

/// The client's address when known (for rate limiting).
pub struct ClientAddr(pub String);

impl<S: Send + Sync> FromRequestParts<S> for ClientAddr {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, Self::Rejection> {
        let ip = parts.extensions.get::<ConnectInfo<SocketAddr>>().map(|c| c.0.ip().to_string());
        Ok(ClientAddr(ip.unwrap_or_else(|| "unknown".into())))
    }
}

pub async fn ensure_local_user(db: &db::Db) -> Result<(), sqlx::Error> {
    if db::user_by(db, "id", "local").await?.is_none() {
        db::insert_user(
            db,
            "local",
            NewUser { username: "local", display_name: "Local user", email: None, password_hash: None, oidc_subject: None, is_admin: true },
        )
        .await?;
    }
    Ok(())
}

/* ───────────────────────── Handlers ───────────────────────── */

pub async fn me(CurrentUser(u): CurrentUser) -> Json<User> {
    Json(u)
}

#[derive(Deserialize)]
pub struct LoginBody {
    username: String,
    password: String,
}

pub async fn login(State(s): State<Shared>, ClientAddr(addr): ClientAddr, Json(b): Json<LoginBody>) -> ApiResult<Response> {
    if !s.config.auth_local {
        return Err(ApiError::bad_request("Password sign-in is turned off on this server"));
    }
    let key = format!("{addr}|{}", b.username.to_ascii_lowercase());
    {
        let mut f = s.login_failures.lock().await;
        f.retain(|_, (_, at)| at.elapsed() < FAILURE_WINDOW);
        if f.get(&key).is_some_and(|(n, _)| *n >= MAX_FAILURES) {
            return Err(ApiError::new(StatusCode::TOO_MANY_REQUESTS, "Too many failed attempts. Try again in 15 minutes."));
        }
    }
    let user = db::user_by(&s.db, "username", b.username.trim()).await?;
    let ok = match user.as_ref().and_then(|u| u.password_hash.clone()) {
        Some(hash) => verify_password(b.password, hash).await,
        None => {
            // Spend the same time as a real check, so timing doesn't reveal which usernames exist.
            let _ = hash_password(b.password).await;
            false
        }
    };
    let Some(user) = user.filter(|_| ok) else {
        let mut f = s.login_failures.lock().await;
        let e = f.entry(key).or_insert((0, Instant::now()));
        e.0 += 1;
        e.1 = Instant::now();
        return Err(ApiError::new(StatusCode::UNAUTHORIZED, "Wrong username or password"));
    };
    if user.disabled {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "This account is disabled"));
    }
    s.login_failures.lock().await.remove(&key);
    let cookie = start_session(&s, &user.id).await?;
    Ok(([(header::SET_COOKIE, cookie)], Json(user)).into_response())
}

pub async fn logout(State(s): State<Shared>, headers: HeaderMap) -> ApiResult<Response> {
    if let Some(token) = cookie_token(&headers) {
        sqlx::query("DELETE FROM sessions WHERE id = $1").bind(session_id(&token)).execute(&s.db).await?;
    }
    Ok(([(header::SET_COOKIE, session_cookie(&s, "", 0))], StatusCode::NO_CONTENT).into_response())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterBody {
    username: String,
    password: String,
    display_name: Option<String>,
    email: Option<String>,
}

pub async fn register(State(s): State<Shared>, Json(b): Json<RegisterBody>) -> ApiResult<Response> {
    if !s.config.auth_local {
        return Err(ApiError::bad_request("Accounts are managed by single sign-on on this server"));
    }
    let first = db::user_count(&s.db).await? == 0;
    if !first && !s.config.signup {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Sign-up is closed. Ask an administrator for an account."));
    }
    let user = create_local_user(&s, &b.username, &b.password, b.display_name.as_deref(), b.email.as_deref(), first).await?;
    let cookie = start_session(&s, &user.id).await?;
    Ok(([(header::SET_COOKIE, cookie)], (StatusCode::CREATED, Json(user))).into_response())
}

pub async fn create_local_user(
    s: &Shared,
    username: &str,
    password: &str,
    display_name: Option<&str>,
    email: Option<&str>,
    is_admin: bool,
) -> ApiResult<User> {
    let username = username.trim();
    check_username(username).map_err(ApiError::bad_request)?;
    check_password_rules(password).map_err(ApiError::bad_request)?;
    if db::user_by(&s.db, "username", username).await?.is_some() {
        return Err(ApiError::new(StatusCode::CONFLICT, "That username is taken"));
    }
    let hash = hash_password(password.to_owned()).await?;
    let id = random_token(12);
    let display = display_name.map(str::trim).filter(|d| !d.is_empty()).unwrap_or(username);
    let email = email.map(str::trim).filter(|e| !e.is_empty());
    db::insert_user(&s.db, &id, NewUser { username, display_name: display, email, password_hash: Some(&hash), oidc_subject: None, is_admin })
        .await?;
    db::user_by(&s.db, "id", &id).await?.ok_or_else(ApiError::not_found)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordBody {
    current: Option<String>,
    new_password: String,
}

pub async fn change_password(State(s): State<Shared>, headers: HeaderMap, CurrentUser(u): CurrentUser, Json(b): Json<PasswordBody>) -> ApiResult<StatusCode> {
    if s.config.auth_none {
        return Err(ApiError::bad_request("This server has no sign-in"));
    }
    if let Some(hash) = u.password_hash.clone() {
        if !verify_password(b.current.unwrap_or_default(), hash).await {
            return Err(ApiError::new(StatusCode::FORBIDDEN, "The current password is wrong"));
        }
    }
    check_password_rules(&b.new_password).map_err(ApiError::bad_request)?;
    let hash = hash_password(b.new_password).await?;
    sqlx::query("UPDATE users SET password_hash = $1 WHERE id = $2").bind(hash).bind(&u.id).execute(&s.db).await?;
    // Sign out everywhere else.
    let keep = cookie_token(&headers).map(|t| session_id(&t)).unwrap_or_default();
    sqlx::query("DELETE FROM sessions WHERE user_id = $1 AND id <> $2").bind(&u.id).bind(keep).execute(&s.db).await?;
    Ok(StatusCode::NO_CONTENT)
}

/* ───────────────────────── Administration ───────────────────────── */

pub async fn admin_list(State(s): State<Shared>, AdminUser(_): AdminUser) -> ApiResult<Json<Vec<User>>> {
    let sql = format!("SELECT {USER_COLUMNS} FROM users WHERE id <> 'local' ORDER BY username");
    let rows = sqlx::query(&sql).fetch_all(&s.db).await?;
    Ok(Json(rows.iter().map(db::user_from_row).collect::<Result<_, _>>()?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminCreateBody {
    username: String,
    password: String,
    display_name: Option<String>,
    email: Option<String>,
    #[serde(default)]
    is_admin: bool,
}

pub async fn admin_create(State(s): State<Shared>, AdminUser(_): AdminUser, Json(b): Json<AdminCreateBody>) -> ApiResult<(StatusCode, Json<User>)> {
    let u = create_local_user(&s, &b.username, &b.password, b.display_name.as_deref(), b.email.as_deref(), b.is_admin).await?;
    Ok((StatusCode::CREATED, Json(u)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminUpdateBody {
    is_admin: Option<bool>,
    disabled: Option<bool>,
    password: Option<String>,
    display_name: Option<String>,
}

async fn admin_count(s: &Shared) -> ApiResult<i64> {
    Ok(sqlx::query("SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND disabled = 0 AND id <> 'local'")
        .fetch_one(&s.db)
        .await?
        .try_get("n")?)
}

pub async fn admin_update(State(s): State<Shared>, AdminUser(me): AdminUser, Path(id): Path<String>, Json(b): Json<AdminUpdateBody>) -> ApiResult<Json<User>> {
    let target = db::user_by(&s.db, "id", &id).await?.filter(|u| u.id != "local").ok_or_else(ApiError::not_found)?;
    let demoting = (b.is_admin == Some(false) || b.disabled == Some(true)) && target.is_admin && !target.disabled;
    if demoting && admin_count(&s).await? <= 1 {
        return Err(ApiError::bad_request("There must be at least one active administrator"));
    }
    if let Some(a) = b.is_admin {
        sqlx::query("UPDATE users SET is_admin = $1 WHERE id = $2").bind(a as i64).bind(&id).execute(&s.db).await?;
    }
    if let Some(d) = b.disabled {
        if d && id == me.id {
            return Err(ApiError::bad_request("You can't disable your own account"));
        }
        sqlx::query("UPDATE users SET disabled = $1 WHERE id = $2").bind(d as i64).bind(&id).execute(&s.db).await?;
        if d {
            sqlx::query("DELETE FROM sessions WHERE user_id = $1").bind(&id).execute(&s.db).await?;
        }
    }
    if let Some(name) = b.display_name.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
        sqlx::query("UPDATE users SET display_name = $1 WHERE id = $2").bind(name).bind(&id).execute(&s.db).await?;
    }
    if let Some(p) = b.password {
        check_password_rules(&p).map_err(ApiError::bad_request)?;
        let hash = hash_password(p).await?;
        sqlx::query("UPDATE users SET password_hash = $1 WHERE id = $2").bind(hash).bind(&id).execute(&s.db).await?;
        sqlx::query("DELETE FROM sessions WHERE user_id = $1").bind(&id).execute(&s.db).await?;
    }
    Ok(Json(db::user_by(&s.db, "id", &id).await?.ok_or_else(ApiError::not_found)?))
}

pub async fn admin_delete(State(s): State<Shared>, AdminUser(me): AdminUser, Path(id): Path<String>) -> ApiResult<StatusCode> {
    if id == me.id {
        return Err(ApiError::bad_request("You can't delete your own account"));
    }
    let target = db::user_by(&s.db, "id", &id).await?.filter(|u| u.id != "local").ok_or_else(ApiError::not_found)?;
    if target.is_admin && !target.disabled && admin_count(&s).await? <= 1 {
        return Err(ApiError::bad_request("There must be at least one active administrator"));
    }
    crate::designs::delete_all_for(&s, &id).await?;
    sqlx::query("DELETE FROM sessions WHERE user_id = $1").bind(&id).execute(&s.db).await?;
    sqlx::query("DELETE FROM users WHERE id = $1").bind(&id).execute(&s.db).await?;
    Ok(StatusCode::NO_CONTENT)
}
