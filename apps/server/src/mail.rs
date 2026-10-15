//! Email over SMTP: plain (unencrypted), STARTTLS (optional or required) or
//! implicit TLS, with or without authentication. Used for invitations,
//! password resets and security notices.

use std::time::Duration;

use lettre::{
    message::{header::ContentType, Mailbox},
    transport::smtp::{
        authentication::Credentials,
        client::{Tls, TlsParameters},
    },
    AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
};

use crate::{
    settings::{SmtpSecurity, SmtpSettings},
    Shared,
};

fn transport(c: &SmtpSettings) -> Result<AsyncSmtpTransport<Tokio1Executor>, String> {
    let tls = || {
        TlsParameters::builder(c.host.clone())
            .dangerous_accept_invalid_certs(c.accept_invalid_certs)
            .build_rustls()
            .map_err(|e| format!("TLS setup failed: {e}"))
    };
    let mut b = AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&c.host).port(c.port);
    b = match c.security {
        SmtpSecurity::None => b.tls(Tls::None),
        SmtpSecurity::StarttlsOptional => b.tls(Tls::Opportunistic(tls()?)),
        SmtpSecurity::Starttls => b.tls(Tls::Required(tls()?)),
        SmtpSecurity::Tls => b.tls(Tls::Wrapper(tls()?)),
    };
    if !c.username.is_empty() {
        b = b.credentials(Credentials::new(c.username.clone(), c.password.clone()));
    }
    Ok(b.timeout(Some(Duration::from_secs(20))).build())
}

/// Send one plain-text email now. Errors are readable (shown to administrators).
pub async fn send_with(c: &SmtpSettings, to: &str, subject: &str, body: &str) -> Result<(), String> {
    if !c.configured() {
        return Err("Email isn't set up. Add an SMTP server in Admin → Settings.".into());
    }
    let from: Mailbox = format!("{} <{}>", c.from_name.replace(['<', '>', '"'], ""), c.from_address)
        .parse()
        .or_else(|_| c.from_address.parse())
        .map_err(|e| format!("The sender address isn't valid: {e}"))?;
    let to: Mailbox = to.parse().map_err(|e| format!("\"{to}\" isn't a valid email address: {e}"))?;
    let msg = Message::builder()
        .from(from)
        .to(to)
        .subject(subject)
        .header(ContentType::TEXT_PLAIN)
        .body(body.to_owned())
        .map_err(|e| format!("The message couldn't be built: {e}"))?;
    transport(c)?.send(msg).await.map(|_| ()).map_err(|e| format!("The mail server refused: {e}"))
}

pub async fn send(s: &Shared, to: &str, subject: &str, body: &str) -> Result<(), String> {
    let smtp = s.settings.read().await.smtp.clone();
    send_with(&smtp, to, subject, body).await
}

/// Send in the background: notifications never slow down or fail the action that caused them.
pub fn notify(s: &Shared, to: Option<String>, subject: String, body: String) {
    let Some(to) = to.filter(|t| !t.is_empty()) else { return };
    let s = s.clone();
    tokio::spawn(async move {
        if !s.settings.read().await.smtp.configured() {
            return;
        }
        if let Err(e) = send(&s, &to, &subject, &body).await {
            tracing::warn!("email to {to} failed: {e}");
            crate::db::audit(&s.db, None, "email.failed", Some(&to), &e).await;
        }
    });
}

/// The footer every message ends with.
pub fn signature(base: &str) -> String {
    format!("\n\n--\nWhittle · {base}\nYou're receiving this because you have an account on this Whittle server.")
}
