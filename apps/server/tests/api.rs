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
    state: whittle_server::Shared,
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
        for q in ["DELETE FROM design_versions", "DELETE FROM designs", "DELETE FROM sessions", "DELETE FROM password_resets", "DELETE FROM audit_log", "DELETE FROM settings", "DELETE FROM user_data", "DELETE FROM users WHERE id <> 'local'"] {
            sqlx::query(q).execute(&state.db).await.unwrap();
        }
    }
    App { router: router(state.clone()), state, _dir: TempDir(dir) }
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

    let r = post_json(&app, "/api/auth/register", None, json!({ "username": "ada", "email": "ada@example.com", "password": "correct horse" })).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", String::from_utf8_lossy(&r.body));
    assert_eq!(r.json()["isAdmin"], true);

    let cfg = call(&app, Method::GET, "/api/config", None, None, false, &[]).await.json();
    assert_eq!(cfg["needsSetup"], false);
    assert_eq!(cfg["signup"], false);
    let r = post_json(&app, "/api/auth/register", None, json!({ "username": "bob", "email": "bob@example.com", "password": "correct horse" })).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn login_logout_and_protection() {
    let app = app(|_| {}).await;
    post_json(&app, "/api/auth/register", None, json!({ "username": "ada", "email": "ada@example.com", "password": "correct horse" })).await;
    assert_eq!(call(&app, Method::GET, "/api/designs", None, None, false, &[]).await.status, StatusCode::UNAUTHORIZED);

    let bad = post_json(&app, "/api/auth/login", None, json!({ "username": "ada", "email": "ada@example.com", "password": "wrong password" })).await;
    assert_eq!(bad.status, StatusCode::UNAUTHORIZED);
    let ok = post_json(&app, "/api/auth/login", None, json!({ "username": "ada", "email": "ada@example.com", "password": "correct horse" })).await;
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
    post_json(&app, "/api/auth/register", None, json!({ "username": "ada", "email": "ada@example.com", "password": "correct horse" })).await;
    for _ in 0..10 {
        post_json(&app, "/api/auth/login", None, json!({ "username": "ada", "email": "ada@example.com", "password": "nope nope" })).await;
    }
    let r = post_json(&app, "/api/auth/login", None, json!({ "username": "ada", "email": "ada@example.com", "password": "correct horse" })).await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn designs_versions_conflicts_and_isolation() {
    let app = app(|c| c.max_versions = 3).await;
    let ada = session(&post_json(&app, "/api/auth/register", None, json!({ "username": "ada", "email": "ada@example.com", "password": "correct horse" })).await);
    let r = post_json(&app, "/api/admin/users", Some(&ada), json!({ "username": "bob", "email": "bob@example.com", "password": "battery staple" })).await;
    assert_eq!(r.status, StatusCode::CREATED);
    let bob = session(&post_json(&app, "/api/auth/login", None, json!({ "username": "bob", "email": "bob@example.com", "password": "battery staple" })).await);

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
    let r = post_json(&app, "/api/auth/register", None, json!({ "username": "ada", "email": "ada@example.com", "password": "correct horse" })).await;
    let ada = session(&r);
    let ada_id = r.json()["id"].as_str().unwrap().to_owned();
    // The last administrator can't be demoted or delete themselves.
    let r = call(&app, Method::PATCH, &format!("/api/admin/users/{ada_id}"), Some(&ada), Some(Body::from(json!({ "isAdmin": false }).to_string())), true, &[]).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    let r = call(&app, Method::DELETE, &format!("/api/admin/users/{ada_id}"), Some(&ada), None, false, &[]).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);

    let bob = post_json(&app, "/api/admin/users", Some(&ada), json!({ "username": "bob", "email": "bob@example.com", "password": "battery staple" })).await.json();
    let bob_id = bob["id"].as_str().unwrap();
    let bob_cookie = session(&post_json(&app, "/api/auth/login", None, json!({ "username": "bob", "email": "bob@example.com", "password": "battery staple" })).await);
    // Disabling signs Bob out everywhere.
    let r = call(&app, Method::PATCH, &format!("/api/admin/users/{bob_id}"), Some(&ada), Some(Body::from(json!({ "disabled": true }).to_string())), true, &[]).await;
    assert_eq!(r.json()["disabled"], true);
    assert_eq!(call(&app, Method::GET, "/api/auth/me", Some(&bob_cookie), None, false, &[]).await.status, StatusCode::UNAUTHORIZED);
    let r = post_json(&app, "/api/auth/login", None, json!({ "username": "bob", "email": "bob@example.com", "password": "battery staple" })).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    assert_eq!(call(&app, Method::DELETE, &format!("/api/admin/users/{bob_id}"), Some(&ada), None, false, &[]).await.status, StatusCode::NO_CONTENT);

    // Password change needs the current password.
    let r = post_json(&app, "/api/auth/password", Some(&ada), json!({ "current": "wrong", "newPassword": "new password 1" })).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    let r = post_json(&app, "/api/auth/password", Some(&ada), json!({ "current": "correct horse", "newPassword": "new password 1" })).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    let r = post_json(&app, "/api/auth/login", None, json!({ "username": "ada", "email": "ada@example.com", "password": "new password 1" })).await;
    assert_eq!(r.status, StatusCode::OK);
}

