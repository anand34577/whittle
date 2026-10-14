//! whittle-server: serves the Whittle web app, user accounts (none, local,
//! OIDC) and per-user design storage with version history. Geometry runs in
//! the browser, so the server stays small.

pub mod auth;
pub mod config;
pub mod db;
pub mod designs;
pub mod oidc;

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
use tokio::sync::Mutex;
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
}

async fn public_config(State(s): State<Shared>) -> ApiResult<Json<PublicConfig>> {
    let needs_setup = !s.config.auth_none && db::user_count(&s.db).await? == 0;
    Ok(Json(PublicConfig {
        version: env!("CARGO_PKG_VERSION"),
        auth: if s.config.auth_none { "none" } else { "required" },
        local: s.config.auth_local,
        oidc: s.config.oidc.as_ref().map(|o| o.name.clone()),
        signup: s.config.auth_local && (s.config.signup || needs_setup),
        needs_setup,
        max_upload_bytes: s.config.max_upload_bytes,
        max_versions: s.config.max_versions,
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
/// The geometry worker runs OpenCascade, whose WebAssembly bindings compile JS at
/// start-up, so only that script may use eval. A worker gets the policy sent with its own script.
const WORKER_CSP: &str = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'; connect-src 'self' blob: data:; font-src 'self' data:";

async fn content_security_policy(req: Request, next: Next) -> Response {
    let worker = req.uri().path().contains("/assets/worker-");
    let mut res = next.run(req).await;
    res.headers_mut().insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(if worker { WORKER_CSP } else { CSP }));
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
    Ok(Arc::new(AppState { config, db, login_failures: Mutex::new(HashMap::new()), oidc: oidc::OidcState::default() }))
}

pub fn router(state: Shared) -> Router {
    let api = Router::new()
        .route("/config", get(public_config))
        .route("/health", get(health))
        .route("/auth/me", get(auth::me))
        .route("/auth/login", post(auth::login))
        .route("/auth/logout", post(auth::logout))
        .route("/auth/register", post(auth::register))
        .route("/auth/password", post(auth::change_password))
        .route("/auth/oidc/start", get(oidc::start))
        .route("/auth/oidc/callback", get(oidc::callback))
        .route("/admin/users", get(auth::admin_list).post(auth::admin_create))
        .route("/admin/users/{id}", axum::routing::patch(auth::admin_update).delete(auth::admin_delete))
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
        .layer(middleware::from_fn(content_security_policy))
        .layer(TraceLayer::new_for_http())
}
