//! Database access. One portable schema for SQLite (default) and PostgreSQL:
//! TEXT ids, BIGINT timestamps (unix ms) and 0/1 flags, `$n` placeholders.
//! Design files live on disk; the database holds accounts and metadata.

use sqlx::any::{AnyPoolOptions, AnyRow};
use sqlx::{AnyPool, Row};

pub type Db = AnyPool;

/// Ordered schema migrations. Never edit one that has shipped: append a new one.
const MIGRATIONS: &[&[&str]] = &[&[
    "CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        email TEXT,
        password_hash TEXT,
        oidc_subject TEXT UNIQUE,
        is_admin BIGINT NOT NULL DEFAULT 0,
        disabled BIGINT NOT NULL DEFAULT 0,
        created_at BIGINT NOT NULL
    )",
    "CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL
    )",
    "CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id)",
    "CREATE TABLE IF NOT EXISTS designs (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        name TEXT NOT NULL,
        size BIGINT NOT NULL,
        head BIGINT NOT NULL,
        has_thumbnail BIGINT NOT NULL DEFAULT 0,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
    )",
    "CREATE INDEX IF NOT EXISTS designs_owner ON designs (owner_id)",
    "CREATE TABLE IF NOT EXISTS design_versions (
        design_id TEXT NOT NULL,
        version BIGINT NOT NULL,
        size BIGINT NOT NULL,
        created_at BIGINT NOT NULL,
        author_id TEXT,
        PRIMARY KEY (design_id, version)
    )",
], &[
    // v2: sign-in tracking, single sign-on linking, server settings, password resets, audit log.
    "ALTER TABLE users ADD COLUMN last_login_at BIGINT",
    // 1 = link this account to the single sign-on identity with the same verified email on next sign-in.
    "ALTER TABLE users ADD COLUMN sso_link BIGINT NOT NULL DEFAULT 0",
    "CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )",
    "CREATE TABLE IF NOT EXISTS password_resets (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at BIGINT NOT NULL
    )",
    "CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        at BIGINT NOT NULL,
        actor TEXT,
        action TEXT NOT NULL,
        target TEXT,
        detail TEXT
    )",
    "CREATE INDEX IF NOT EXISTS audit_at ON audit_log (at)",
], &[
    // v3: per-person data kept on the server (preferences, AI assistant settings, recovery drafts).
    "CREATE TABLE IF NOT EXISTS user_data (
        user_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (user_id, key)
    )",
]];

pub async fn connect(url: &str) -> Result<Db, sqlx::Error> {
    sqlx::any::install_default_drivers();
    let sqlite = url.starts_with("sqlite:");
    let pool = AnyPoolOptions::new()
        // SQLite has one writer; a small pool avoids "database is locked" churn.
        .max_connections(if sqlite { 4 } else { 16 })
        .connect(url)
        .await?;
    if sqlite {
        sqlx::query("PRAGMA journal_mode = WAL").execute(&pool).await?;
    }
    migrate(&pool).await?;
    Ok(pool)
}

async fn migrate(db: &Db) -> Result<(), sqlx::Error> {
    sqlx::query("CREATE TABLE IF NOT EXISTS whittle_schema (version BIGINT NOT NULL)").execute(db).await?;
    let current: i64 = sqlx::query("SELECT COALESCE(MAX(version), 0) AS v FROM whittle_schema")
        .fetch_one(db)
        .await?
        .try_get("v")?;
    for (i, steps) in MIGRATIONS.iter().enumerate() {
        let version = i as i64 + 1;
        if version <= current {
            continue;
        }
        let mut tx = db.begin().await?;
        for sql in *steps {
            sqlx::query(sql).execute(&mut *tx).await?;
        }
        sqlx::query("INSERT INTO whittle_schema (version) VALUES ($1)").bind(version).execute(&mut *tx).await?;
        tx.commit().await?;
        tracing::info!("database schema upgraded to version {version}");
    }
    Ok(())
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub email: Option<String>,
    pub is_admin: bool,
    pub disabled: bool,
    pub has_password: bool,
    pub sso: bool,
    /// Waiting to be linked to single sign-on by email on the next sign-in.
    pub sso_link: bool,
    pub created_at: i64,
    pub last_login_at: Option<i64>,
    #[serde(skip)]
    pub password_hash: Option<String>,
}