#[tokio::test]
async fn single_sign_on_accounts_are_added_by_email() {
    // Without OIDC an account needs a password.
    let plain = app(|_| {}).await;
    let ada = session(&post_json(&plain, "/api/auth/register", None, json!({ "username": "ada", "email": "ada@example.com", "password": "correct horse" })).await);
    let r = post_json(&plain, "/api/admin/users", Some(&ada), json!({ "username": "bob", "email": "bob@example.com" })).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    drop(plain);

    // With OIDC, an admin can add a password-less account by email; it can't sign in with a password.
    let sso = app(|c| {
        c.oidc = Some(whittle_server::config::OidcConfig {
            issuer: "https://auth.example.com".into(),
            client_id: "whittle".into(),
            client_secret: None,
            name: "SSO".into(),
            scopes: vec!["openid".into(), "email".into()],
            auto_create: false,
        });
    })
    .await;
    let ada = session(&post_json(&sso, "/api/auth/register", None, json!({ "username": "ada", "email": "ada@example.com", "password": "correct horse" })).await);
    let r = post_json(&sso, "/api/admin/users", Some(&ada), json!({ "username": "bob" })).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "needs an email when there's no password");
    let r = post_json(&sso, "/api/admin/users", Some(&ada), json!({ "username": "bob", "email": "bob@example.com" })).await;
    assert_eq!(r.status, StatusCode::CREATED);
    assert_eq!(r.json()["hasPassword"], false);
    let r = post_json(&sso, "/api/auth/login", None, json!({ "username": "bob", "email": "bob@example.com", "password": "" })).await;
    assert_ne!(r.status, StatusCode::OK);
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
    let r = post_json(&app, "/api/auth/login", None, json!({ "username": "x", "email": "x@example.com", "password": "yyyyyyyy" })).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn unknown_api_paths_are_json_404() {
    let app = app(|_| {}).await;
    let r = call(&app, Method::GET, "/api/nope", None, None, false, &[]).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
}

async fn patch_json(app: &App, path: &str, cookie: &str, v: Value) -> Resp {
    call(app, Method::PATCH, path, Some(cookie), Some(Body::from(v.to_string())), true, &[]).await
}

/// Ada (the administrator) and her session.
async fn with_admin(app: &App) -> (String, String) {
    let r = post_json(app, "/api/auth/register", None, json!({ "username": "ada", "password": "correct horse", "email": "ada@example.com" })).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", String::from_utf8_lossy(&r.body));
    (session(&r), r.json()["id"].as_str().unwrap().to_owned())
}

