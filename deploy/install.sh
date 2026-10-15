#!/bin/sh
# Install or upgrade the Whittle server from this extracted release folder.
#   sudo ./deploy/install.sh
# Works on Debian, Ubuntu and other systemd distros, and on Alpine (OpenRC),
# including inside LXC containers. Re-run it to upgrade; settings and data are kept.
#
# Upgrades are safe: the data is backed up first (into /var/lib/whittle/backups),
# and if the new version doesn't start, the previous one is put back.
# Remove with: sudo /opt/whittle/uninstall.sh [--purge]
set -eu

HERE=$(cd "$(dirname "$0")/.." && pwd)
PREFIX=/opt/whittle
DATA=/var/lib/whittle
CONF=/etc/whittle

if [ "$(id -u)" != 0 ]; then
  echo "Run this as root (sudo ./deploy/install.sh)." >&2
  exit 1
fi
if [ ! -x "$HERE/whittle-server" ]; then
  echo "whittle-server not found next to deploy/. Run this from an extracted release." >&2
  exit 1
fi
if ! "$HERE/whittle-server" --version >/dev/null 2>&1; then
  echo "This whittle-server doesn't run on this machine ($(uname -m)). Download the matching release." >&2
  exit 1
fi

echo "- Creating the whittle user and folders"
if ! id whittle >/dev/null 2>&1; then
  if command -v useradd >/dev/null 2>&1; then
    useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin whittle
  else
    addgroup -S whittle 2>/dev/null || true
    adduser -S -D -H -h "$DATA" -s /sbin/nologin -G whittle whittle
  fi
fi
mkdir -p "$PREFIX" "$DATA" "$CONF"
chown whittle:whittle "$DATA"
chmod 750 "$DATA"

RESTART=0
if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet whittle 2>/dev/null; then RESTART=1; fi

UPGRADE=0
OLD=""
if [ -x "$PREFIX/whittle-server" ]; then
  UPGRADE=1
  OLD=$("$PREFIX/whittle-server" --version 2>/dev/null | cut -d' ' -f2)
  NEW=$("$HERE/whittle-server" --version | cut -d' ' -f2)
  echo "- Upgrading Whittle ${OLD:-?} to $NEW"
  # Back up first. Newer servers do it themselves (accounts, settings, designs);
  # older ones get a copy of the data folder.
  mkdir -p "$DATA/backups"
  chown whittle:whittle "$DATA/backups"
  STAMP=$(date +%Y%m%d-%H%M%S)
  if "$PREFIX/whittle-server" --help 2>/dev/null | grep -q "backup FILE"; then
    if /usr/local/bin/whittle-server backup "$DATA/backups/pre-upgrade-$OLD-$STAMP.zip" >/dev/null; then
      echo "- Backed up to $DATA/backups/pre-upgrade-$OLD-$STAMP.zip"
    else
      echo "  (backup failed; continuing with a copy of the data folder)"
      tar czf "$DATA/backups/pre-upgrade-$OLD-$STAMP.tar.gz" -C "$DATA" --exclude=./backups . 2>/dev/null || true
    fi
  else
    tar czf "$DATA/backups/pre-upgrade-${OLD:-old}-$STAMP.tar.gz" -C "$DATA" --exclude=./backups . 2>/dev/null &&
      echo "- Backed up the data folder to $DATA/backups/pre-upgrade-${OLD:-old}-$STAMP.tar.gz"
  fi
  # Keep the five newest pre-upgrade backups.
  ls -1t "$DATA"/backups/pre-upgrade-* 2>/dev/null | tail -n +6 | xargs -r rm -f
  # Keep the current version for a rollback.
  rm -rf "$PREFIX/previous"
  mkdir -p "$PREFIX/previous"
  cp -p "$PREFIX/whittle-server" "$PREFIX/previous/whittle-server"
  [ -d "$PREFIX/web" ] && cp -r "$PREFIX/web" "$PREFIX/previous/web"
fi

echo "- Installing to $PREFIX"
install -m 755 "$HERE/whittle-server" "$PREFIX/whittle-server.new"
mv "$PREFIX/whittle-server.new" "$PREFIX/whittle-server"
rm -rf "$PREFIX/web.new"
cp -r "$HERE/web" "$PREFIX/web.new"
rm -rf "$PREFIX/web"
mv "$PREFIX/web.new" "$PREFIX/web"
[ -f "$HERE/README.md" ] && cp "$HERE/README.md" "$PREFIX/README.md"
install -m 755 "$HERE/deploy/uninstall.sh" "$PREFIX/uninstall.sh"

