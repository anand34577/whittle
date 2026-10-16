# Self-hosting the Whittle server

> The [wiki](https://github.com/anand34577/whittle/wiki/Self-Hosting) has step-by-step guides for every setup.

`whittle-server` is one small binary. It serves the Whittle web app, stores each person's designs with
their full version history, and handles sign-in. All modelling runs in the browser, so even a small
ARM board or a 1-CPU LXC container is enough.

You only need the server to work from a browser on several machines or to share one install with
other people. The desktop app works on its own, offline, and keeps files and history on your computer.

## What you get

- **Sign-in your way:** local accounts, single sign-on (OIDC), both, or **no sign-in at all** for a
  trusted home network.
- **Each person's own design library**, with thumbnails and search.
- **Version history:** every save is kept (default: the newest 50 per design). Restoring an old version
  adds it as a new version, so nothing is lost.
- **Safe saving:** if the same design was saved from another tab or computer meanwhile, you're asked
  before anything is overwritten.
- **SQLite by default** (nothing to set up) or **PostgreSQL**.
- **Admin tools:** add, disable, promote and remove users, reset passwords, all in the app or from the
  command line.
- **Hardened by default:** Argon2id passwords, HttpOnly SameSite cookies (Secure behind HTTPS),
  brute-force lockout, CSRF protection, a strict Content-Security-Policy, and isolated per-user storage.

## Install on Linux, bare metal or LXC (x86_64 or arm64)

The release has a static build for each architecture. It has no dependencies and runs on any
distribution, including Alpine. One line, as root or with sudo:

```bash
curl -fsSL https://raw.githubusercontent.com/anand34577/whittle/main/install.sh | sh -s -- --server
```

Or by hand:

```bash
# On the machine or inside the container (pick aarch64 for ARM64, x86_64 for Intel/AMD):
ARCH=$(uname -m)            # aarch64 or x86_64
VERSION=0.2.1
curl -LO https://github.com/anand34577/whittle/releases/download/v$VERSION/whittle-server-$VERSION-linux-$ARCH.tar.gz
tar xzf whittle-server-$VERSION-linux-$ARCH.tar.gz
cd whittle-server-$VERSION-linux-$ARCH
sudo ./deploy/install.sh
```

The installer creates a `whittle` system user, installs to `/opt/whittle`, keeps data in
`/var/lib/whittle`, writes settings to `/etc/whittle/whittle.env`, and starts a systemd (or OpenRC)
service. Open `http://<container-ip>:8080/` and create the first account: it becomes the administrator.

**Upgrading:** run the one-line command again, or download the new release and run `sudo ./deploy/install.sh`. Settings and data are
kept; the database upgrades itself on start.

### Proxmox LXC notes

- An **unprivileged** Debian 12 or Ubuntu 24.04 container works. 1 CPU, 512 MB RAM and a few GB of disk
  are plenty for a small team (designs are usually well under 1 MB each).
- The service runs without systemd sandboxing so it starts in unprivileged containers. If your container
  has nesting enabled (or you run on a VM), uncomment the `Protect*` lines in
  `/etc/systemd/system/whittle.service` for extra isolation.
- Back up `/var/lib/whittle` (and the database, if you use PostgreSQL). Proxmox backups of the container
  cover both.

## Docker

```bash
docker run -d --name whittle -p 8080:8080 -v whittle-data:/data ghcr.io/anand34577/whittle:latest
```

Images are published for `linux/amd64` and `linux/arm64`. Pass settings with `-e`, e.g.
`-e WHITTLE_AUTH=none`. A Compose file with an optional PostgreSQL service is in
[deploy/docker-compose.yml](https://github.com/anand34577/whittle/blob/main/deploy/docker-compose.yml).

## HTTPS (reverse proxy)

Run Whittle behind a reverse proxy that terminates TLS, and set `WHITTLE_PUBLIC_URL` to the public
address so cookies are marked Secure.

Caddy:

```
cad.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

nginx:

```nginx
server {
    server_name cad.example.com;
    client_max_body_size 64m;          # match WHITTLE_MAX_UPLOAD_MB
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $remote_addr;   # with WHITTLE_TRUST_PROXY=true
    }
}
```

Per-person data (preferences, AI assistant settings including provider keys, and crash-recovery drafts) is
kept in the database (`user_data` table), not in the browser, and is included in `whittle backup`. Provider
keys are stored as plain text like the SMTP password, so protect the database and backups accordingly.

## Settings

All settings are environment variables, kept in `/etc/whittle/whittle.env` by the installer. Restart
after changes: `sudo systemctl restart whittle`.

| Variable | Default | |
|---|---|---|
| `WHITTLE_BIND` | `0.0.0.0:8080` | Address and port to listen on (`PORT` also works). |
| `WHITTLE_WEB` | `apps/web/dist` | The built web app. |
| `WHITTLE_DATA` | `data` | Designs, thumbnails and the default SQLite database. |
| `WHITTLE_DATABASE_URL` | SQLite in `WHITTLE_DATA` | e.g. `postgres://user:pass@host:5432/whittle` |
| `WHITTLE_AUTH` | `local` | `local`, `oidc`, `local,oidc` or `none` |
| `WHITTLE_SIGNUP` | `false` | Let anyone create an account (the first account is always allowed). |
| `WHITTLE_PUBLIC_URL` | | Public address, e.g. `https://cad.example.com`. Required for OIDC. |
| `WHITTLE_SECURE_COOKIES` | on when the public URL is https | Force Secure cookies on or off. |
| `WHITTLE_MAX_UPLOAD_MB` | `64` | Largest design that can be saved. |
| `WHITTLE_MAX_VERSIONS` | `50` | Versions kept per design; older ones are pruned. |
| `WHITTLE_SESSION_DAYS` | `30` | How long a sign-in lasts. |
| `WHITTLE_AI` | `true` | Allow the in-app AI assistant. `false` hides it and keeps the strictest browser security policy. |
| `WHITTLE_TRUST_PROXY` | `false` | Set to `true` only behind a reverse proxy you control that sets `X-Forwarded-For`. Sign-in and password-reset limits then count each visitor's own address; without it they all share the proxy's address, so a few failed attempts lock everyone out. Never enable it when the server is reachable directly. |
| `WHITTLE_SETUP_TOKEN` | *(none)* | If set, whoever creates the first (administrator) account must enter this value, so a stranger who reaches a new server first can't claim it. |
| `WHITTLE_SMTP_HOST` | | Mail server for invitations, password resets and notices (see [Email](#email-smtp)). |
| `WHITTLE_SMTP_PORT` | by security: 587 / 465 / 25 | |
| `WHITTLE_SMTP_SECURITY` | `starttls` | `starttls`, `tls`, `starttls-optional` or `none` (plain, unencrypted). |
| `WHITTLE_SMTP_USERNAME`, `WHITTLE_SMTP_PASSWORD` | | Leave empty for servers without authentication. |
| `WHITTLE_SMTP_FROM`, `WHITTLE_SMTP_FROM_NAME` | `Whittle` | Sender address and name. |
| `WHITTLE_SMTP_ACCEPT_INVALID_CERTS` | `false` | Accept self-signed certificates (internal mail servers). |
| `RUST_LOG` | `info` | Log detail. |

Administrators can change sign-up, single sign-on behaviour and email **in the app** (Account →
Administration → Sign-in & email). What's saved there wins over the environment, which only gives the
starting values.

### Sign-in modes

- **`local`**: usernames and passwords stored on the server (Argon2id). The first account becomes the
  administrator; after that, administrators add people (or set `WHITTLE_SIGNUP=true`).
- **`oidc`**: single sign-on only. Accounts are **not** created automatically: an administrator adds each
  person (see below), or you set `WHITTLE_OIDC_AUTO_CREATE=true` to let anyone who can sign in at the
  provider create an account. The very first sign-in on a new server always creates the administrator.
- **`local,oidc`**: both buttons on the sign-in screen.
- **`none`**: no sign-in. Everyone who can reach the server shares one workspace. Use it only on a
  trusted network (a home LAN, behind a VPN, or behind a proxy that does its own authentication).

### Single sign-on (OpenID Connect)

Register Whittle with your identity provider as a **confidential web application** using the
authorization code flow, with this redirect URI:

```
https://cad.example.com/api/auth/oidc/callback
```

Then set:

```bash
WHITTLE_AUTH=local,oidc            # or just oidc
WHITTLE_PUBLIC_URL=https://cad.example.com
WHITTLE_OIDC_ISSUER=https://auth.example.com/application/o/whittle/
WHITTLE_OIDC_CLIENT_ID=whittle
WHITTLE_OIDC_CLIENT_SECRET=...
WHITTLE_OIDC_NAME=Authentik        # label on the sign-in button
```

Issuer examples: Authentik `https://auth.example.com/application/o/<slug>/` · Keycloak
`https://kc.example.com/realms/<realm>` · Authelia `https://auth.example.com` · Google
`https://accounts.google.com` · Microsoft Entra `https://login.microsoftonline.com/<tenant>/v2.0`.

Accounts are invited one by one by default (**Create accounts on first sign-in** is off; turn it on, or
set `WHITTLE_OIDC_AUTO_CREATE=true`, to open it up). Add each person in **Administration →
People** with the email address they sign in with and no password. Their first single sign-on (with a
provider-verified email) is linked to that account.

Whittle uses PKCE and a nonce, verifies the ID token signature, and matches accounts by issuer and
subject. Email is used to *link* an identity to an account only in the cases below, and only when the
provider says the email is verified.

#### Linking existing accounts to single sign-on

Turning on single sign-on for a server that already has password accounts? Pick one:

- **People link it themselves.** Signed in with their password, anyone can open **Account → Link
  single sign-on**. Their account and designs stay as they are; from then on either sign-in works.
- **An administrator flags the account.** In **Administration → People**, choose **Link single sign-on
  by email** on someone's menu. The next time they sign in with single sign-on using that (verified)
  email, it joins their existing account.
- **Link everyone by verified email.** Turn on **Link to existing accounts by verified email** in
  *Sign-in & email*. Only do this if you trust your provider's email verification.

#### Merging accounts

If someone already ended up with two accounts (for example a single sign-on account created on first
sign-in next to their old password account), choose **Merge into another account…** on one of them. The
account you keep takes over all designs and version history, the sign-in method it lacked (password or
single sign-on identity), the email if it had none, and administrator rights if either had them. The
other account is removed. Merges, links and unlinks are recorded in **Activity**.

### PostgreSQL

```sql
CREATE USER whittle WITH PASSWORD 'change-me';
CREATE DATABASE whittle OWNER whittle;
```

```bash
WHITTLE_DATABASE_URL=postgres://whittle:change-me@localhost:5432/whittle
```

Tables are created and upgraded automatically. Design files stay in `WHITTLE_DATA` either way, so back
up both.

## Administration

Administrators open **Account → Administration** (or search for it with Ctrl+K):

- **Overview**: version, uptime, database, people, active sessions, designs and storage.
- **People**: search and filter; add people with a password, as single sign-on only, or by **emailing an
  invitation** to choose their own password. Each person's menu can edit name, username and email, set
  a password or email a reset link, link or unlink single sign-on, merge accounts, sign them out
  everywhere, disable, or delete (deleting can **give their designs to someone else** instead of
  deleting them). The last active administrator is always protected.
- **Sign-in & email**: open or close sign-up, require email addresses, single sign-on behaviour, the
  SMTP server (with **Send test**), and which notifications are sent.
- **Activity**: an audit log of sign-ups, account changes, merges, settings changes, lockouts and
  failed emails.

## Email (SMTP)

Email is optional. With it, people can reset forgotten passwords, administrators can send invitations
and reset links, and Whittle sends notices (welcome, password changed, account disabled, new sign-ups to
administrators).

Set it in **Administration → Sign-in & email** (or with the `WHITTLE_SMTP_*` variables). Security modes:

| Mode | Port | When |
|---|---|---|
| STARTTLS (required) | 587 | Most providers (Gmail, Microsoft 365, Fastmail, Postmark, SES...) |
| TLS / SSL | 465 | Providers that use implicit TLS ("SMTPS") |
| STARTTLS if offered | 587 / 25 | Mixed internal servers: encrypts when possible |
| **None (unencrypted)** | 25 | A local relay (Postfix on the same host), a LAN mail server, test servers such as MailHog or Mailpit. Messages and any SMTP password travel unencrypted, so use it only on a trusted network. |

Internal servers with self-signed certificates: turn on **Accept self-signed certificates**. Links in
emails use `WHITTLE_PUBLIC_URL`. "Forgot password?" is only offered when it is set, because otherwise the link would be built from the
request's `Host` header, which the person asking controls. (Emails an administrator triggers, such as
invitations, fall back to the address the administrator is browsing.)

## Managing accounts from the command line

The installer adds a `whittle-server` command that runs as the `whittle` user with the service's settings:

```bash
sudo whittle-server user list
sudo whittle-server user add ada --email ada@example.com --admin
sudo whittle-server user passwd ada
sudo whittle-server user email ada ada@example.com
sudo whittle-server user admin ada on
sudo whittle-server doctor        # check settings, database, data folder, email and single sign-on
```

With Docker: `docker exec -it whittle whittle-server user list`.

Passwords are read from `WHITTLE_PASSWORD` or the first line of standard input. Locked out of the only
administrator account? `user passwd` and `user admin` fix it.

## Upgrading and uninstalling

Run the installer again to upgrade (`curl -fsSL .../install.sh | sh -s -- --server`, or
`sudo ./deploy/install.sh` from a release). It:

1. backs up everything first, to `/var/lib/whittle/backups/pre-upgrade-<version>-<date>.zip` (the five
   newest are kept);
2. installs the new version and restarts the service;
3. checks that the server answers. **If the new version doesn't start, the previous one is put back
   automatically**;
4. runs `whittle-server doctor`.

Database upgrades are automatic and forward-only. To remove the server:

```bash
sudo /opt/whittle/uninstall.sh            # keeps /var/lib/whittle and /etc/whittle
sudo /opt/whittle/uninstall.sh --purge    # also deletes all data and settings (asks first)
# or: curl -fsSL .../install.sh | sh -s -- --server --uninstall [--purge]
```

## Backups, restore and moving to PostgreSQL

```bash
sudo whittle-server backup /root/whittle-2026-10-15.zip     # safe while the server runs
sudo whittle-server restore /root/whittle-2026-10-15.zip    # into an empty server
sudo whittle-server restore backup.zip --force              # replace everything
sudo whittle-server migrate-db postgres://whittle:pw@db/whittle   # copy to PostgreSQL, then switch WHITTLE_DATABASE_URL
```

A backup is one ZIP with the accounts, settings, design list and audit log (as database-neutral JSON
lines) and every design file, so a backup from SQLite restores into PostgreSQL and the other way round.
Moving to a new machine: install there, then `restore` the backup. Sessions aren't kept: people sign in
again.

Storage layout:

```
/var/lib/whittle/
  whittle.db                     SQLite database (accounts, settings, design list, audit log)
  designs/<id>/v<n>.whittle      every kept version of every design
  designs/<id>/thumb.png         latest thumbnail
  backups/                       automatic pre-upgrade backups
```

`.whittle` files are ordinary ZIP files with a `document.json`, so they open in the desktop app too.

## API

Everything the app does goes through a small JSON API under `/api` (state-changing requests need the
`X-Whittle: 1` header): `GET /api/config`, `POST /api/auth/login|logout|register|password`,
`GET /api/auth/me`, `GET|POST /api/designs`, `GET|PUT|DELETE /api/designs/{id}` (PUT accepts
`If-Match: <version>`), `GET /api/designs/{id}/versions`, `GET /api/designs/{id}/versions/{n}`,
`POST /api/designs/{id}/versions/{n}/restore`, `GET /api/designs/{id}/thumbnail`, `GET /api/health`.

Accounts: `GET|PATCH /api/auth/me`, `POST /api/auth/forgot`, `POST /api/auth/reset`,
`GET /api/auth/oidc/start?link=1` (link single sign-on to the signed-in account).

Administration (administrators only): `GET /api/admin/overview`, `GET /api/admin/audit`,
`GET|PUT /api/admin/settings`, `POST /api/admin/settings/test-email`, `GET|POST /api/admin/users`,
`PATCH|DELETE /api/admin/users/{id}` (`?transferTo=<id>` keeps their designs), and
`POST /api/admin/users/{id}/merge|unlink-sso|signout|send-reset`.
