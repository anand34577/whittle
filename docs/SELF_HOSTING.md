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
    }
}
```

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
| `RUST_LOG` | `info` | Log detail. |

### Sign-in modes

- **`local`**: usernames and passwords stored on the server (Argon2id). The first account becomes the
  administrator; after that, administrators add people (or set `WHITTLE_SIGNUP=true`).
- **`oidc`**: single sign-on only. Accounts are created the first time someone signs in (turn that off
  with `WHITTLE_OIDC_AUTO_CREATE=false`). The first account becomes the administrator.
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

To invite people one by one instead of creating accounts automatically, set
`WHITTLE_OIDC_AUTO_CREATE=false` and add each person in **Manage users** with the email address they sign in
with and no password. Their first single sign-on (with a provider-verified email) is linked to that account.

Whittle uses PKCE and a nonce, verifies the ID token signature, and matches accounts by issuer and
subject (never by email), so an email change at the provider can't take over another account.

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

## Managing accounts from the command line

The installer adds a `whittle-server` command that runs as the `whittle` user with the service's settings:

```bash
sudo whittle-server user list
sudo whittle-server user add ada --admin
sudo whittle-server user passwd ada
sudo whittle-server user admin ada on
```

With Docker: `docker exec -it whittle whittle-server user list`.

Passwords are read from `WHITTLE_PASSWORD` or the first line of standard input. Locked out of the only
administrator account? `user passwd` and `user admin` fix it.

## Backups and storage layout

```
/var/lib/whittle/
  whittle.db                     SQLite database (accounts, sessions, design list)
  designs/<id>/v<n>.whittle      every kept version of every design
  designs/<id>/thumb.png         latest thumbnail
```

`.whittle` files are ordinary ZIP files with a `document.json`, so they open in the desktop app too.

## API

Everything the app does goes through a small JSON API under `/api` (state-changing requests need the
`X-Whittle: 1` header): `GET /api/config`, `POST /api/auth/login|logout|register|password`,
`GET /api/auth/me`, `GET|POST /api/designs`, `GET|PUT|DELETE /api/designs/{id}` (PUT accepts
`If-Match: <version>`), `GET /api/designs/{id}/versions`, `GET /api/designs/{id}/versions/{n}`,
`POST /api/designs/{id}/versions/{n}/restore`, `GET /api/designs/{id}/thumbnail`, `/api/admin/users`,
`GET /api/health`.
