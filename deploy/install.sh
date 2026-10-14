#!/bin/sh
# Install or upgrade the Whittle server from this extracted release folder.
#   sudo ./deploy/install.sh
# Works on Debian, Ubuntu and other systemd distros, and on Alpine (OpenRC),
# including inside LXC containers. Re-run it to upgrade; settings and data are kept.
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

echo "- Installing to $PREFIX"
install -m 755 "$HERE/whittle-server" "$PREFIX/whittle-server.new"
mv "$PREFIX/whittle-server.new" "$PREFIX/whittle-server"
rm -rf "$PREFIX/web.new"
cp -r "$HERE/web" "$PREFIX/web.new"
rm -rf "$PREFIX/web"
mv "$PREFIX/web.new" "$PREFIX/web"
[ -f "$HERE/README.md" ] && cp "$HERE/README.md" "$PREFIX/README.md"

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
echo
echo "Whittle $("$PREFIX/whittle-server" --version | cut -d' ' -f2) is installed."
echo "  Open      http://${ADDR:-localhost}:${PORT:-8080}/   (the first account you create becomes the administrator)"
echo "  Settings  $CONF/whittle.env   (restart the service after changes)"
echo "  Data      $DATA   (back this folder up; with PostgreSQL, back up the database too)"
[ -n "$SVC" ] && echo "  Service   $SVC"
echo "  Accounts  run 'whittle-server user --help' as the whittle user with the same settings"
exit 0
