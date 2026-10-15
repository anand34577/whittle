#!/bin/sh
# Remove the Whittle server.
#   sudo /opt/whittle/uninstall.sh            keeps data, settings and backups
#   sudo /opt/whittle/uninstall.sh --purge    deletes them too (asks first)
set -eu

PREFIX=/opt/whittle
DATA=/var/lib/whittle
CONF=/etc/whittle
PURGE=0
YES=0
for a in "$@"; do
  case "$a" in
    --purge) PURGE=1 ;;
    --yes | -y) YES=1 ;;
    *) echo "Unknown option: $a (use --purge, --yes)" >&2; exit 1 ;;
  esac
done

if [ "$(id -u)" != 0 ]; then
  echo "Run this as root (sudo $0)." >&2
  exit 1
fi

if [ "$PURGE" = 1 ] && [ "$YES" = 0 ]; then
  printf 'This deletes every account, design and backup in %s, and the settings in %s. Type DELETE to continue: ' "$DATA" "$CONF"
  read -r answer < /dev/tty || answer=""
  [ "$answer" = DELETE ] || { echo "Nothing was removed."; exit 1; }
fi

echo "- Stopping the service"
if command -v systemctl >/dev/null 2>&1 && [ -f /etc/systemd/system/whittle.service ]; then
  systemctl disable --now whittle 2>/dev/null || true
  rm -f /etc/systemd/system/whittle.service
  systemctl daemon-reload
elif command -v rc-service >/dev/null 2>&1 && [ -f /etc/init.d/whittle ]; then
  rc-service whittle stop 2>/dev/null || true
  rc-update del whittle default 2>/dev/null || true
  rm -f /etc/init.d/whittle
fi

echo "- Removing the program"
rm -f /usr/local/bin/whittle-server
rm -rf "$PREFIX"

if [ "$PURGE" = 1 ]; then
  echo "- Deleting data and settings"
  rm -rf "$DATA" "$CONF"
  if id whittle >/dev/null 2>&1; then
    if command -v userdel >/dev/null 2>&1; then userdel whittle 2>/dev/null || true; else deluser whittle 2>/dev/null || true; fi
  fi
  echo "Whittle is removed, including its data. (A PostgreSQL database, if you used one, is left alone.)"
else
  echo "Whittle is removed. Your data is still in $DATA and your settings in $CONF:"
  echo "reinstall to pick them up again, or run this with --purge to delete them."
fi
