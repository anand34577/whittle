//! Accounts and sessions: local username/password (Argon2id), cookie
//! sessions, brute-force protection, self-service profile and password reset
//! by email. In "none" mode every request acts as the built-in `local` user.
//! Administration lives in admin.rs.

use std::{
    net::SocketAddr,
    time::{Duration, Instant},
};

use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use axum::{
    extract::{ConnectInfo, FromRequestParts, State},
    http::{header, request::Parts, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use sqlx::Row;

use crate::{
    db::{self, now_ms, NewUser, User},
    mail, random_token, ApiError, ApiResult, Shared,
};

pub const COOKIE: &str = "whittle_session";
const MAX_FAILURES: u32 = 10;
const FAILURE_WINDOW: Duration = Duration::from_secs(15 * 60);
/// Password reset links last one hour.
const RESET_TTL_MS: i64 = 60 * 60 * 1000;

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

/// A light check: one @, something on both sides, a dot in the domain, no spaces.
pub fn check_email(e: &str) -> Result<(), String> {
    let ok = e.len() <= 254
        && !e.contains(char::is_whitespace)
        && e.split_once('@').is_some_and(|(local, domain)| !local.is_empty() && domain.contains('.') && !domain.starts_with('.') && !domain.ends_with('.') && !domain.contains('@'));
    if ok {
        Ok(())
    } else {
        Err(format!("\"{e}\" isn't a valid email address"))
    }
}

/// Validate an optional email for an account: format, uniqueness and (when required) presence.
pub async fn clean_email(s: &Shared, email: Option<&str>, except: Option<&str>, required: bool) -> ApiResult<Option<String>> {
    let email = email.map(str::trim).filter(|e| !e.is_empty());
    match email {
        None if required => Err(ApiError::bad_request("An email address is required")),
        None => Ok(None),
        Some(e) => {
            check_email(e).map_err(ApiError::bad_request)?;
            if db::email_taken(&s.db, e, except).await? {
                return Err(ApiError::new(StatusCode::CONFLICT, "Another account already uses that email address"));
            }
            Ok(Some(e.to_owned()))
        }
    }
}

/* ───────────────────────── Sessions ───────────────────────── */

pub fn session_id(token: &str) -> String {
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
    sqlx::query("UPDATE users SET last_login_at = $1 WHERE id = $2").bind(now).bind(user_id).execute(&s.db).await?;
    // Opportunistic cleanup of expired sessions and reset links.
    sqlx::query("DELETE FROM sessions WHERE expires_at < $1").bind(now).execute(&s.db).await?;
    sqlx::query("DELETE FROM password_resets WHERE expires_at < $1").bind(now).execute(&s.db).await?;
    Ok(session_cookie(s, &token, ttl))
}

/// The signed-in user for a request's cookies, if any (disabled accounts count as signed out).
pub async fn user_from_headers(s: &Shared, headers: &HeaderMap) -> ApiResult<Option<User>> {
    if s.config.auth_none {
        return Ok(db::user_by(&s.db, "id", "local").await?);
    }
    let Some(token) = cookie_token(headers) else { return Ok(None) };
    let Some(row) = sqlx::query("SELECT user_id FROM sessions WHERE id = $1 AND expires_at > $2")
        .bind(session_id(&token))
        .bind(now_ms())
        .fetch_optional(&s.db)
        .await?
    else {
        return Ok(None);
    };
    let user_id: String = row.try_get("user_id")?;
    Ok(db::user_by(&s.db, "id", &user_id).await?.filter(|u| !u.disabled))
}

/// The signed-in user. Rejects with 401 when there is none.
pub struct CurrentUser(pub User);

impl FromRequestParts<Shared> for CurrentUser {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, s: &Shared) -> Result<Self, Self::Rejection> {
        user_from_headers(s, &parts.headers)
            .await?
            .map(CurrentUser)
            .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "Please sign in"))
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

/// The address people use to reach this server (for links in emails).
pub fn base_url(s: &Shared, headers: &HeaderMap) -> String {
    if let Some(u) = &s.config.public_url {
        return u.clone();
    }
    let host = headers.get(header::HOST).and_then(|h| h.to_str().ok()).unwrap_or("localhost");
    let proto = headers.get("x-forwarded-proto").and_then(|h| h.to_str().ok()).unwrap_or(if s.config.secure_cookies { "https" } else { "http" });
    format!("{proto}://{host}")
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
    // People may sign in with their username or their email address.
    let login = b.username.trim();
    let mut user = db::user_by(&s.db, "username", login).await?;
    if user.is_none() && login.contains('@') {
        let sql = format!("SELECT {} FROM users WHERE LOWER(email) = LOWER($1)", db::USER_COLUMNS);
        let rows = sqlx::query(&sql).bind(login).fetch_all(&s.db).await?;
        if let [r] = rows.as_slice() {
            user = Some(db::user_from_row(r)?);
        }
    }
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
        if e.0 == MAX_FAILURES {
            db::audit(&s.db, None, "login.locked", Some(login), &format!("10 failed sign-ins from {addr}")).await;
        }
        return Err(ApiError::new(StatusCode::UNAUTHORIZED, "Wrong username or password"));
    };
    if user.disabled {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "This account is disabled"));
    }
    s.login_failures.lock().await.remove(&key);
    let cookie = start_session(&s, &user.id).await?;
    let user = db::user_by(&s.db, "id", &user.id).await?.ok_or_else(ApiError::not_found)?;
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

