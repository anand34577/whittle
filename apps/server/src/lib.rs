//! whittle-server: serves the Whittle web app, user accounts (none, local,
//! OIDC) and per-user design storage with version history. Geometry runs in
//! the browser, so the server stays small.

pub mod admin;
pub mod auth;
pub mod config;
pub mod db;
pub mod designs;
pub mod mail;
pub mod oidc;
pub mod settings;
pub mod tools;
pub mod userdata;

use std::{collections::HashMap, sync::Arc, time::Instant};

use axum::{
    extract::{DefaultBodyLimit, Request, State},
    http::{header, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::Engine;
use rand::RngCore;
use tokio::sync::{Mutex, RwLock};
use tower_http::{
    compression::CompressionLayer,
    services::{ServeDir, ServeFile},
    set_header::SetResponseHeaderLayer,
    trace::TraceLayer,
};

pub use config::Config;

pub struct AppState {
    pub config: Config,
    pub db: db::Db,
    /// Failed sign-ins per (address, username), for brute-force protection.
    pub login_failures: Mutex<HashMap<String, (u32, Instant)>>,
    pub oidc: oidc::OidcState,
    /// Runtime settings administrators change (sign-up, single sign-on, email).
    pub settings: RwLock<settings::ServerSettings>,
    pub started: Instant,
}

pub type Shared = Arc<AppState>;

/// An API error with a user-facing message, sent as `{ "error": "..." }`.
#[derive(Debug)]
pub struct ApiError(pub StatusCode, pub String);

impl ApiError {
    pub fn new(status: StatusCode, msg: impl Into<String>) -> Self {
        ApiError(status, msg.into())
    }
    pub fn bad_request(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, msg)
    }
    pub fn not_found() -> Self {
        Self::new(StatusCode::NOT_FOUND, "Not found")
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(serde_json::json!({ "error": self.1 }))).into_response()
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        tracing::error!("database error: {e}");
        ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "Database error")
    }
}

impl From<std::io::Error> for ApiError {
    fn from(e: std::io::Error) -> Self {
        tracing::error!("storage error: {e}");
        ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "Storage error")
    }
}

pub type ApiResult<T> = Result<T, ApiError>;

/// A random URL-safe token (`bytes` of entropy).
pub fn random_token(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicConfig {
    version: &'static str,
    /// "none" = no sign-in; "required" = sign in first.
    auth: &'static str,
    local: bool,
    oidc: Option<String>,
    signup: bool,
    /// No accounts yet: the first one becomes the administrator.
    needs_setup: bool,
    max_upload_bytes: usize,
    max_versions: i64,
    /// "Forgot password?" works (email is set up, a public address is configured and passwords are allowed).
    password_reset: bool,
    /// New accounts need an email address.
    require_email: bool,
    /// The AI assistant is allowed on this server.
    ai: bool,
    /// The first account must present the setup token (WHITTLE_SETUP_TOKEN).
    needs_setup_token: bool,
}

async fn public_config(State(s): State<Shared>) -> ApiResult<Json<PublicConfig>> {
    let needs_setup = !s.config.auth_none && db::user_count(&s.db).await? == 0;
    let st = s.settings.read().await;
    Ok(Json(PublicConfig {
        version: env!("CARGO_PKG_VERSION"),
        auth: if s.config.auth_none { "none" } else { "required" },
        local: s.config.auth_local,
        oidc: s.config.oidc.as_ref().map(|o| o.name.clone()),
        signup: s.config.auth_local && (st.signup(&s.config) || needs_setup),
        needs_setup,
        max_upload_bytes: s.config.max_upload_bytes,
        max_versions: s.config.max_versions,
        password_reset: s.config.auth_local && s.config.public_url.is_some() && st.smtp.configured(),
        require_email: !s.config.auth_none && st.require_email(),
        ai: s.config.ai,
        needs_setup_token: needs_setup && s.config.setup_token.is_some(),
    }))
}

async fn health() -> impl IntoResponse {
    Json(serde_json::json!({ "ok": true, "version": env!("CARGO_PKG_VERSION") }))
}

/// CSRF guard: state-changing API calls must carry `X-Whittle: 1`. Browsers
/// won't send a custom header cross-site without a CORS preflight, which we never allow.
async fn require_app_header(req: Request, next: Next) -> Response {
    let safe = matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS);
    if !safe && req.headers().get("x-whittle").is_none() {
        return ApiError::new(StatusCode::FORBIDDEN, "Missing X-Whittle header").into_response();
    }
    next.run(req).await
}

const CSP: &str = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' blob: data:; frame-ancestors 'none'";
/// With the AI assistant on, the browser may also reach AI providers: any HTTPS service, and model servers on
/// this computer or the local network, which usually speak plain HTTP (http://192.168.1.20:11434/v1).
const CSP_AI: &str = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' blob: data: https: http:; frame-ancestors 'none'";
/// The geometry worker runs OpenCascade, whose WebAssembly bindings compile JS at
/// start-up, so only that script may use eval. A worker gets the policy sent with its own script.
const WORKER_CSP: &str = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'; connect-src 'self' blob: data:; font-src 'self' data:";

