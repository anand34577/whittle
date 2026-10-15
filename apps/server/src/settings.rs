//! Server settings that administrators change at runtime (Admin → Settings).
//! Environment variables give the starting values; anything saved here wins.
//! Stored as one JSON document in the `settings` table.

use serde::{Deserialize, Serialize};

use crate::{db, Config};

const KEY: &str = "server";

/// How the SMTP connection is secured.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SmtpSecurity {
    /// Plain, unencrypted SMTP (trusted networks and local relays only).
    None,
    /// Upgrade with STARTTLS when the server offers it, otherwise send in plain text.
    StarttlsOptional,
    /// Require STARTTLS (usually port 587).
    #[default]
    Starttls,
    /// TLS from the first byte (SMTPS, usually port 465).
    Tls,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SmtpSettings {
    pub host: String,
    pub port: u16,
    pub security: SmtpSecurity,
    pub username: String,
    /// Never sent to the browser (see `public`).
    pub password: String,
    pub from_address: String,
    pub from_name: String,
    /// Accept self-signed or mismatched certificates (internal mail servers).
    pub accept_invalid_certs: bool,
}

impl SmtpSettings {
    pub fn configured(&self) -> bool {
        !self.host.is_empty() && !self.from_address.is_empty()
    }

    pub fn from_env() -> Result<Self, String> {
        let env = |n: &str| std::env::var(n).ok().map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
        let security = match env("WHITTLE_SMTP_SECURITY").as_deref().map(str::to_ascii_lowercase).as_deref() {
            None | Some("starttls") => SmtpSecurity::Starttls,
            Some("starttls-optional") | Some("opportunistic") => SmtpSecurity::StarttlsOptional,
            Some("tls") | Some("ssl") | Some("smtps") => SmtpSecurity::Tls,
            Some("none") | Some("plain") | Some("insecure") | Some("unsecure") => SmtpSecurity::None,
            Some(o) => return Err(format!("WHITTLE_SMTP_SECURITY: unknown value \"{o}\" (use none, starttls-optional, starttls or tls)")),
        };
        let default_port = match security {
            SmtpSecurity::Tls => 465,
            SmtpSecurity::None => 25,
            _ => 587,
        };
        Ok(SmtpSettings {
            host: env("WHITTLE_SMTP_HOST").unwrap_or_default(),
            port: match env("WHITTLE_SMTP_PORT") {
                Some(p) => p.parse().map_err(|_| format!("WHITTLE_SMTP_PORT: \"{p}\" is not a port"))?,
                None => default_port,
            },
            security,
            username: env("WHITTLE_SMTP_USERNAME").unwrap_or_default(),
            password: env("WHITTLE_SMTP_PASSWORD").unwrap_or_default(),
            from_address: env("WHITTLE_SMTP_FROM").unwrap_or_default(),
            from_name: env("WHITTLE_SMTP_FROM_NAME").unwrap_or_else(|| "Whittle".into()),
            accept_invalid_certs: matches!(env("WHITTLE_SMTP_ACCEPT_INVALID_CERTS").as_deref(), Some("1" | "true" | "yes" | "on")),
        })
    }
}

/// Which emails Whittle sends (when SMTP is set up).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Notifications {
    /// Welcome new people an administrator adds (with how to sign in).
    pub welcome: bool,
    /// Tell people when their password is changed or reset, or their account is disabled.
    pub security: bool,
    /// Tell administrators when someone signs up.
    pub admin_on_signup: bool,
}

impl Default for Notifications {
    fn default() -> Self {
        Notifications { welcome: true, security: true, admin_on_signup: true }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ServerSettings {
    /// Anyone may create an account (None = WHITTLE_SIGNUP).
    pub signup: Option<bool>,
    /// Create an account on first single sign-on (None = WHITTLE_OIDC_AUTO_CREATE).
    pub oidc_auto_create: Option<bool>,
    /// Link a single sign-on identity to the existing account with the same verified email.
    pub oidc_link_by_email: bool,
    /// Require an email address on every new account.
    pub require_email: Option<bool>,
    pub notifications: Notifications,
    pub smtp: SmtpSettings,
}

impl ServerSettings {
    pub async fn load(db: &db::Db, config: &Config) -> Result<Self, String> {
        let mut s = match db::get_setting(db, KEY).await.map_err(|e| e.to_string())? {
            Some(json) => serde_json::from_str::<ServerSettings>(&json).unwrap_or_else(|e| {
                tracing::warn!("server settings couldn't be read ({e}); using defaults");
                ServerSettings::default()
            }),
            None => ServerSettings::default(),
        };
        if !s.smtp.configured() {
            s.smtp = config.smtp.clone();
        }
        Ok(s)
    }

    pub async fn save(&self, db: &db::Db) -> Result<(), sqlx::Error> {
        db::set_setting(db, KEY, &serde_json::to_string(self).expect("settings serialize")).await
    }

    pub fn signup(&self, config: &Config) -> bool {
        self.signup.unwrap_or(config.signup)
    }

    pub fn oidc_auto_create(&self, config: &Config) -> bool {
        self.oidc_auto_create.unwrap_or(config.oidc.as_ref().is_some_and(|o| o.auto_create))
    }

    pub fn require_email(&self) -> bool {
        self.require_email.unwrap_or(true)
    }
}