pub async fn register(State(s): State<Shared>, headers: HeaderMap, Json(b): Json<RegisterBody>) -> ApiResult<Response> {
    if !s.config.auth_local {
        return Err(ApiError::bad_request("Accounts are managed by single sign-on on this server"));
    }
    let first = db::user_count(&s.db).await? == 0;
    let (signup, require_email) = {
        let st = s.settings.read().await;
        (st.signup(&s.config), st.require_email())
    };
    if !first && !signup {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Sign-up is closed. Ask an administrator for an account."));
    }
    let email = clean_email(&s, b.email.as_deref(), None, require_email).await?;
    let user = create_local_user(&s, &b.username, Some(&b.password), b.display_name.as_deref(), email.as_deref(), first).await?;
    db::audit(&s.db, Some(&user.id), if first { "setup.admin" } else { "account.signup" }, Some(&user.username), "").await;
    if !first && s.settings.read().await.notifications.admin_on_signup {
        let base = base_url(&s, &headers);
        let admins = sqlx::query("SELECT email FROM users WHERE is_admin = 1 AND disabled = 0 AND email IS NOT NULL AND id <> 'local'").fetch_all(&s.db).await?;
        for r in admins {
            let to: Option<String> = r.try_get("email")?;
            mail::notify(
                &s,
                to,
                format!("New Whittle account: {}", user.username),
                format!("{} ({}) just created an account on {base}.\nManage accounts in Whittle: Account → Administration.{}", user.display_name, user.username, mail::signature(&base)),
            );
        }
    }
    let cookie = start_session(&s, &user.id).await?;
    Ok(([(header::SET_COOKIE, cookie)], (StatusCode::CREATED, Json(user))).into_response())
}

