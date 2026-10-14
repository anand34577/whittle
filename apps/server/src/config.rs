//! Configuration from environment variables (see docs/SELF_HOSTING.md).

use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct OidcConfig {
    pub issuer: String,
    pub client_id: String,
    pub client_secret: Option<String>,
    /// Label for the sign-in button, e.g. "Authentik" or "Company SSO".
    pub name: String,
    pub scopes: Vec<String>,
    /// Create an account the first time someone signs in with OIDC.
    pub auto_create: bool,
}

#[derive(Clone, Debug)]
pub struct Config {
    pub bind: String,
    pub web: PathBuf,
    pub data: PathBuf,
    pub database_url: String,
    /// No sign-in at all: everyone shares one workspace (trusted networks only).
    pub auth_none: bool,
    pub auth_local: bool,
    pub oidc: Option<OidcConfig>,
    /// Anyone may create a local account (the very first account is always allowed).
    pub signup: bool,
    /// Public base URL, e.g. https://cad.example.com (needed for OIDC redirects).
    pub public_url: Option<String>,
    pub secure_cookies: bool,
    pub max_upload_bytes: usize,
    /// Versions kept per design (oldest are pruned).
    pub max_versions: i64,
    pub session_days: i64,
}

/// `sqlite:<path>` is the one URL form that works for relative, Unix and Windows paths (spaces included).
fn sqlite_url(data: &std::path::Path) -> String {
    format!("sqlite:{}?mode=rwc", data.join("whittle.db").to_string_lossy().replace(std::path::MAIN_SEPARATOR, "/"))
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().map(|v| v.trim().to_owned()).filter(|v| !v.is_empty())
}

fn env_bool(name: &str, default: bool) -> Result<bool, String> {
    match env(name).map(|v| v.to_ascii_lowercase()) {
        None => Ok(default),
        Some(v) if ["1", "true", "yes", "on"].contains(&v.as_str()) => Ok(true),
        Some(v) if ["0", "false", "no", "off"].contains(&v.as_str()) => Ok(false),
        Some(v) => Err(format!("{name}: expected true or false, got \"{v}\"")),
    }
}

fn env_num<T: std::str::FromStr>(name: &str, default: T) -> Result<T, String> {
    match env(name) {
        None => Ok(default),
        Some(v) => v.parse().map_err(|_| format!("{name}: \"{v}\" is not a number")),
    }
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let data = PathBuf::from(env("WHITTLE_DATA").unwrap_or_else(|| "data".into()));
        let port: u16 = env_num("PORT", 8080)?;
        let bind = env("WHITTLE_BIND").unwrap_or_else(|| format!("0.0.0.0:{port}"));
        let database_url = env("WHITTLE_DATABASE_URL").unwrap_or_else(|| sqlite_url(&data));

        let modes: Vec<String> = env("WHITTLE_AUTH")
            .unwrap_or_else(|| "local".into())
            .split(',')
            .map(|m| m.trim().to_ascii_lowercase())
            .filter(|m| !m.is_empty())
            .collect();
        for m in &modes {
            if !["none", "local", "oidc"].contains(&m.as_str()) {
                return Err(format!("WHITTLE_AUTH: unknown mode \"{m}\" (use none, local, oidc or local,oidc)"));
            }
        }
        let auth_none = modes.iter().any(|m| m == "none");
        if auth_none && modes.len() > 1 {
            return Err("WHITTLE_AUTH: \"none\" can't be combined with other modes".into());
        }
        let auth_local = modes.iter().any(|m| m == "local");
        let public_url = env("WHITTLE_PUBLIC_URL").map(|u| u.trim_end_matches('/').to_owned());

        let oidc = if modes.iter().any(|m| m == "oidc") {
            let issuer = env("WHITTLE_OIDC_ISSUER").ok_or("WHITTLE_OIDC_ISSUER is required for OIDC")?;
            let client_id = env("WHITTLE_OIDC_CLIENT_ID").ok_or("WHITTLE_OIDC_CLIENT_ID is required for OIDC")?;
            if public_url.is_none() {
                return Err("WHITTLE_PUBLIC_URL is required for OIDC (it builds the redirect URL)".into());
            }
            Some(OidcConfig {
                issuer,
                client_id,
                client_secret: env("WHITTLE_OIDC_CLIENT_SECRET"),
                name: env("WHITTLE_OIDC_NAME").unwrap_or_else(|| "Single sign-on".into()),
                scopes: env("WHITTLE_OIDC_SCOPES")
                    .unwrap_or_else(|| "openid email profile".into())
                    .split_whitespace()
                    .filter(|s| *s != "openid")
                    .map(str::to_owned)
                    .collect(),
                auto_create: env_bool("WHITTLE_OIDC_AUTO_CREATE", true)?,
            })
        } else {
            None
        };

        let secure_default = public_url.as_deref().is_some_and(|u| u.starts_with("https://"));
        Ok(Config {
            bind,
            web: PathBuf::from(env("WHITTLE_WEB").unwrap_or_else(|| "apps/web/dist".into())),
            data,
            database_url,
            auth_none,
            auth_local,
            oidc,
            signup: env_bool("WHITTLE_SIGNUP", false)?,
            public_url,
            secure_cookies: env_bool("WHITTLE_SECURE_COOKIES", secure_default)?,
            max_upload_bytes: env_num::<usize>("WHITTLE_MAX_UPLOAD_MB", 64)? * 1024 * 1024,
            max_versions: env_num("WHITTLE_MAX_VERSIONS", 50)?.max(1),
            session_days: env_num("WHITTLE_SESSION_DAYS", 30)?.max(1),
        })
    }

    /// A config for tests and embedding: local accounts, everything under `data`.
    pub fn for_data_dir(data: PathBuf, database_url: Option<String>) -> Self {
        let database_url = database_url.unwrap_or_else(|| sqlite_url(&data));
        Config {
            bind: "127.0.0.1:0".into(),
            web: data.join("web"),
            data,
            database_url,
            auth_none: false,
            auth_local: true,
            oidc: None,
            signup: false,
            public_url: None,
            secure_cookies: false,
            max_upload_bytes: 64 * 1024 * 1024,
            max_versions: 50,
            session_days: 30,
        }
    }
}