#[tokio::test]
async fn emails_are_required_valid_and_unique() {
    let app = app(|_| {}).await;
    let r = post_json(&app, "/api/auth/register", None, json!({ "username": "ada", "password": "correct horse" })).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "email is required");
    let r = post_json(&app, "/api/auth/register", None, json!({ "username": "ada", "password": "correct horse", "email": "not-an-email" })).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    let (ada, _) = with_admin(&app).await;
    let r = post_json(&app, "/api/admin/users", Some(&ada), json!({ "username": "bob", "password": "battery staple", "email": "ADA@example.com" })).await;
    assert_eq!(r.status, StatusCode::CONFLICT, "emails are unique, ignoring case");
    // Sign in with the email address too.
    let r = post_json(&app, "/api/auth/login", None, json!({ "username": "ada@example.com", "password": "correct horse" })).await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(r.json()["lastLoginAt"].as_i64().is_some());
}

#[tokio::test]
async fn people_edit_their_profile() {
    let app = app(|_| {}).await;
    let (ada, _) = with_admin(&app).await;
    let r = patch_json(&app, "/api/auth/me", &ada, json!({ "displayName": "Ada L.", "email": "ada@lovelace.org" })).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json()["displayName"], "Ada L.");
    assert_eq!(r.json()["email"], "ada@lovelace.org");
    let r = patch_json(&app, "/api/auth/me", &ada, json!({ "email": "nope" })).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn administrators_edit_merge_link_and_transfer() {
    let app = app(|c| {
        c.oidc = Some(whittle_server::config::OidcConfig {
            issuer: "https://auth.example.com".into(),
            client_id: "whittle".into(),
            client_secret: None,
            name: "SSO".into(),
            scopes: vec!["email".into()],
            auto_create: true,
        });
    })
    .await;
    let (ada, ada_id) = with_admin(&app).await;
    let bob = post_json(&app, "/api/admin/users", Some(&ada), json!({ "username": "bob", "password": "battery staple", "email": "bob@example.com" })).await.json();
    let bob_id = bob["id"].as_str().unwrap().to_owned();

    // Edit username, name and email.
    let r = patch_json(&app, &format!("/api/admin/users/{bob_id}"), &ada, json!({ "username": "robert", "displayName": "Robert", "email": "robert@example.com" })).await;
    assert_eq!(r.status, StatusCode::OK, "{}", String::from_utf8_lossy(&r.body));
    assert_eq!(r.json()["username"], "robert");
    assert_eq!(r.json()["email"], "robert@example.com");
    // An administrator can't drop their own rights.
    let r = patch_json(&app, &format!("/api/admin/users/{ada_id}"), &ada, json!({ "isAdmin": false })).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);

    // Flag for single sign-on linking by email.
    let r = patch_json(&app, &format!("/api/admin/users/{bob_id}"), &ada, json!({ "ssoLink": true })).await;
    assert_eq!(r.json()["ssoLink"], true);

    // Simulate Robert having signed in with SSO separately: a second account with an identity and a design.
    let sso_id = "ssoaccount1";
    whittle_server::db::insert_user(
        &app.state.db,
        sso_id,
        whittle_server::db::NewUser { username: "robert-sso", display_name: "Robert", email: None, password_hash: None, oidc_subject: Some("https://auth.example.com|123"), is_admin: false },
    )
    .await
    .unwrap();
    sqlx::query("INSERT INTO designs (id, owner_id, name, size, head, has_thumbnail, created_at, updated_at) VALUES ('d1', $1, 'Gear', 10, 1, 0, 1, 1)")
        .bind(sso_id)
        .execute(&app.state.db)
        .await
        .unwrap();

    // Merge the SSO account into Robert's: designs move, Robert keeps his password and gains the identity.
    let r = post_json(&app, &format!("/api/admin/users/{sso_id}/merge"), Some(&ada), json!({ "into": bob_id })).await;
    assert_eq!(r.status, StatusCode::OK, "{}", String::from_utf8_lossy(&r.body));
    assert_eq!(r.json()["sso"], true);
    assert_eq!(r.json()["hasPassword"], true);
    assert_eq!(r.json()["ssoLink"], false);
    let list = call(&app, Method::GET, "/api/admin/users", Some(&ada), None, false, &[]).await.json();
    let robert = list.as_array().unwrap().iter().find(|u| u["id"] == bob_id.as_str()).unwrap().clone();
    assert_eq!(robert["designs"], 1);
    assert!(list.as_array().unwrap().iter().all(|u| u["id"] != sso_id));

    // Unlink single sign-on.
    let r = post_json(&app, &format!("/api/admin/users/{bob_id}/unlink-sso"), Some(&ada), json!({})).await;
    assert_eq!(r.json()["sso"], false);
    // Sign Robert out everywhere.
    let rc = session(&post_json(&app, "/api/auth/login", None, json!({ "username": "robert", "password": "battery staple" })).await);
    assert_eq!(post_json(&app, &format!("/api/admin/users/{bob_id}/signout"), Some(&ada), json!({})).await.status, StatusCode::NO_CONTENT);
    assert_eq!(call(&app, Method::GET, "/api/auth/me", Some(&rc), None, false, &[]).await.status, StatusCode::UNAUTHORIZED);

    // Delete Robert, giving his designs to Ada.
    let r = call(&app, Method::DELETE, &format!("/api/admin/users/{bob_id}?transferTo={ada_id}"), Some(&ada), None, false, &[]).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    let owner: String = sqlx::query_scalar("SELECT owner_id FROM designs WHERE id = 'd1'").fetch_one(&app.state.db).await.unwrap();
    assert_eq!(owner, ada_id);

    // Everything above is in the audit log.
    let log = call(&app, Method::GET, "/api/admin/audit", Some(&ada), None, false, &[]).await.json();
    let actions: Vec<&str> = log.as_array().unwrap().iter().map(|e| e["action"].as_str().unwrap()).collect();
    for a in ["user.create", "user.update", "user.merge", "user.sso_unlink", "user.signout", "user.delete"] {
        assert!(actions.contains(&a), "{a} missing from {actions:?}");
    }
    let o = call(&app, Method::GET, "/api/admin/overview", Some(&ada), None, false, &[]).await.json();
    assert_eq!(o["designs"], 1);
    let expected_db = if std::env::var("WHITTLE_TEST_DATABASE_URL").is_ok() { "PostgreSQL" } else { "SQLite" };
    assert_eq!(o["database"], expected_db);
}