async fn content_security_policy(State(s): State<Shared>, req: Request, next: Next) -> Response {
    let worker = req.uri().path().contains("/assets/worker-");
    let mut res = next.run(req).await;
    let page = if s.config.ai { CSP_AI } else { CSP };
    res.headers_mut().insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(if worker { WORKER_CSP } else { page }));
    res
}

/// Built files carry a content hash in their names, so browsers may keep them for good. The page, the
/// offline service worker and its file list must be checked every time, or a new version would never arrive.
async fn cache_control(req: Request, next: Next) -> Response {
    let path = req.uri().path().to_owned();
    let mut res = next.run(req).await;
    if path.starts_with("/api/") {
        return res;
    }
    let value = if path.contains("/assets/") && res.status().is_success() { "public, max-age=31536000, immutable" } else { "no-cache" };
    res.headers_mut().entry(header::CACHE_CONTROL).or_insert(HeaderValue::from_static(value));
    res
}

pub async fn build_state(config: Config) -> Result<Shared, String> {
    tokio::fs::create_dir_all(config.data.join("designs"))
        .await
        .map_err(|e| format!("cannot create the data directory {}: {e}", config.data.display()))?;
    let db = db::connect(&config.database_url).await.map_err(|e| format!("cannot open the database: {e}"))?;
    if config.auth_none {
        auth::ensure_local_user(&db).await.map_err(|e| e.to_string())?;
    }
    let settings = settings::ServerSettings::load(&db, &config).await?;
    Ok(Arc::new(AppState {
        config,
        db,
        login_failures: Mutex::new(HashMap::new()),
        oidc: oidc::OidcState::default(),
        settings: RwLock::new(settings),
        started: Instant::now(),
    }))
}

pub fn router(state: Shared) -> Router {
    let api = Router::new()
        .route("/config", get(public_config))
        .route("/health", get(health))
        .route("/auth/me", get(auth::me).patch(auth::update_me))
        .route("/auth/login", post(auth::login))
        .route("/auth/logout", post(auth::logout))
        .route("/auth/register", post(auth::register))
        .route("/auth/password", post(auth::change_password))
        .route("/auth/forgot", post(auth::forgot))
        .route("/auth/reset", post(auth::reset))
        .route("/auth/oidc/start", get(oidc::start))
        .route("/auth/oidc/callback", get(oidc::callback))
        .route("/admin/overview", get(admin::overview))
        .route("/admin/audit", get(admin::audit_log))
        .route("/admin/settings", get(admin::get_settings).put(admin::put_settings))
        .route("/admin/settings/test-email", post(admin::test_email))
        .route("/admin/users", get(admin::list).post(admin::create))
        .route("/admin/users/{id}", axum::routing::patch(admin::update).delete(admin::delete))
        .route("/admin/users/{id}/merge", post(admin::merge))
        .route("/admin/users/{id}/unlink-sso", post(admin::unlink_sso))
        .route("/admin/users/{id}/signout", post(admin::revoke_sessions))
        .route("/admin/users/{id}/send-reset", post(admin::send_reset))
        .route("/me/data", get(userdata::list))
        .route("/me/data/{key}", get(userdata::get).put(userdata::put).delete(userdata::remove))
        .route("/designs", get(designs::list).post(designs::create))
        .route("/designs/{id}", get(designs::download).put(designs::save).delete(designs::remove))
        .route("/designs/{id}/thumbnail", get(designs::thumbnail))
        .route("/designs/{id}/versions", get(designs::versions))
        .route("/designs/{id}/versions/{version}", get(designs::download_version))
        .route("/designs/{id}/versions/{version}/restore", post(designs::restore))
        .fallback(|| async { ApiError::not_found() })
        .layer(middleware::from_fn(require_app_header))
        .layer(DefaultBodyLimit::max(state.config.max_upload_bytes))
        .with_state(state.clone());

    let web = &state.config.web;
    let static_files = ServeDir::new(web).not_found_service(ServeFile::new(web.join("index.html")));

    Router::new()
        .nest("/api", api)
        .fallback_service(static_files)
        .layer(CompressionLayer::new())
        // Cross-origin isolation: lets the geometry kernel use threads when available.
        .layer(SetResponseHeaderLayer::overriding(
            header::HeaderName::from_static("cross-origin-opener-policy"),
            HeaderValue::from_static("same-origin"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::HeaderName::from_static("cross-origin-embedder-policy"),
            HeaderValue::from_static("require-corp"),
        ))
        .layer(SetResponseHeaderLayer::overriding(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff")))
        .layer(SetResponseHeaderLayer::overriding(header::REFERRER_POLICY, HeaderValue::from_static("same-origin")))
        .layer(SetResponseHeaderLayer::overriding(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY")))
        .layer(middleware::from_fn_with_state(state.clone(), content_security_policy))
        .layer(middleware::from_fn(cache_control))
        .layer(TraceLayer::new_for_http())
}