# Command-line wrapper: runs as the whittle user with the service's settings,
# so "sudo whittle-server user list" works from anywhere.
cat > /usr/local/bin/whittle-server <<'WRAPPER'
#!/bin/sh
set -a; . /etc/whittle/whittle.env; set +a
if [ "$(id -u)" = 0 ]; then exec su -s /bin/sh whittle -c 'exec /opt/whittle/whittle-server "$@"' whittle-server "$@"; fi
exec /opt/whittle/whittle-server "$@"
WRAPPER
chmod 755 /usr/local/bin/whittle-server

if [ ! -f "$CONF/whittle.env" ]; then
  echo "- Writing default settings to $CONF/whittle.env"
  install -m 640 "$HERE/deploy/whittle.env.example" "$CONF/whittle.env"
  chown root:whittle "$CONF/whittle.env"
else
  echo "- Keeping your settings in $CONF/whittle.env"
fi

SVC=""
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  install -m 644 "$HERE/deploy/whittle.service" /etc/systemd/system/whittle.service
  systemctl daemon-reload
  if [ "$RESTART" = 1 ]; then systemctl restart whittle; else systemctl enable --now whittle; fi
  SVC="systemctl status whittle   |   journalctl -u whittle -f"
elif command -v rc-service >/dev/null 2>&1; then
  install -m 755 "$HERE/deploy/whittle.openrc" /etc/init.d/whittle
  rc-update add whittle default >/dev/null
  rc-service whittle restart
  SVC="rc-service whittle status   |   tail -f /var/log/whittle.log"
else
  echo "No systemd or OpenRC found. Start it yourself, as the whittle user, with the settings in $CONF/whittle.env:"
  echo "  $PREFIX/whittle-server"
fi

PORT=$(sed -n 's/^WHITTLE_BIND=.*://p' "$CONF/whittle.env" | head -n1)
ADDR=$(hostname -I 2>/dev/null | cut -d' ' -f1)

# Wait until the server answers; after a failed upgrade, put the previous version back.
healthy() {
  i=0
  while [ $i -lt 30 ]; do
    if command -v curl >/dev/null 2>&1; then curl -fsS "http://127.0.0.1:${PORT:-8080}/api/health" >/dev/null 2>&1 && return 0
    elif command -v wget >/dev/null 2>&1; then wget -qO- "http://127.0.0.1:${PORT:-8080}/api/health" >/dev/null 2>&1 && return 0
    else return 0; fi
    i=$((i + 1)); sleep 1
  done
  return 1
}
restart_service() {
  if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then systemctl restart whittle
  elif command -v rc-service >/dev/null 2>&1; then rc-service whittle restart; fi
}
if [ -n "$SVC" ] && ! healthy; then
  if [ "$UPGRADE" = 1 ] && [ -x "$PREFIX/previous/whittle-server" ]; then
    echo "The new version didn't start. Putting Whittle $OLD back..." >&2
    cp -p "$PREFIX/previous/whittle-server" "$PREFIX/whittle-server"
    rm -rf "$PREFIX/web"; cp -r "$PREFIX/previous/web" "$PREFIX/web"
    restart_service
    if healthy; then echo "Whittle $OLD is running again. Nothing was lost; the backup is in $DATA/backups." >&2
    else echo "Whittle still doesn't start. Check: $SVC" >&2; fi
    exit 1
  fi
  echo "Whittle didn't answer on port ${PORT:-8080} yet. Check: $SVC" >&2
fi

echo
echo "- Checking the installation"
/usr/local/bin/whittle-server doctor 2>/dev/null | sed 's/^/    /' || true
echo
echo "Whittle $("$PREFIX/whittle-server" --version | cut -d' ' -f2) is installed."
echo "  Open      http://${ADDR:-localhost}:${PORT:-8080}/   (the first account you create becomes the administrator)"
echo "  Settings  $CONF/whittle.env   (restart the service after changes)"
echo "  Data      $DATA   (back this folder up; with PostgreSQL, back up the database too)"
[ -n "$SVC" ] && echo "  Service   $SVC"
echo "  Accounts  sudo whittle-server user list   (also: user add NAME --email E --admin, user passwd NAME)"
echo "  Backups   sudo whittle-server backup /path/whittle.zip   (restore: whittle-server restore FILE.zip)"
echo "  Remove    sudo $PREFIX/uninstall.sh   (keeps your data; --purge deletes it too)"
exit 0