#[tokio::test]
async fn settings_and_password_reset() {
    let app = app(|c| c.public_url = Some("https://cad.example.com".into())).await;
    let (ada, ada_id) = with_admin(&app).await;
    // No email server yet: no self-service reset.
    assert_eq!(call(&app, Method::GET, "/api/config", None, None, false, &[]).await.json()["passwordReset"], false);
    assert_eq!(post_json(&app, "/api/auth/forgot", None, json!({ "login": "ada" })).await.status, StatusCode::BAD_REQUEST);

    // Configure SMTP; the password is stored but never sent back.
    let r = call(
        &app,
        Method::PUT,
        "/api/admin/settings",
        Some(&ada),
        Some(Body::from(json!({ "signup": true, "smtp": { "host": "mail.example.com", "port": 25, "security": "none", "password": "s3cret", "fromAddress": "cad@example.com" } }).to_string())),
        true,
        &[],
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", String::from_utf8_lossy(&r.body));
    let v = r.json();
    assert_eq!(v["smtp"]["hasPassword"], true);
    assert!(v["smtp"].get("password").is_none());
    assert_eq!(v["smtp"]["security"], "none");
    let cfg = call(&app, Method::GET, "/api/config", None, None, false, &[]).await.json();
    assert_eq!(cfg["passwordReset"], true);
    assert_eq!(cfg["signup"], true, "sign-up opened from the admin settings");

    // A reset link sets a new password once.
    let link = whittle_server::auth::reset_link(&app.state, "http://x", &ada_id).await.unwrap();
    let token = link.split("reset=").nth(1).unwrap();
    let r = post_json(&app, "/api/auth/reset", None, json!({ "token": token, "newPassword": "brand new pass" })).await;
    assert_eq!(r.status, StatusCode::OK);
    let r = post_json(&app, "/api/auth/reset", None, json!({ "token": token, "newPassword": "another pass 2" })).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "links work once");
    let r = post_json(&app, "/api/auth/login", None, json!({ "username": "ada", "password": "brand new pass" })).await;
    assert_eq!(r.status, StatusCode::OK);
}

