//! End-to-end API tests against a real database.
//! SQLite in a temp dir by default; set WHITTLE_TEST_DATABASE_URL to run them on PostgreSQL.

use std::io::Write;

use axum::{
    body::Body,
    http::{header, Method, Request, StatusCode},
    Router,
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;
use whittle_server::{build_state, router, Config};

struct App {
    router: Router,
    _dir: TempDir,
}

struct TempDir(std::path::PathBuf);
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

async fn app(tweak: impl FnOnce(&mut Config)) -> App {
    let dir = std::env::temp_dir().join(format!("whittle-test-{}", whittle_server::random_token(8)));
    std::fs::create_dir_all(&dir).unwrap();
    let mut cfg = Config::for_data_dir(dir.clone(), std::env::var("WHITTLE_TEST_DATABASE_URL").ok());
    tweak(&mut cfg);
    let state = build_state(cfg).await.unwrap();
    if std::env::var("WHITTLE_TEST_DATABASE_URL").is_ok() {
        // Shared database: start from a clean slate, keeping the built-in
        // `local` user that build_state just ensured for no-login mode.
        for q in ["DELETE FROM design_versions", "DELETE FROM designs", "DELETE FROM sessions", "DELETE FROM users WHERE id <> 'local'"] {
            sqlx::query(q).execute(&state.db).await.unwrap();
        }
    }
    App { router: router(state), _dir: TempDir(dir) }
}

struct Resp {
    status: StatusCode,
    headers: axum::http::HeaderMap,
    body: Vec<u8>,
}
impl Resp {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }
}

async fn call(app: &App, method: Method, path: &str, cookie: Option<&str>, body: Option<Body>, json_body: bool, extra: &[(&str, &str)]) -> Resp {
    let mut req = Request::builder().method(method).uri(path).header("x-whittle", "1");
    if let Some(c) = cookie {
        req = req.header(header::COOKIE, c);
    }
    if json_body {
        req = req.header(header::CONTENT_TYPE, "application/json");
    }
    for (k, v) in extra {
        req = req.header(*k, *v);
    }
    let res = app.router.clone().oneshot(req.body(body.unwrap_or_else(Body::empty)).unwrap()).await.unwrap();
    let status = res.status();
    let headers = res.headers().clone();
    let body = res.into_body().collect().await.unwrap().to_bytes().to_vec();
    Resp { status, headers, body }
}

async fn post_json(app: &App, path: &str, cookie: Option<&str>, v: Value) -> Resp {
    call(app, Method::POST, path, cookie, Some(Body::from(v.to_string())), true, &[]).await
}

fn session(r: &Resp) -> String {
    let c = r.headers.get(header::SET_COOKIE).expect("a session cookie").to_str().unwrap();
    c.split(';').next().unwrap().to_owned()
}

/// A minimal .whittle file (ZIP with document.json and a thumbnail).
fn whittle(name: &str) -> Vec<u8> {
    let mut buf = std::io::Cursor::new(Vec::new());
    {
        let mut z = zip::ZipWriter::new(&mut buf);
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        z.start_file("document.json", opts).unwrap();
        z.write_all(json!({ "schema": 1, "name": name, "features": [] }).to_string().as_bytes()).unwrap();
        z.start_file("thumbnail.png", opts).unwrap();
        z.write_all(b"\x89PNG fake").unwrap();
        z.finish().unwrap();
    }
    buf.into_inner()
}

