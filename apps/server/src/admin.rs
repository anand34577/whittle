//! Administration: people (add, invite, edit, disable, promote, merge, link or
//! unlink single sign-on, sign out everywhere, reset), server settings
//! (sign-up, single sign-on, email), the audit log and an overview.

use std::collections::HashMap;

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::{
    auth::{self, base_url, check_password_rules, check_username, clean_email, create_local_user, hash_password, security_notice, AdminUser},
    db::{self, now_ms, User, USER_COLUMNS},
    mail,
    settings::{Notifications, ServerSettings, SmtpSecurity},
    ApiError, ApiResult, Shared,
};

/* ───────────────────────── People ───────────────────────── */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminUserInfo {
    #[serde(flatten)]
    user: User,
    designs: i64,
    /// Bytes on disk across all versions.
    storage: i64,
    sessions: i64,
}

async fn usage(s: &Shared) -> ApiResult<(HashMap<String, (i64, i64)>, HashMap<String, i64>)> {
    let mut by_owner = HashMap::new();
    let rows = sqlx::query(
        "SELECT d.owner_id AS owner, COUNT(DISTINCT d.id) AS n, CAST(COALESCE(SUM(v.size), 0) AS BIGINT) AS bytes
         FROM designs d LEFT JOIN design_versions v ON v.design_id = d.id GROUP BY d.owner_id",
    )
    .fetch_all(&s.db)
    .await?;
    for r in rows {
        by_owner.insert(r.try_get::<String, _>("owner")?, (r.try_get("n")?, r.try_get("bytes")?));
    }
    let mut sessions = HashMap::new();
    for r in sqlx::query("SELECT user_id, COUNT(*) AS n FROM sessions WHERE expires_at > $1 GROUP BY user_id").bind(now_ms()).fetch_all(&s.db).await? {
        sessions.insert(r.try_get::<String, _>("user_id")?, r.try_get("n")?);
    }
    Ok((by_owner, sessions))
}

pub async fn list(State(s): State<Shared>, AdminUser(_): AdminUser) -> ApiResult<Json<Vec<AdminUserInfo>>> {
    let sql = format!("SELECT {USER_COLUMNS} FROM users WHERE id <> 'local' ORDER BY username");
    let rows = sqlx::query(&sql).fetch_all(&s.db).await?;
    let (by_owner, sessions) = usage(&s).await?;
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        let user = db::user_from_row(&r)?;
        let (designs, storage) = by_owner.get(&user.id).copied().unwrap_or((0, 0));
        let sessions = sessions.get(&user.id).copied().unwrap_or(0);
        out.push(AdminUserInfo { user, designs, storage, sessions });
    }
    Ok(Json(out))
}

async fn target(s: &Shared, id: &str) -> ApiResult<User> {
    db::user_by(&s.db, "id", id).await?.filter(|u| u.id != "local").ok_or_else(ApiError::not_found)
}