/// A tiny SMTP server: plain text, no TLS, no auth. Returns the message it received.
async fn fake_smtp() -> (u16, tokio::task::JoinHandle<String>) {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let handle = tokio::spawn(async move {
        let (sock, _) = listener.accept().await.unwrap();
        let (r, mut w) = sock.into_split();
        let mut lines = BufReader::new(r).lines();
        w.write_all(b"220 fake ESMTP\r\n").await.unwrap();
        let mut data = String::new();
        let mut in_data = false;
        while let Ok(Some(line)) = lines.next_line().await {
            if in_data {
                if line == "." {
                    in_data = false;
                    w.write_all(b"250 queued\r\n").await.unwrap();
                } else {
                    data.push_str(&line);
                    data.push('\n');
                }
                continue;
            }
            let cmd = line.to_ascii_uppercase();
            if cmd.starts_with("EHLO") || cmd.starts_with("HELO") {
                w.write_all(b"250-fake\r\n250 8BITMIME\r\n").await.unwrap();
            } else if cmd.starts_with("DATA") {
                in_data = true;
                w.write_all(b"354 go\r\n").await.unwrap();
            } else if cmd.starts_with("QUIT") {
                w.write_all(b"221 bye\r\n").await.unwrap();
                break;
            } else {
                w.write_all(b"250 ok\r\n").await.unwrap();
            }
        }
        data
    });
    (port, handle)
}