#[tokio::test]
async fn first_user_becomes_admin_and_signup_then_closes() {
    let app = app(|_| {}).await;
    let cfg = call(&app, Method::GET, "/api/config", None, None, false, &[]).await.json();
    assert_eq!(cfg["auth"], "required");
    assert_eq!(cfg["needsSetup"], true);
    assert_eq!(cfg["signup"], true);

    let r = post_json(&app, "/api/auth/register", None, json!({ "username": "ada", "password": "correct horse" })).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", String::from_utf8_lossy(&r.body));
    assert_eq!(r.json()["isAdmin"], true);

    let cfg = call(&app, Method::GET, "/api/config", None, None, false, &[]).await.json();
    assert_eq!(cfg["needsSetup"], false);
    assert_eq!(cfg["signup"], false);
    let r = post_json(&app, "/api/auth/register", None, json!({ "username": "bob", "password": "correct horse" })).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn login_logout_and_protection() {
    let app = app(|_| {}).await;
    post_json(&app, "/api/auth/register", None, json!({ "username": "ada", "password": "correct horse" })).await;
    assert_eq!(call(&app, Method::GET, "/api/designs", None, None, false, &[]).await.status, StatusCode::UNAUTHORIZED);

    let bad = post_json(&app, "/api/auth/login", None, json!({ "username": "ada", "password": "wrong password" })).await;
    assert_eq!(bad.status, StatusCode::UNAUTHORIZED);
    let ok = post_json(&app, "/api/auth/login", None, json!({ "username": "ada", "password": "correct horse" })).await;
    assert_eq!(ok.status, StatusCode::OK);
    let c = session(&ok);
    assert_eq!(call(&app, Method::GET, "/api/auth/me", Some(&c), None, false, &[]).await.json()["username"], "ada");

    // Mutations need the app header (CSRF guard).
    let req = Request::builder().method(Method::POST).uri("/api/auth/logout").header(header::COOKIE, &c).body(Body::empty()).unwrap();
    assert_eq!(app.router.clone().oneshot(req).await.unwrap().status(), StatusCode::FORBIDDEN);

    assert_eq!(call(&app, Method::POST, "/api/auth/logout", Some(&c), None, false, &[]).await.status, StatusCode::NO_CONTENT);
    assert_eq!(call(&app, Method::GET, "/api/auth/me", Some(&c), None, false, &[]).await.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn brute_force_is_throttled() {
    let app = app(|_| {}).await;
    post_json(&app, "/api/auth/register", None, json!({ "username": "ada", "password": "correct horse" })).await;
    for _ in 0..10 {
        post_json(&app, "/api/auth/login", None, json!({ "username": "ada", "password": "nope nope" })).await;
    }
    let r = post_json(&app, "/api/auth/login", None, json!({ "username": "ada", "password": "correct horse" })).await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn designs_versions_conflicts_and_isolation() {
    let app = app(|c| c.max_versions = 3).await;
    let ada = session(&post_json(&app, "/api/auth/register", None, json!({ "username": "ada", "password": "correct horse" })).await);
    let r = post_json(&app, "/api/admin/users", Some(&ada), json!({ "username": "bob", "password": "battery staple" })).await;
    assert_eq!(r.status, StatusCode::CREATED);
    let bob = session(&post_json(&app, "/api/auth/login", None, json!({ "username": "bob", "password": "battery staple" })).await);

    // Garbage is refused.
    let r = call(&app, Method::POST, "/api/designs", Some(&ada), Some(Body::from("hello")), false, &[]).await;
    assert_eq!(r.status, StatusCode::UNSUPPORTED_MEDIA_TYPE);

    let r = call(&app, Method::POST, "/api/designs", Some(&ada), Some(Body::from(whittle("Bracket"))), false, &[]).await;
    assert_eq!(r.status, StatusCode::CREATED);
    let id = r.json()["id"].as_str().unwrap().to_owned();
    assert_eq!(r.json()["name"], "Bracket");

    // Saves add versions; a stale If-Match is rejected.
    let path = format!("/api/designs/{id}");
    let r = call(&app, Method::PUT, &path, Some(&ada), Some(Body::from(whittle("Bracket v2"))), false, &[("if-match", "1")]).await;
    assert_eq!(r.json()["version"], 2);
    let r = call(&app, Method::PUT, &path, Some(&ada), Some(Body::from(whittle("stale"))), false, &[("if-match", "1")]).await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    for n in 3..=5 {
        let r = call(&app, Method::PUT, &path, Some(&ada), Some(Body::from(whittle(&format!("v{n}")))), false, &[]).await;
        assert_eq!(r.json()["version"], n);
    }

    // Only the newest 3 versions are kept.
    let v = call(&app, Method::GET, &format!("{path}/versions"), Some(&ada), None, false, &[]).await.json();
    let nums: Vec<i64> = v.as_array().unwrap().iter().map(|x| x["version"].as_i64().unwrap()).collect();
    assert_eq!(nums, vec![5, 4, 3]);
    assert_eq!(call(&app, Method::GET, &format!("{path}/versions/1"), Some(&ada), None, false, &[]).await.status, StatusCode::NOT_FOUND);

    // Restoring an old version makes it the newest.
    let r = call(&app, Method::POST, &format!("{path}/versions/3/restore"), Some(&ada), None, false, &[]).await;
    assert_eq!(r.json()["version"], 6);
    assert_eq!(r.json()["name"], "v3");
    let list = call(&app, Method::GET, "/api/designs", Some(&ada), None, false, &[]).await.json();
    assert_eq!(list[0]["name"], "v3");
    assert_eq!(list[0]["hasThumbnail"], true);
    let file = call(&app, Method::GET, &path, Some(&ada), None, false, &[]).await;
    assert_eq!(file.headers.get("x-whittle-version").unwrap(), "6");
    assert_eq!(&file.body[..2], b"PK");
    assert_eq!(call(&app, Method::GET, &format!("{path}/thumbnail"), Some(&ada), None, false, &[]).await.status, StatusCode::OK);

    // Bob can't see or touch Ada's design.
    assert_eq!(call(&app, Method::GET, &path, Some(&bob), None, false, &[]).await.status, StatusCode::NOT_FOUND);
    assert_eq!(call(&app, Method::DELETE, &path, Some(&bob), None, false, &[]).await.status, StatusCode::NOT_FOUND);
    assert_eq!(call(&app, Method::GET, "/api/designs", Some(&bob), None, false, &[]).await.json(), json!([]));
    // ...and isn't an admin.
    assert_eq!(call(&app, Method::GET, "/api/admin/users", Some(&bob), None, false, &[]).await.status, StatusCode::FORBIDDEN);

    assert_eq!(call(&app, Method::DELETE, &path, Some(&ada), None, false, &[]).await.status, StatusCode::NO_CONTENT);
    assert_eq!(call(&app, Method::GET, "/api/designs", Some(&ada), None, false, &[]).await.json(), json!([]));
}

#[tokio::test]
async fn admin_rules() {
    let app = app(|_| {}).await;
    let r = post_json(&app, "/api/auth/register", None, json!({ "username": "ada", "password": "correct horse" })).await;
    let ada = session(&r);
    let ada_id = r.json()["id"].as_str().unwrap().to_owned();
    // The last administrator can't be demoted or delete themselves.
    let r = call(&app, Method::PATCH, &format!("/api/admin/users/{ada_id}"), Some(&ada), Some(Body::from(json!({ "isAdmin": false }).to_string())), true, &[]).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    let r = call(&app, Method::DELETE, &format!("/api/admin/users/{ada_id}"), Some(&ada), None, false, &[]).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);

    let bob = post_json(&app, "/api/admin/users", Some(&ada), json!({ "username": "bob", "password": "battery staple" })).await.json();
    let bob_id = bob["id"].as_str().unwrap();
    let bob_cookie = session(&post_json(&app, "/api/auth/login", None, json!({ "username": "bob", "password": "battery staple" })).await);
    // Disabling signs Bob out everywhere.
    let r = call(&app, Method::PATCH, &format!("/api/admin/users/{bob_id}"), Some(&ada), Some(Body::from(json!({ "disabled": true }).to_string())), true, &[]).await;
    assert_eq!(r.json()["disabled"], true);
    assert_eq!(call(&app, Method::GET, "/api/auth/me", Some(&bob_cookie), None, false, &[]).await.status, StatusCode::UNAUTHORIZED);
    let r = post_json(&app, "/api/auth/login", None, json!({ "username": "bob", "password": "battery staple" })).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    assert_eq!(call(&app, Method::DELETE, &format!("/api/admin/users/{bob_id}"), Some(&ada), None, false, &[]).await.status, StatusCode::NO_CONTENT);

    // Password change needs the current password.
    let r = post_json(&app, "/api/auth/password", Some(&ada), json!({ "current": "wrong", "newPassword": "new password 1" })).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    let r = post_json(&app, "/api/auth/password", Some(&ada), json!({ "current": "correct horse", "newPassword": "new password 1" })).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    let r = post_json(&app, "/api/auth/login", None, json!({ "username": "ada", "password": "new password 1" })).await;
    assert_eq!(r.status, StatusCode::OK);
}

#[tokio::test]
async fn no_login_mode() {
    let app = app(|c| {
        c.auth_none = true;
        c.auth_local = false;
    })
    .await;
    assert_eq!(call(&app, Method::GET, "/api/config", None, None, false, &[]).await.json()["auth"], "none");
    assert_eq!(call(&app, Method::GET, "/api/auth/me", None, None, false, &[]).await.json()["username"], "local");
    let r = call(&app, Method::POST, "/api/designs", None, Some(Body::from(whittle("Shared"))), false, &[]).await;
    assert_eq!(r.status, StatusCode::CREATED);
    assert_eq!(call(&app, Method::GET, "/api/designs", None, None, false, &[]).await.json()[0]["name"], "Shared");
    let r = post_json(&app, "/api/auth/login", None, json!({ "username": "x", "password": "yyyyyyyy" })).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn unknown_api_paths_are_json_404() {
    let app = app(|_| {}).await;
    let r = call(&app, Method::GET, "/api/nope", None, None, false, &[]).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
}