pub const USER_COLUMNS: &str = "id, username, display_name, email, password_hash, oidc_subject, is_admin, disabled, created_at, last_login_at, sso_link";

pub fn user_from_row(r: &AnyRow) -> Result<User, sqlx::Error> {
    let password_hash: Option<String> = r.try_get("password_hash")?;
    let oidc: Option<String> = r.try_get("oidc_subject")?;
    Ok(User {
        id: r.try_get("id")?,
        username: r.try_get("username")?,
        display_name: r.try_get("display_name")?,
        email: r.try_get("email")?,
        is_admin: r.try_get::<i64, _>("is_admin")? != 0,
        disabled: r.try_get::<i64, _>("disabled")? != 0,
        has_password: password_hash.is_some(),
        sso: oidc.is_some(),
        sso_link: r.try_get::<i64, _>("sso_link")? != 0,
        created_at: r.try_get("created_at")?,
        last_login_at: r.try_get("last_login_at")?,
        password_hash,
    })
}

pub async fn user_by(db: &Db, column: &str, value: &str) -> Result<Option<User>, sqlx::Error> {
    // `column` is always a literal from this crate, never user input.
    let sql = format!("SELECT {USER_COLUMNS} FROM users WHERE {column} = $1");
    match sqlx::query(&sql).bind(value).fetch_optional(db).await? {
        Some(r) => Ok(Some(user_from_row(&r)?)),
        None => Ok(None),
    }
}

/// Another account (not `except`) already using this email, case-insensitively.
pub async fn email_taken(db: &Db, email: &str, except: Option<&str>) -> Result<bool, sqlx::Error> {
    let n: i64 = sqlx::query("SELECT COUNT(*) AS n FROM users WHERE LOWER(email) = LOWER($1) AND id <> $2")
        .bind(email)
        .bind(except.unwrap_or(""))
        .fetch_one(db)
        .await?
        .try_get("n")?;
    Ok(n > 0)
}

pub async fn get_setting(db: &Db, key: &str) -> Result<Option<String>, sqlx::Error> {
    sqlx::query("SELECT value FROM settings WHERE key = $1").bind(key).fetch_optional(db).await?.map(|r| r.try_get("value")).transpose()
}

pub async fn set_setting(db: &Db, key: &str, value: &str) -> Result<(), sqlx::Error> {
    // Portable upsert (SQLite and PostgreSQL).
    let mut tx = db.begin().await?;
    sqlx::query("DELETE FROM settings WHERE key = $1").bind(key).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO settings (key, value) VALUES ($1, $2)").bind(key).bind(value).execute(&mut *tx).await?;
    tx.commit().await
}

/// Record an administrative or security-relevant event.
pub async fn audit(db: &Db, actor: Option<&str>, action: &str, target: Option<&str>, detail: &str) {
    let r = sqlx::query("INSERT INTO audit_log (id, at, actor, action, target, detail) VALUES ($1, $2, $3, $4, $5, $6)")
        .bind(crate::random_token(12))
        .bind(now_ms())
        .bind(actor.map(str::to_owned))
        .bind(action)
        .bind(target.map(str::to_owned))
        .bind(detail)
        .execute(db)
        .await;
    if let Err(e) = r {
        tracing::warn!("couldn't write the audit log: {e}");
    }
}

pub async fn user_count(db: &Db) -> Result<i64, sqlx::Error> {
    sqlx::query("SELECT COUNT(*) AS n FROM users WHERE id <> 'local'").fetch_one(db).await?.try_get("n")
}

pub struct NewUser<'a> {
    pub username: &'a str,
    pub display_name: &'a str,
    pub email: Option<&'a str>,
    pub password_hash: Option<&'a str>,
    pub oidc_subject: Option<&'a str>,
    pub is_admin: bool,
}

pub async fn insert_user(db: &Db, id: &str, u: NewUser<'_>) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO users (id, username, display_name, email, password_hash, oidc_subject, is_admin, disabled, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8)",
    )
    .bind(id)
    .bind(u.username)
    .bind(u.display_name)
    .bind(u.email.map(str::to_owned))
    .bind(u.password_hash.map(str::to_owned))
    .bind(u.oidc_subject.map(str::to_owned))
    .bind(u.is_admin as i64)
    .bind(now_ms())
    .execute(db)
    .await?;
    Ok(())
}