#[tokio::test]
async fn sends_mail_over_unsecured_smtp() {
    let (port, received) = fake_smtp().await;
    let smtp = whittle_server::settings::SmtpSettings {
        host: "127.0.0.1".into(),
        port,
        security: whittle_server::settings::SmtpSecurity::None,
        from_address: "cad@example.com".into(),
        from_name: "Whittle".into(),
        ..Default::default()
    };
    whittle_server::mail::send_with(&smtp, "ada@example.com", "Hello", "It works.").await.unwrap();
    let msg = received.await.unwrap();
    assert!(msg.contains("Subject: Hello"), "{msg}");
    assert!(msg.contains("It works."), "{msg}");

    // The admin "send test email" uses unsaved form values.
    let (port, received) = fake_smtp().await;
    let app = app(|_| {}).await;
    let (ada, _) = with_admin(&app).await;
    let r = post_json(
        &app,
        "/api/admin/settings/test-email",
        Some(&ada),
        json!({ "to": "ada@example.com", "smtp": { "host": "127.0.0.1", "port": port, "security": "none", "fromAddress": "cad@example.com" } }),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", String::from_utf8_lossy(&r.body));
    assert!(received.await.unwrap().contains("Whittle test email"));
}

#[tokio::test]
async fn backup_and_restore_round_trip() {
    let app = app(|_| {}).await;
    let (ada, _) = with_admin(&app).await;
    let r = call(&app, Method::POST, "/api/designs", Some(&ada), Some(Body::from(whittle("Bracket"))), false, &[]).await;
    assert_eq!(r.status, StatusCode::CREATED);
    let file = app.state.config.data.join("backup.zip");
    whittle_server::tools::backup(&app.state.config, &file).await.unwrap();

    // Restoring over existing accounts needs --force.
    assert!(whittle_server::tools::restore(&app.state.config, &file, false).await.is_err());

    // Restore into a brand-new server.
    let fresh = std::env::temp_dir().join(format!("whittle-restore-{}", whittle_server::random_token(6)));
    let cfg = Config::for_data_dir(fresh.clone(), None);
    let msg = whittle_server::tools::restore(&cfg, &file, false).await.unwrap();
    assert!(msg.contains("restored 1 accounts"), "{msg}");
    let state = build_state(cfg).await.unwrap();
    let restored = App { router: router(state.clone()), state, _dir: TempDir(fresh) };
    let me = session(&post_json(&restored, "/api/auth/login", None, json!({ "username": "ada", "password": "correct horse" })).await);
    let list = call(&restored, Method::GET, "/api/designs", Some(&me), None, false, &[]).await.json();
    assert_eq!(list[0]["name"], "Bracket");
    let id = list[0]["id"].as_str().unwrap();
    assert_eq!(call(&restored, Method::GET, &format!("/api/designs/{id}"), Some(&me), None, false, &[]).await.status, StatusCode::OK);
}

#[tokio::test]
async fn ai_assistant_switch_controls_the_browser_policy() {
    let on = app(|_| {}).await;
    let r = call(&on, Method::GET, "/api/config", None, None, false, &[]).await;
    assert_eq!(r.json()["ai"], true);
    let csp = r.headers.get(header::CONTENT_SECURITY_POLICY).unwrap().to_str().unwrap().to_owned();
    assert!(csp.contains("connect-src 'self' blob: data: https:"), "{csp}");

    let off = app(|c| c.ai = false).await;
    let r = call(&off, Method::GET, "/api/config", None, None, false, &[]).await;
    assert_eq!(r.json()["ai"], false);
    let csp = r.headers.get(header::CONTENT_SECURITY_POLICY).unwrap().to_str().unwrap().to_owned();
    assert!(!csp.contains("https:"), "{csp}");
}

#[tokio::test]
async fn personal_data_is_kept_per_person_on_the_server() {
    let app = app(|_| {}).await;
    let (ada, _) = with_admin(&app).await;
    let bob = post_json(&app, "/api/admin/users", Some(&ada), json!({ "username": "bob", "password": "battery staple", "email": "bob@example.com" })).await.json();
    assert!(bob["id"].is_string());
    let login = post_json(&app, "/api/auth/login", None, json!({ "username": "bob", "password": "battery staple" })).await;
    let bob_cookie = session(&login);

    let none = call(&app, Method::GET, "/api/me/data/ai", Some(&ada), None, false, &[]).await;
    assert_eq!(none.status, StatusCode::OK);
    assert!(none.json().is_null());
    let put = call(&app, Method::PUT, "/api/me/data/ai", Some(&ada), Some(Body::from(r#"{"providers":[{"key":"sk-test"}]}"#)), true, &[]).await;
    assert_eq!(put.status, StatusCode::NO_CONTENT);
    let got = call(&app, Method::GET, "/api/me/data/ai", Some(&ada), None, false, &[]).await;
    assert_eq!(got.json()["providers"][0]["key"], "sk-test");
    // Someone else cannot see it, and bad keys and bodies are refused.
    let other = call(&app, Method::GET, "/api/me/data/ai", Some(&bob_cookie), None, false, &[]).await;
    assert!(other.json().is_null());
    let bad_key = call(&app, Method::PUT, "/api/me/data/a%20b", Some(&ada), Some(Body::from("{}")), true, &[]).await;
    assert_eq!(bad_key.status, StatusCode::BAD_REQUEST);
    let bad_body = call(&app, Method::PUT, "/api/me/data/ai", Some(&ada), Some(Body::from("not json")), true, &[]).await;
    assert_eq!(bad_body.status, StatusCode::BAD_REQUEST);
    let list = call(&app, Method::GET, "/api/me/data?prefix=a", Some(&ada), None, false, &[]).await;
    assert_eq!(list.json().as_array().unwrap().len(), 1);
    let del = call(&app, Method::DELETE, "/api/me/data/ai", Some(&ada), None, false, &[]).await;
    assert_eq!(del.status, StatusCode::NO_CONTENT);
    let gone = call(&app, Method::GET, "/api/me/data/ai", Some(&ada), None, false, &[]).await;
    assert!(gone.json().is_null());
}