/// `password: None` makes a password-less account (single sign-on, or an invitation
/// that sets its password from an emailed link).
pub async fn create_local_user(
    s: &Shared,
    username: &str,
    password: Option<&str>,
    display_name: Option<&str>,
    email: Option<&str>,
    is_admin: bool,
) -> ApiResult<User> {
    let username = username.trim();
    check_username(username).map_err(ApiError::bad_request)?;
    if let Some(p) = password {
        check_password_rules(p).map_err(ApiError::bad_request)?;
    }
    if db::user_by(&s.db, "username", username).await?.is_some() {
        return Err(ApiError::new(StatusCode::CONFLICT, "That username is taken"));
    }
    let hash = match password {
        Some(p) => Some(hash_password(p.to_owned()).await?),
        None => None,
    };
    let id = random_token(12);
    let display = display_name.map(str::trim).filter(|d| !d.is_empty()).unwrap_or(username);
    let email = email.map(str::trim).filter(|e| !e.is_empty());
    db::insert_user(&s.db, &id, NewUser { username, display_name: display, email, password_hash: hash.as_deref(), oidc_subject: None, is_admin })
        .await?;
    db::user_by(&s.db, "id", &id).await?.ok_or_else(ApiError::not_found)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileBody {
    display_name: Option<String>,
    email: Option<String>,
}

/// People edit their own name and email.
pub async fn update_me(State(s): State<Shared>, CurrentUser(u): CurrentUser, Json(b): Json<ProfileBody>) -> ApiResult<Json<User>> {
    if s.config.auth_none {
        return Err(ApiError::bad_request("This server has no accounts"));
    }
    if let Some(name) = b.display_name.as_deref().map(str::trim) {
        if name.is_empty() || name.chars().count() > 100 {
            return Err(ApiError::bad_request("Use a name of 1 to 100 characters"));
        }
        sqlx::query("UPDATE users SET display_name = $1 WHERE id = $2").bind(name).bind(&u.id).execute(&s.db).await?;
    }
    if let Some(e) = b.email.as_deref() {
        let required = s.settings.read().await.require_email();
        let email = clean_email(&s, Some(e), Some(&u.id), required).await?;
        sqlx::query("UPDATE users SET email = $1 WHERE id = $2").bind(email).bind(&u.id).execute(&s.db).await?;
        db::audit(&s.db, Some(&u.id), "account.email", Some(&u.username), "changed their email").await;
    }
    Ok(Json(db::user_by(&s.db, "id", &u.id).await?.ok_or_else(ApiError::not_found)?))
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
    db::audit(&s.db, Some(&u.id), "account.password", Some(&u.username), "changed their password").await;
    security_notice(&s, &headers, &u, "Your Whittle password was changed", "Your password was just changed, and your other devices were signed out.");
    Ok(StatusCode::NO_CONTENT)
}

/// Tell someone about a change to their account (if they have an email and notices are on).
pub fn security_notice(s: &Shared, headers: &HeaderMap, u: &User, subject: &str, what: &str) {
    let s2 = s.clone();
    let base = base_url(s, headers);
    let (to, name, subject, what) = (u.email.clone(), u.display_name.clone(), subject.to_owned(), what.to_owned());
    tokio::spawn(async move {
        if !s2.settings.read().await.notifications.security {
            return;
        }
        mail::notify(&s2, to, subject, format!("Hello {name},\n\n{what}\n\nIf this wasn't you, contact your Whittle administrator.{}", mail::signature(&base)));
    });
}

/* ───────────────────────── Password reset by email ───────────────────────── */

/// Create a one-hour reset link for a user (stored hashed, like sessions).
pub async fn reset_link(s: &Shared, base: &str, user_id: &str) -> ApiResult<String> {
    let token = random_token(32);
    sqlx::query("DELETE FROM password_resets WHERE user_id = $1").bind(user_id).execute(&s.db).await?;
    sqlx::query("INSERT INTO password_resets (id, user_id, expires_at) VALUES ($1, $2, $3)")
        .bind(session_id(&token))
        .bind(user_id)
        .bind(now_ms() + RESET_TTL_MS)
        .execute(&s.db)
        .await?;
    Ok(format!("{base}/?reset={token}"))
}

#[derive(Deserialize)]
pub struct ForgotBody {
    login: String,
}

/// Email a reset link. Always answers the same way, so it can't reveal who has an account.
pub async fn forgot(State(s): State<Shared>, headers: HeaderMap, ClientAddr(addr): ClientAddr, Json(b): Json<ForgotBody>) -> ApiResult<StatusCode> {
    if !s.config.auth_local || !s.settings.read().await.smtp.configured() {
        return Err(ApiError::bad_request("Password reset by email isn't available. Ask an administrator."));
    }
    // Share the sign-in rate limit, so this can't be used to flood someone's inbox.
    let key = format!("{addr}|reset");
    {
        let mut f = s.login_failures.lock().await;
        f.retain(|_, (_, at)| at.elapsed() < FAILURE_WINDOW);
        let e = f.entry(key).or_insert((0, Instant::now()));
        e.0 += 1;
        if e.0 > 5 {
            return Err(ApiError::new(StatusCode::TOO_MANY_REQUESTS, "Too many requests. Try again in 15 minutes."));
        }
    }
    let login = b.login.trim();
    let sql = format!("SELECT {} FROM users WHERE (username = $1 OR LOWER(email) = LOWER($1)) AND disabled = 0 AND id <> 'local'", db::USER_COLUMNS);
    let rows = sqlx::query(&sql).bind(login).fetch_all(&s.db).await?;
    if let [r] = rows.as_slice() {
        let u = db::user_from_row(r)?;
        if let Some(to) = u.email.clone() {
            let base = base_url(&s, &headers);
            let link = reset_link(&s, &base, &u.id).await?;
            db::audit(&s.db, Some(&u.id), "account.reset_requested", Some(&u.username), "").await;
            mail::notify(
                &s,
                Some(to),
                "Reset your Whittle password".into(),
                format!(
                    "Hello {},\n\nSomeone (hopefully you) asked to reset the password for your Whittle account \"{}\".\nOpen this link within an hour to choose a new one:\n\n{link}\n\nIf you didn't ask for this, ignore this email: your password stays the same.{}",
                    u.display_name,
                    u.username,
                    mail::signature(&base)
                ),
            );
        }
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetBody {
    token: String,
    new_password: String,
}

pub async fn reset(State(s): State<Shared>, headers: HeaderMap, Json(b): Json<ResetBody>) -> ApiResult<Response> {
    check_password_rules(&b.new_password).map_err(ApiError::bad_request)?;
    let row = sqlx::query("SELECT user_id FROM password_resets WHERE id = $1 AND expires_at > $2")
        .bind(session_id(b.token.trim()))
        .bind(now_ms())
        .fetch_optional(&s.db)
        .await?
        .ok_or_else(|| ApiError::bad_request("This reset link has expired or was already used. Ask for a new one."))?;
    let user_id: String = row.try_get("user_id")?;
    let u = db::user_by(&s.db, "id", &user_id).await?.filter(|u| !u.disabled).ok_or_else(|| ApiError::bad_request("This account is disabled"))?;
    let hash = hash_password(b.new_password).await?;
    sqlx::query("UPDATE users SET password_hash = $1 WHERE id = $2").bind(hash).bind(&u.id).execute(&s.db).await?;
    sqlx::query("DELETE FROM password_resets WHERE user_id = $1").bind(&u.id).execute(&s.db).await?;
    sqlx::query("DELETE FROM sessions WHERE user_id = $1").bind(&u.id).execute(&s.db).await?;
    db::audit(&s.db, Some(&u.id), "account.reset", Some(&u.username), "set a new password from an emailed link").await;
    security_notice(&s, &headers, &u, "Your Whittle password was reset", "Your password was reset using an emailed link, and all devices were signed out.");
    let cookie = start_session(&s, &u.id).await?;
    let u = db::user_by(&s.db, "id", &u.id).await?.ok_or_else(ApiError::not_found)?;
    Ok(([(header::SET_COOKIE, cookie)], Json(u)).into_response())
}
