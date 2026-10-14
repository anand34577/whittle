//! whittle-server command line.
//!
//!   whittle-server                       run the server (configured by environment variables)
//!   whittle-server user add NAME [--admin]   create a local account (password from WHITTLE_PASSWORD or stdin)
//!   whittle-server user passwd NAME      set a new password
//!   whittle-server user admin NAME on|off
//!   whittle-server user list
//!   whittle-server --version | --help

use std::net::SocketAddr;

use tokio::io::AsyncBufReadExt;
use whittle_server::{auth, build_state, db, router, Config, Shared};

const HELP: &str = "whittle-server: self-hosted Whittle (web app, accounts, design storage)

USAGE:
  whittle-server                           run the server
  whittle-server user add NAME [--admin]   create a local account
  whittle-server user passwd NAME          set a new password
  whittle-server user admin NAME on|off    grant or remove administrator rights
  whittle-server user list                 list accounts
  whittle-server --version

Passwords are read from WHITTLE_PASSWORD, or from the first line of standard input.
Configuration is by environment variables; see docs/SELF_HOSTING.md.";

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info,tower_http=warn,sqlx=warn".into()))
        .init();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = match run(args).await {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("error: {e}");
            1
        }
    };
    std::process::exit(code);
}

async fn run(args: Vec<String>) -> Result<(), String> {
    let a: Vec<&str> = args.iter().map(String::as_str).collect();
    match a.as_slice() {
        ["--version" | "-V"] => {
            println!("whittle-server {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        ["--help" | "-h" | "help"] => {
            println!("{HELP}");
            Ok(())
        }
        [] | ["serve"] => serve().await,
        ["user", rest @ ..] => user_command(rest).await,
        _ => Err(format!("unknown command. Try --help.\n\n{HELP}")),
    }
}

async fn serve() -> Result<(), String> {
    let config = Config::from_env()?;
    if config.auth_none {
        tracing::warn!("WHITTLE_AUTH=none: anyone who can reach this server can open and change every design. Use only on a trusted network.");
    }
    if !config.web.join("index.html").exists() {
        tracing::warn!("no web app found at {} (set WHITTLE_WEB or run `npm run build`)", config.web.display());
    }
    let bind = config.bind.clone();
    let state = build_state(config).await?;
    let listener = tokio::net::TcpListener::bind(&bind).await.map_err(|e| format!("cannot listen on {bind}: {e}"))?;
    tracing::info!("Whittle {} is running on http://{bind}", env!("CARGO_PKG_VERSION"));
    axum::serve(listener, router(state).into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(shutdown_signal())
        .await
        .map_err(|e| e.to_string())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = term => {},
    }
    tracing::info!("shutting down");
}

async fn read_password() -> Result<String, String> {
    if let Ok(p) = std::env::var("WHITTLE_PASSWORD") {
        return Ok(p);
    }
    eprintln!("Password (input is not hidden; or set WHITTLE_PASSWORD):");
    let mut line = String::new();
    tokio::io::BufReader::new(tokio::io::stdin()).read_line(&mut line).await.map_err(|e| e.to_string())?;
    Ok(line.trim_end_matches(['\r', '\n']).to_owned())
}

async fn user_command(rest: &[&str]) -> Result<(), String> {
    let state: Shared = build_state(Config::from_env()?).await?;
    let err = |e: whittle_server::ApiError| e.1;
    match rest {
        ["add", name, flags @ ..] => {
            let admin = flags.contains(&"--admin");
            let password = read_password().await?;
            let u = auth::create_local_user(&state, name, Some(&password), None, None, admin).await.map_err(err)?;
            println!("created {}{}", u.username, if u.is_admin { " (administrator)" } else { "" });
        }
        ["passwd", name] => {
            let u = db::user_by(&state.db, "username", name).await.map_err(|e| e.to_string())?.ok_or("no such user")?;
            let password = read_password().await?;
            auth::check_password_rules(&password)?;
            let hash = auth::hash_password(password).await.map_err(err)?;
            sqlx::query("UPDATE users SET password_hash = $1 WHERE id = $2").bind(hash).bind(&u.id).execute(&state.db).await.map_err(|e| e.to_string())?;
            sqlx::query("DELETE FROM sessions WHERE user_id = $1").bind(&u.id).execute(&state.db).await.map_err(|e| e.to_string())?;
            println!("password updated for {}", u.username);
        }
        ["admin", name, on @ ("on" | "off")] => {
            let u = db::user_by(&state.db, "username", name).await.map_err(|e| e.to_string())?.ok_or("no such user")?;
            sqlx::query("UPDATE users SET is_admin = $1 WHERE id = $2").bind((*on == "on") as i64).bind(&u.id).execute(&state.db).await.map_err(|e| e.to_string())?;
            println!("{} is {} an administrator", u.username, if *on == "on" { "now" } else { "no longer" });
        }
        ["list"] => {
            let rows = sqlx::query(&format!("SELECT {} FROM users WHERE id <> 'local' ORDER BY username", db::USER_COLUMNS))
                .fetch_all(&state.db)
                .await
                .map_err(|e| e.to_string())?;
            for r in rows {
                let u = db::user_from_row(&r).map_err(|e| e.to_string())?;
                println!(
                    "{:<24} {:<28} {}{}{}",
                    u.username,
                    u.display_name,
                    if u.is_admin { "admin " } else { "" },
                    if u.sso { "sso " } else { "" },
                    if u.disabled { "disabled" } else { "" }
                );
            }
        }
        _ => return Err(format!("unknown user command.\n\n{HELP}")),
    }
    Ok(())
}
