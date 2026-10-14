//! OpenID Connect sign-in (Authorization Code + PKCE + nonce). Works with any
//! standard provider: Authentik, Keycloak, Authelia, Zitadel, Google, Entra ID...
//! Accounts are matched by issuer + subject, never by email.

use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

use axum::{
    extract::{Query, State},
    http::header,
    response::{IntoResponse, Redirect, Response},
};
use openidconnect::{
    core::{CoreAuthenticationFlow, CoreClient, CoreProviderMetadata},
    AuthorizationCode, ClientId, ClientSecret, CsrfToken, IssuerUrl, Nonce, PkceCodeChallenge, PkceCodeVerifier, RedirectUrl, Scope,
    TokenResponse,
};
use serde::Deserialize;
use tokio::sync::Mutex;

use crate::{auth, db, random_token, Shared};

const PENDING_TTL: Duration = Duration::from_secs(10 * 60);
const METADATA_TTL: Duration = Duration::from_secs(60 * 60);

struct Pending {
    verifier: PkceCodeVerifier,
    nonce: Nonce,
    return_to: String,
    at: Instant,
}

#[derive(Default)]
pub struct OidcState {
    metadata: Mutex<Option<(CoreProviderMetadata, Instant)>>,
    pending: Mutex<HashMap<String, Pending>>,
}

fn http_client() -> Result<openidconnect::reqwest::Client, String> {
    openidconnect::reqwest::ClientBuilder::new()
        // Following redirects here would open the door to SSRF.
        .redirect(openidconnect::reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())
}

async fn metadata(s: &Shared, http: &openidconnect::reqwest::Client) -> Result<CoreProviderMetadata, String> {
    let cfg = s.config.oidc.as_ref().ok_or("Single sign-on isn't configured")?;
    let mut cached = s.oidc.metadata.lock().await;
    if let Some((m, at)) = cached.as_ref() {
        if at.elapsed() < METADATA_TTL {
            return Ok(m.clone());
        }
    }
    let issuer = IssuerUrl::new(cfg.issuer.clone()).map_err(|e| format!("Bad issuer URL: {e}"))?;
    let m = CoreProviderMetadata::discover_async(issuer, http)
        .await
        .map_err(|e| format!("Couldn't reach the sign-in provider: {e}"))?;
    *cached = Some((m.clone(), Instant::now()));
    Ok(m)
}

fn redirect_url(s: &Shared) -> Result<RedirectUrl, String> {
    let base = s.config.public_url.as_deref().ok_or("WHITTLE_PUBLIC_URL isn't set")?;
    RedirectUrl::new(format!("{base}/api/auth/oidc/callback")).map_err(|e| e.to_string())
}

/// Send the browser back to the app with an error it can show.
fn fail(msg: &str) -> Response {
    tracing::warn!("single sign-on failed: {msg}");
    let q = url::form_urlencoded::Serializer::new(String::new()).append_pair("login_error", msg).finish();
    Redirect::to(&format!("/?{q}")).into_response()
}

/// Only same-site paths, so the sign-in flow can't be used as an open redirect.
fn safe_return(r: Option<String>) -> String {
    r.filter(|p| p.starts_with('/') && !p.starts_with("//") && !p.contains('\\')).unwrap_or_else(|| "/".into())
}

#[derive(Deserialize)]
pub struct StartQuery {
    #[serde(rename = "return")]
    return_to: Option<String>,
}

pub async fn start(State(s): State<Shared>, Query(q): Query<StartQuery>) -> Response {
    let Some(cfg) = s.config.oidc.clone() else { return fail("Single sign-on isn't configured on this server") };
    let http = match http_client() {
        Ok(h) => h,
        Err(e) => return fail(&e),
    };
    let meta = match metadata(&s, &http).await {
        Ok(m) => m,
        Err(e) => return fail(&e),
    };
    let redirect = match redirect_url(&s) {
        Ok(r) => r,
        Err(e) => return fail(&e),
    };
    let client = CoreClient::from_provider_metadata(meta, ClientId::new(cfg.client_id.clone()), cfg.client_secret.clone().map(ClientSecret::new))
        .set_redirect_uri(redirect);
    let (challenge, verifier) = PkceCodeChallenge::new_random_sha256();
    let mut req = client.authorize_url(CoreAuthenticationFlow::AuthorizationCode, CsrfToken::new_random, Nonce::new_random);
    for scope in &cfg.scopes {
        req = req.add_scope(Scope::new(scope.clone()));
    }
    let (url, csrf, nonce) = req.set_pkce_challenge(challenge).url();
    let mut pending = s.oidc.pending.lock().await;
    pending.retain(|_, p| p.at.elapsed() < PENDING_TTL);
    pending.insert(csrf.secret().clone(), Pending { verifier, nonce, return_to: safe_return(q.return_to), at: Instant::now() });
    Redirect::to(url.as_str()).into_response()
}