async fn active_admins(s: &Shared) -> ApiResult<i64> {
    Ok(sqlx::query("SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND disabled = 0 AND id <> 'local'").fetch_one(&s.db).await?.try_get("n")?)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateBody {
    username: String,
    /// Empty: no password. The person signs in with single sign-on, or sets one from an emailed invitation.
    #[serde(default)]
    password: String,
    display_name: Option<String>,
    email: Option<String>,
    #[serde(default)]
    is_admin: bool,
    /// Email them a link to set their own password (needs SMTP).
    #[serde(default)]
    invite: bool,
}

pub async fn create(State(s): State<Shared>, headers: HeaderMap, AdminUser(me): AdminUser, Json(b): Json<CreateBody>) -> ApiResult<(StatusCode, Json<User>)> {
    // The same lock as sign-up: the name and email checks and the insert happen as one (audit S-4).
    let _guard = auth::REGISTER_LOCK.lock().await;
    let password = Some(b.password.as_str()).filter(|p| !p.is_empty());
    let (require_email, smtp, welcome) = {
        let st = s.settings.read().await;
        (st.require_email(), st.smtp.configured(), st.notifications.welcome)
    };
    let email = clean_email(&s, b.email.as_deref(), None, require_email || password.is_none() || b.invite).await?;
    if password.is_none() && !b.invite && s.config.oidc.is_none() {
        return Err(ApiError::bad_request("Set a password, or send an invitation so they can choose one"));
    }
    if b.invite && !smtp {
        return Err(ApiError::bad_request("Invitations need email. Set up SMTP in Admin → Settings first, or set a password."));
    }
    let u = create_local_user(&s, &b.username, password, b.display_name.as_deref(), email.as_deref(), b.is_admin).await?;
    db::audit(&s.db, Some(&me.id), "user.create", Some(&u.username), if b.is_admin { "administrator" } else { "member" }).await;
    let base = base_url(&s, &headers);
    if b.invite {
        let link = auth::reset_link(&s, &base, &u.id).await?;
        mail::send(
            &s,
            email.as_deref().unwrap_or_default(),
            "You're invited to Whittle",
            &format!(
                "Hello {},\n\n{} added you to the Whittle server at {base}.\nYour username is \"{}\". Choose your password here (the link works for an hour):\n\n{link}{}{}",
                u.display_name,
                me.display_name,
                u.username,
                if s.config.oidc.is_some() { "\n\nYou can also sign in with single sign-on using this email address." } else { "" },
                mail::signature(&base)
            ),
        )
        .await
        .map_err(|e| ApiError::new(StatusCode::BAD_GATEWAY, format!("The account was created, but the invitation couldn't be sent: {e}")))?;
    } else if welcome {
        let how = if password.is_some() {
            format!("Sign in with your username \"{}\" and the password you were given.", u.username)
        } else {
            "Sign in with single sign-on using this email address.".to_owned()
        };
        mail::notify(&s, u.email.clone(), "Your Whittle account".into(), format!("Hello {},\n\n{} added you to the Whittle server at {base}.\n{how}{}", u.display_name, me.display_name, mail::signature(&base)));
    }
    Ok((StatusCode::CREATED, Json(u)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateBody {
    username: Option<String>,
    display_name: Option<String>,
    email: Option<String>,
    is_admin: Option<bool>,
    disabled: Option<bool>,
    password: Option<String>,
    /// Link to the single sign-on identity with the same verified email on next sign-in.
    sso_link: Option<bool>,
}

pub async fn update(State(s): State<Shared>, headers: HeaderMap, AdminUser(me): AdminUser, Path(id): Path<String>, Json(b): Json<UpdateBody>) -> ApiResult<Json<User>> {
    let t = target(&s, &id).await?;
    let demoting = (b.is_admin == Some(false) || b.disabled == Some(true)) && t.is_admin && !t.disabled;
    if demoting && active_admins(&s).await? <= 1 {
        return Err(ApiError::bad_request("There must be at least one active administrator"));
    }
    if b.disabled == Some(true) && id == me.id {
        return Err(ApiError::bad_request("You can't disable your own account"));
    }
    if b.is_admin == Some(false) && id == me.id {
        return Err(ApiError::bad_request("Ask another administrator to remove your administrator rights"));
    }
    // Everything is checked first and then saved in one transaction, so a refused value (a taken email, say)
    // doesn't leave the earlier changes half applied (audit S-8).
    let mut changes: Vec<String> = Vec::new();
    let username = match b.username.as_deref().map(str::trim).filter(|n| *n != t.username) {
        Some(name) => {
            check_username(name).map_err(ApiError::bad_request)?;
            // Another account with that name (case doesn't count); changing only the case of one's own is fine.
            if db::user_by(&s.db, "username", name).await?.is_some_and(|other| other.id != id) {
                return Err(ApiError::new(StatusCode::CONFLICT, "That username is taken"));
            }
            Some(name.to_owned())
        }
        None => None,
    };
    let display = b.display_name.as_deref().map(str::trim).filter(|n| !n.is_empty()).map(str::to_owned);
    let email = match b.email.as_deref() {
        Some(e) => {
            let required = s.settings.read().await.require_email();
            Some(clean_email(&s, Some(e), Some(&id), required).await?)
        }
        None => None,
    };
    if let Some(l) = b.sso_link {
        if l && t.sso {
            return Err(ApiError::bad_request("This account is already linked to single sign-on"));
        }
        let email_after = email.clone().unwrap_or(t.email.clone());
        if l && email_after.is_none() {
            return Err(ApiError::bad_request("Add an email address first: linking matches the email on the single sign-on account"));
        }
    }
    let hash = match &b.password {
        Some(p) => {
            check_password_rules(p).map_err(ApiError::bad_request)?;
            Some(hash_password(p.clone()).await?)
        }
        None => None,
    };

    let mut tx = s.db.begin().await?;
    if let Some(name) = &username {
        sqlx::query("UPDATE users SET username = $1 WHERE id = $2").bind(name).bind(&id).execute(&mut *tx).await?;
        changes.push(format!("username {} → {name}", t.username));
    }
    if let Some(name) = &display {
        sqlx::query("UPDATE users SET display_name = $1 WHERE id = $2").bind(name).bind(&id).execute(&mut *tx).await?;
        changes.push("name".into());
    }
    if let Some(e) = &email {
        sqlx::query("UPDATE users SET email = $1 WHERE id = $2").bind(e).bind(&id).execute(&mut *tx).await?;
        changes.push("email".into());
    }
    if let Some(a) = b.is_admin {
        sqlx::query("UPDATE users SET is_admin = $1 WHERE id = $2").bind(a as i64).bind(&id).execute(&mut *tx).await?;
        changes.push(if a { "made administrator" } else { "removed administrator" }.into());
    }
    if let Some(d) = b.disabled {
        sqlx::query("UPDATE users SET disabled = $1 WHERE id = $2").bind(d as i64).bind(&id).execute(&mut *tx).await?;
        if d {
            sqlx::query("DELETE FROM sessions WHERE user_id = $1").bind(&id).execute(&mut *tx).await?;
        }
        changes.push(if d { "disabled" } else { "enabled" }.into());
    }
    if let Some(l) = b.sso_link {
        sqlx::query("UPDATE users SET sso_link = $1 WHERE id = $2").bind(l as i64).bind(&id).execute(&mut *tx).await?;
        changes.push(if l { "will link to single sign-on by email" } else { "cancelled single sign-on link" }.into());
    }
    if let Some(h) = &hash {
        sqlx::query("UPDATE users SET password_hash = $1 WHERE id = $2").bind(h).bind(&id).execute(&mut *tx).await?;
        // Every device is signed out, except the administrator's own session when it is their own account (audit S-7).
        let keep = if id == me.id { auth::cookie_token(&headers).map(|t| auth::session_id(&t)).unwrap_or_default() } else { String::new() };
        sqlx::query("DELETE FROM sessions WHERE user_id = $1 AND id <> $2").bind(&id).bind(keep).execute(&mut *tx).await?;
        changes.push("password reset".into());
    }
    tx.commit().await?;
    if b.disabled == Some(true) {
        security_notice(&s, &headers, &t, "Your Whittle account was disabled", "An administrator disabled your account. You can't sign in until it's enabled again.");
    }
    if hash.is_some() {
        security_notice(&s, &headers, &t, "Your Whittle password was reset", "An administrator set a new password for your account, and all devices were signed out.");
    }
    if !changes.is_empty() {
        db::audit(&s.db, Some(&me.id), "user.update", Some(&t.username), &changes.join(", ")).await;
    }
    Ok(Json(target(&s, &id).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteQuery {
    /// Give the designs to this account instead of deleting them.
    transfer_to: Option<String>,
}

pub async fn delete(State(s): State<Shared>, AdminUser(me): AdminUser, Path(id): Path<String>, Query(q): Query<DeleteQuery>) -> ApiResult<StatusCode> {
    if id == me.id {
        return Err(ApiError::bad_request("You can't delete your own account"));
    }
    let t = target(&s, &id).await?;
    if t.is_admin && !t.disabled && active_admins(&s).await? <= 1 {
        return Err(ApiError::bad_request("There must be at least one active administrator"));
    }
    let detail = match q.transfer_to.filter(|x| !x.is_empty()) {
        Some(to) => {
            if to == id {
                return Err(ApiError::bad_request("Pick a different account to receive the designs"));
            }
            let heir = target(&s, &to).await?;
            sqlx::query("UPDATE designs SET owner_id = $1 WHERE owner_id = $2").bind(&heir.id).bind(&id).execute(&s.db).await?;
            format!("designs given to {}", heir.username)
        }
        None => {
            crate::designs::delete_all_for(&s, &id).await?;
            "designs deleted".to_owned()
        }
    };
    let mut tx = s.db.begin().await?;
    sqlx::query("DELETE FROM sessions WHERE user_id = $1").bind(&id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM password_resets WHERE user_id = $1").bind(&id).execute(&mut *tx).await?;
    // Preferences, recovery drafts and AI provider keys go with the account.
    sqlx::query("DELETE FROM user_data WHERE user_id = $1").bind(&id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM users WHERE id = $1").bind(&id).execute(&mut *tx).await?;
    tx.commit().await?;
    db::audit(&s.db, Some(&me.id), "user.delete", Some(&t.username), &detail).await;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct MergeBody {
    into: String,
}

/// Merge account `id` into account `into`: typically a single sign-on account
/// someone created by signing in, folded into the local account they already
/// had (or the reverse). The kept account takes over the designs, the sign-in
/// methods it lacks (password, single sign-on identity), the email if it has
/// none, and administrator rights if either had them. The merged account is removed.
pub async fn merge(State(s): State<Shared>, AdminUser(me): AdminUser, Path(id): Path<String>, Json(b): Json<MergeBody>) -> ApiResult<Json<User>> {
    if id == b.into {
        return Err(ApiError::bad_request("Pick two different accounts"));
    }
    let from = target(&s, &id).await?;
    let into = target(&s, &b.into).await?;
    let from_row = sqlx::query("SELECT password_hash, oidc_subject FROM users WHERE id = $1").bind(&from.id).fetch_one(&s.db).await?;
    let into_row = sqlx::query("SELECT password_hash, oidc_subject FROM users WHERE id = $1").bind(&into.id).fetch_one(&s.db).await?;
    let from_sub: Option<String> = from_row.try_get("oidc_subject")?;
    let into_sub: Option<String> = into_row.try_get("oidc_subject")?;
    if from_sub.is_some() && into_sub.is_some() && from_sub != into_sub {
        return Err(ApiError::bad_request("Both accounts are linked to different single sign-on identities. Unlink one first."));
    }
    let from_hash: Option<String> = from_row.try_get("password_hash")?;
    let into_hash: Option<String> = into_row.try_get("password_hash")?;

    let mut tx = s.db.begin().await?;
    sqlx::query("UPDATE designs SET owner_id = $1 WHERE owner_id = $2").bind(&into.id).bind(&from.id).execute(&mut *tx).await?;
    sqlx::query("UPDATE design_versions SET author_id = $1 WHERE author_id = $2").bind(&into.id).bind(&from.id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM sessions WHERE user_id = $1").bind(&from.id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM password_resets WHERE user_id = $1").bind(&from.id).execute(&mut *tx).await?;
    // Personal data the kept account doesn't have yet moves over; the rest is dropped with the merged account.
    sqlx::query(
        "INSERT INTO user_data (user_id, key, value, updated_at) SELECT $1, key, value, updated_at FROM user_data WHERE user_id = $2
         ON CONFLICT (user_id, key) DO NOTHING",
    )
    .bind(&into.id)
    .bind(&from.id)
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM user_data WHERE user_id = $1").bind(&from.id).execute(&mut *tx).await?;
    // Free the unique single sign-on subject before giving it to the kept account.
    sqlx::query("DELETE FROM users WHERE id = $1").bind(&from.id).execute(&mut *tx).await?;
    sqlx::query("UPDATE users SET oidc_subject = $1, password_hash = $2, email = $3, is_admin = $4, sso_link = 0 WHERE id = $5")
        .bind(into_sub.or(from_sub))
        .bind(into_hash.or(from_hash))
        .bind(into.email.clone().or(from.email.clone()))
        .bind((into.is_admin || from.is_admin) as i64)
        .bind(&into.id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    db::audit(&s.db, Some(&me.id), "user.merge", Some(&into.username), &format!("merged {} into {}", from.username, into.username)).await;
    Ok(Json(target(&s, &into.id).await?))
}

pub async fn unlink_sso(State(s): State<Shared>, AdminUser(me): AdminUser, Path(id): Path<String>) -> ApiResult<Json<User>> {
    let t = target(&s, &id).await?;
    if !t.sso {
        return Err(ApiError::bad_request("This account isn't linked to single sign-on"));
    }
    sqlx::query("UPDATE users SET oidc_subject = NULL, sso_link = 0 WHERE id = $1").bind(&id).execute(&s.db).await?;
    sqlx::query("DELETE FROM sessions WHERE user_id = $1").bind(&id).execute(&s.db).await?;
    db::audit(&s.db, Some(&me.id), "user.sso_unlink", Some(&t.username), "").await;
    Ok(Json(target(&s, &id).await?))
}

pub async fn revoke_sessions(State(s): State<Shared>, AdminUser(me): AdminUser, Path(id): Path<String>) -> ApiResult<StatusCode> {
    let t = target(&s, &id).await?;
    sqlx::query("DELETE FROM sessions WHERE user_id = $1").bind(&id).execute(&s.db).await?;
    db::audit(&s.db, Some(&me.id), "user.signout", Some(&t.username), "signed out everywhere").await;
    Ok(StatusCode::NO_CONTENT)
}

/// Email a password-reset link to someone (they choose the new password themselves).
pub async fn send_reset(State(s): State<Shared>, headers: HeaderMap, AdminUser(me): AdminUser, Path(id): Path<String>) -> ApiResult<StatusCode> {
    let t = target(&s, &id).await?;
    let to = t.email.clone().ok_or_else(|| ApiError::bad_request("This account has no email address"))?;
    let base = base_url(&s, &headers);
    let link = auth::reset_link(&s, &base, &id).await?;
    mail::send(
        &s,
        &to,
        "Set your Whittle password",
        &format!(
            "Hello {},\n\nAn administrator sent you a link to set a new password for your Whittle account \"{}\" (it works for an hour):\n\n{link}{}",
            t.display_name,
            t.username,
            mail::signature(&base)
        ),
    )
    .await
    .map_err(|e| ApiError::new(StatusCode::BAD_GATEWAY, e))?;
    db::audit(&s.db, Some(&me.id), "user.reset_sent", Some(&t.username), "").await;
    Ok(StatusCode::NO_CONTENT)
}

/* ───────────────────────── Settings ───────────────────────── */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    signup: bool,
    oidc_auto_create: bool,
    oidc_link_by_email: bool,
    require_email: bool,
    notifications: Notifications,
    smtp: SmtpView,
    /// What the environment says (shown as the defaults).
    env_signup: bool,
    oidc: Option<String>,
    local: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmtpView {
    host: String,
    port: u16,
    security: SmtpSecurity,
    username: String,
    /// Whether a password is stored (it is never sent back).
    has_password: bool,
    from_address: String,
    from_name: String,
    accept_invalid_certs: bool,
    configured: bool,
}

fn view(s: &Shared, st: &ServerSettings) -> SettingsView {
    SettingsView {
        signup: st.signup(&s.config),
        oidc_auto_create: st.oidc_auto_create(&s.config),
        oidc_link_by_email: st.oidc_link_by_email,
        require_email: st.require_email(),
        notifications: st.notifications.clone(),
        smtp: SmtpView {
            host: st.smtp.host.clone(),
            port: st.smtp.port,
            security: st.smtp.security,
            username: st.smtp.username.clone(),
            has_password: !st.smtp.password.is_empty(),
            from_address: st.smtp.from_address.clone(),
            from_name: st.smtp.from_name.clone(),
            accept_invalid_certs: st.smtp.accept_invalid_certs,
            configured: st.smtp.configured(),
        },
        env_signup: s.config.signup,
        oidc: s.config.oidc.as_ref().map(|o| o.name.clone()),
        local: s.config.auth_local,
    }
}

pub async fn get_settings(State(s): State<Shared>, AdminUser(_): AdminUser) -> Json<SettingsView> {
    let st = s.settings.read().await;
    Json(view(&s, &st))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmtpPatch {
    host: Option<String>,
    port: Option<u16>,
    security: Option<SmtpSecurity>,
    username: Option<String>,
    /// Omit to keep the stored password; empty string clears it.
    password: Option<String>,
    from_address: Option<String>,
    from_name: Option<String>,
    accept_invalid_certs: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    signup: Option<bool>,
    oidc_auto_create: Option<bool>,
    oidc_link_by_email: Option<bool>,
    require_email: Option<bool>,
    notifications: Option<Notifications>,
    smtp: Option<SmtpPatch>,
}

fn apply_smtp(st: &mut ServerSettings, p: SmtpPatch) -> ApiResult<()> {
    let c = &mut st.smtp;
    if let Some(v) = p.host {
        c.host = v.trim().to_owned();
    }
    if let Some(v) = p.port {
        if v == 0 {
            return Err(ApiError::bad_request("Enter a port between 1 and 65535"));
        }
        c.port = v;
    }
    if let Some(v) = p.security {
        c.security = v;
    }
    if let Some(v) = p.username {
        c.username = v.trim().to_owned();
    }
    if let Some(v) = p.password {
        c.password = v;
    }
    if let Some(v) = p.from_address {
        let v = v.trim().to_owned();
        if !v.is_empty() {
            auth::check_email(&v).map_err(ApiError::bad_request)?;
        }
        c.from_address = v;
    }
    if let Some(v) = p.from_name {
        c.from_name = v.trim().to_owned();
    }
    if let Some(v) = p.accept_invalid_certs {
        c.accept_invalid_certs = v;
    }
    if c.port == 0 {
        c.port = match c.security {
            SmtpSecurity::Tls => 465,
            SmtpSecurity::None => 25,
            _ => 587,
        };
    }
    Ok(())
}

pub async fn put_settings(State(s): State<Shared>, AdminUser(me): AdminUser, Json(p): Json<SettingsPatch>) -> ApiResult<Json<SettingsView>> {
    let mut st = s.settings.read().await.clone();
    if let Some(v) = p.signup {
        st.signup = Some(v);
    }
    if let Some(v) = p.oidc_auto_create {
        st.oidc_auto_create = Some(v);
    }
    if let Some(v) = p.oidc_link_by_email {
        st.oidc_link_by_email = v;
    }
    if let Some(v) = p.require_email {
        st.require_email = Some(v);
    }
    if let Some(v) = p.notifications {
        st.notifications = v;
    }
    if let Some(smtp) = p.smtp {
        apply_smtp(&mut st, smtp)?;
    }
    st.save(&s.db).await?;
    *s.settings.write().await = st.clone();
    db::audit(&s.db, Some(&me.id), "settings.update", None, "").await;
    Ok(Json(view(&s, &st)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestBody {
    to: String,
    /// Unsaved SMTP settings to try (the form being edited).
    smtp: Option<SmtpPatch>,
}

pub async fn test_email(State(s): State<Shared>, headers: HeaderMap, AdminUser(me): AdminUser, Json(b): Json<TestBody>) -> ApiResult<Json<serde_json::Value>> {
    let mut st = s.settings.read().await.clone();
    if let Some(p) = b.smtp {
        apply_smtp(&mut st, p)?;
    }
    let base = base_url(&s, &headers);
    mail::send_with(
        &st.smtp,
        b.to.trim(),
        "Whittle test email",
        &format!("This is a test from your Whittle server, sent by {}.\nIf you can read this, email works.{}", me.display_name, mail::signature(&base)),
    )
    .await
    .map_err(|e| ApiError::new(StatusCode::BAD_GATEWAY, e))?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

/* ───────────────────────── Audit log & overview ───────────────────────── */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    at: i64,
    actor: Option<String>,
    action: String,
    target: Option<String>,
    detail: Option<String>,
}

#[derive(Deserialize)]
pub struct AuditQuery {
    limit: Option<i64>,
}

pub async fn audit_log(State(s): State<Shared>, AdminUser(_): AdminUser, Query(q): Query<AuditQuery>) -> ApiResult<Json<Vec<AuditEntry>>> {
    let limit = q.limit.unwrap_or(200).clamp(1, 1000);
    let rows = sqlx::query(
        "SELECT a.at, u.username AS actor, a.action, a.target, a.detail FROM audit_log a LEFT JOIN users u ON u.id = a.actor ORDER BY a.at DESC LIMIT $1",
    )
    .bind(limit)
    .fetch_all(&s.db)
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        out.push(AuditEntry { at: r.try_get("at")?, actor: r.try_get("actor")?, action: r.try_get("action")?, target: r.try_get("target")?, detail: r.try_get("detail")? });
    }
    Ok(Json(out))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    version: &'static str,
    uptime_secs: u64,
    database: &'static str,
    users: i64,
    admins: i64,
    disabled: i64,
    sso_users: i64,
    active_sessions: i64,
    designs: i64,
    versions: i64,
    storage: i64,
    auth: Vec<&'static str>,
    email: bool,
    data_dir: String,
}

pub async fn overview(State(s): State<Shared>, AdminUser(_): AdminUser) -> ApiResult<Json<Overview>> {
    let one = |sql: &'static str| {
        let db = s.db.clone();
        async move { sqlx::query(sql).fetch_one(&db).await?.try_get::<i64, _>("n") }
    };
    let mut auth = Vec::new();
    if s.config.auth_none {
        auth.push("none");
    }
    if s.config.auth_local {
        auth.push("local");
    }
    if s.config.oidc.is_some() {
        auth.push("oidc");
    }
    Ok(Json(Overview {
        version: env!("CARGO_PKG_VERSION"),
        uptime_secs: s.started.elapsed().as_secs(),
        database: if s.config.database_url.starts_with("postgres") { "PostgreSQL" } else { "SQLite" },
        users: one("SELECT COUNT(*) AS n FROM users WHERE id <> 'local'").await?,
        admins: one("SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND id <> 'local'").await?,
        disabled: one("SELECT COUNT(*) AS n FROM users WHERE disabled = 1").await?,
        sso_users: one("SELECT COUNT(*) AS n FROM users WHERE oidc_subject IS NOT NULL").await?,
        active_sessions: sqlx::query("SELECT COUNT(*) AS n FROM sessions WHERE expires_at > $1").bind(now_ms()).fetch_one(&s.db).await?.try_get("n")?,
        designs: one("SELECT COUNT(*) AS n FROM designs").await?,
        versions: one("SELECT COUNT(*) AS n FROM design_versions").await?,
        storage: one("SELECT CAST(COALESCE(SUM(size), 0) AS BIGINT) AS n FROM design_versions").await?,
        auth,
        email: s.settings.read().await.smtp.configured(),
        data_dir: s.config.data.display().to_string(),
    }))
}