#[derive(Deserialize)]
pub struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

pub async fn callback(State(s): State<Shared>, Query(q): Query<CallbackQuery>) -> Response {
    match finish(&s, q).await {
        Ok((cookie, to)) => ([(header::SET_COOKIE, cookie)], Redirect::to(&to)).into_response(),
        Err(e) => fail(&e),
    }
}

async fn finish(s: &Shared, q: CallbackQuery) -> Result<(axum::http::HeaderValue, String), String> {
    if let Some(e) = q.error {
        return Err(q.error_description.unwrap_or(e));
    }
    let cfg = s.config.oidc.clone().ok_or("Single sign-on isn't configured")?;
    let state = q.state.ok_or("The sign-in response is missing its state")?;
    let code = q.code.ok_or("The sign-in response is missing its code")?;
    let pending = s
        .oidc
        .pending
        .lock()
        .await
        .remove(&state)
        .filter(|p| p.at.elapsed() < PENDING_TTL)
        .ok_or("The sign-in took too long or was already used. Please try again.")?;

    let http = http_client()?;
    let meta = metadata(s, &http).await?;
    let client = CoreClient::from_provider_metadata(meta, ClientId::new(cfg.client_id.clone()), cfg.client_secret.clone().map(ClientSecret::new))
        .set_redirect_uri(redirect_url(s)?);
    let token = client
        .exchange_code(AuthorizationCode::new(code))
        .map_err(|e| e.to_string())?
        .set_pkce_verifier(pending.verifier)
        .request_async(&http)
        .await
        .map_err(|e| format!("The sign-in provider rejected the login: {e}"))?;
    let id_token = token.id_token().ok_or("The sign-in provider didn't return an ID token")?;
    let claims = id_token
        .claims(&client.id_token_verifier(), &pending.nonce)
        .map_err(|e| format!("The ID token couldn't be verified: {e}"))?;

    let subject = format!("{}|{}", cfg.issuer, claims.subject().as_str());
    let email = claims.email().map(|e| e.as_str().to_owned());
    let name = claims.name().and_then(|n| n.get(None)).map(|n| n.as_str().to_owned());
    let preferred = claims.preferred_username().map(|u| u.as_str().to_owned());

    let user = match db::user_by(&s.db, "oidc_subject", &subject).await.map_err(|e| e.to_string())? {
        Some(u) => u,
        None => {
            if !cfg.auto_create {
                return Err("You don't have an account here yet. Ask an administrator to create one.".into());
            }
            let base = preferred.clone().or_else(|| email.as_ref().map(|e| e.split('@').next().unwrap_or("").to_owned())).unwrap_or_default();
            let username = unique_username(s, &base).await?;
            let first = db::user_count(&s.db).await.map_err(|e| e.to_string())? == 0;
            let id = random_token(12);
            db::insert_user(
                &s.db,
                &id,
                db::NewUser {
                    username: &username,
                    display_name: name.as_deref().unwrap_or(&username),
                    email: email.as_deref(),
                    password_hash: None,
                    oidc_subject: Some(&subject),
                    is_admin: first,
                },
            )
            .await
            .map_err(|e| e.to_string())?;
            db::user_by(&s.db, "id", &id).await.map_err(|e| e.to_string())?.ok_or("Account creation failed")?
        }
    };
    if user.disabled {
        return Err("This account is disabled".into());
    }
    let cookie = auth::start_session(s, &user.id).await.map_err(|e| e.1)?;
    Ok((cookie, pending.return_to))
}

async fn unique_username(s: &Shared, base: &str) -> Result<String, String> {
    let mut clean: String = base.chars().filter(|c| c.is_ascii_alphanumeric() || "._-@".contains(*c)).take(56).collect();
    if clean.is_empty() || clean.eq_ignore_ascii_case("local") {
        clean = "user".into();
    }
    let mut candidate = clean.clone();
    for n in 2..1000 {
        if db::user_by(&s.db, "username", &candidate).await.map_err(|e| e.to_string())?.is_none() {
            return Ok(candidate);
        }
        candidate = format!("{clean}-{n}");
    }
    Ok(format!("{clean}-{}", random_token(4)))
}
