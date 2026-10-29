#!/bin/sh
# Whittle installer for Linux and macOS.
#
#   Desktop app:  curl -fsSL https://raw.githubusercontent.com/anand34577/whittle/main/install.sh | sh
#   Server:       curl -fsSL https://raw.githubusercontent.com/anand34577/whittle/main/install.sh | sh -s -- --server
#
# Options (after "sh -s --"):
#   --server          install the self-hosted server (Linux, x86_64 or arm64) instead of the desktop app
#   --version 0.2.0   a specific release instead of the latest
#   --appimage        Linux desktop: use the AppImage even when a .deb or .rpm would fit
#   --upgrade         same as installing again: settings and data are kept (the server is backed up first)
#   --uninstall       remove the desktop app (your .whittle files are never touched)
#   --server --uninstall [--purge]
#                     remove the server; --purge also deletes its data, settings and backups
#
# Every download is checked against the release's SHA256SUMS.
set -eu

REPO=anand34577/whittle
MODE=desktop
VERSION=""
APPIMAGE=0
UNINSTALL=0
PURGE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --server) MODE=server ;;
    --upgrade) ;;
    --purge) PURGE=1 ;;
    --version) [ $# -ge 2 ] || { echo "--version needs a version, like --version 0.17.1" >&2; exit 1; }; VERSION="${2#v}"; shift ;;
    --version=*) VERSION="${1#--version=}"; VERSION="${VERSION#v}" ;;
    --appimage) APPIMAGE=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help) sed -n '2,14p' "$0" 2>/dev/null || echo "See https://github.com/$REPO/wiki/Installation"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required. Install it and run this again."; }

need curl
OS=$(uname -s)
ARCH=$(uname -m)
case "$ARCH" in
  x86_64|amd64) ARCH=x86_64 ;;
  aarch64|arm64) ARCH=aarch64 ;;
  *) die "Whittle has no build for $ARCH yet. You can build it from source: https://github.com/$REPO/wiki/Building-from-source" ;;
esac

SUDO=""
if [ "$(id -u)" != 0 ]; then
  if command -v sudo >/dev/null 2>&1; then SUDO=sudo; elif command -v doas >/dev/null 2>&1; then SUDO=doas; fi
fi
as_root() {
  if [ "$(id -u)" = 0 ]; then "$@"
  elif [ -n "$SUDO" ]; then $SUDO "$@"
  else die "This step needs root. Run it again as root, or install sudo."
  fi
}

# ---- uninstall (server) ----
if [ "$UNINSTALL" = 1 ] && [ "$MODE" = server ]; then
  [ -x /opt/whittle/uninstall.sh ] || die "No Whittle server is installed here (or it predates the uninstaller: stop the service and remove /opt/whittle)."
  if [ "$PURGE" = 1 ]; then as_root /opt/whittle/uninstall.sh --purge; else as_root /opt/whittle/uninstall.sh; fi
  exit 0
fi

# ---- uninstall (desktop) ----
if [ "$UNINSTALL" = 1 ]; then
  if [ "$OS" = Darwin ]; then
    for d in /Applications/Whittle.app "$HOME/Applications/Whittle.app"; do
      [ -d "$d" ] && { say "Removing $d"; rm -rf "$d" 2>/dev/null || as_root rm -rf "$d"; }
    done
  else
    if command -v dpkg >/dev/null 2>&1 && dpkg -s whittle >/dev/null 2>&1; then as_root apt-get remove -y whittle
    elif command -v rpm >/dev/null 2>&1 && rpm -q whittle >/dev/null 2>&1; then
      if command -v dnf >/dev/null 2>&1; then as_root dnf remove -y whittle; elif command -v zypper >/dev/null 2>&1; then as_root zypper -n remove whittle; else as_root rpm -e whittle; fi
    fi
    rm -f "$HOME/.local/bin/whittle" "$HOME/.local/bin/Whittle.AppImage" \
      "$HOME/.local/share/applications/whittle.desktop" "$HOME/.local/share/icons/hicolor/256x256/apps/whittle.png"
  fi
  say "Whittle is uninstalled. Your designs and settings were left in place."
  exit 0
fi

# ---- find the release ----
# The release's SHA256SUMS lists every file, so no GitHub API call (and no API rate limit) is needed.
if [ -n "$VERSION" ]; then BASE="https://github.com/$REPO/releases/download/v$VERSION"
else BASE="https://github.com/$REPO/releases/latest/download"; fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM

curl -fsSL --retry 3 -o "$TMP/SHA256SUMS" "$BASE/SHA256SUMS" ||
  die "Could not download release ${VERSION:-latest} from GitHub. Check your internet connection, or the version number."
FILES=$(sed 's/^[0-9a-f]* *\*\{0,1\}//' "$TMP/SHA256SUMS")
TAG=v$(printf '%s\n' "$FILES" | sed -n 's/^whittle-web-\(.*\)\.tar\.gz$/\1/p' | head -n1)

asset() { printf '%s\n' "$FILES" | grep -E "$1" | head -n1; }

fetch() { # file name -> $TMP/<name>, verified against SHA256SUMS
  name=$1
  say "Downloading $name"
  curl -fL --retry 3 --progress-bar -o "$TMP/$name" "$BASE/$name"
  want=$(grep " \*\{0,1\}$name\$" "$TMP/SHA256SUMS" | cut -d' ' -f1)
  if command -v sha256sum >/dev/null 2>&1; then got=$(sha256sum "$TMP/$name" | cut -d' ' -f1)
  else got=$(shasum -a 256 "$TMP/$name" | cut -d' ' -f1); fi
  [ "$got" = "$want" ] || die "Checksum mismatch for $name. The download may be damaged; try again."
  FILE="$TMP/$name"
}

# ---- server ----
if [ "$MODE" = server ]; then
  [ "$OS" = Linux ] || die "The server runs on Linux. On macOS or Windows use Docker: https://github.com/$REPO/wiki/Docker"
  url=$(asset "whittle-server-.*-linux-$ARCH\.tar\.gz\$")
  [ -n "$url" ] || die "Release $TAG has no server build for $ARCH."
  need tar
  fetch "$url"
  tar xzf "$FILE" -C "$TMP"
  dir=$(find "$TMP" -maxdepth 1 -type d -name 'whittle-server-*' | head -n1)
  # For testing an edited deploy/install.sh against a published build (the installers workflow does this).
  if [ -n "${WHITTLE_DEPLOY_SCRIPT:-}" ]; then cp "$WHITTLE_DEPLOY_SCRIPT" "$dir/deploy/install.sh"; fi
  as_root sh "$dir/deploy/install.sh"
  exit 0
fi

# ---- desktop: macOS ----
if [ "$OS" = Darwin ]; then
  url=$(asset '_universal\.dmg$')
  [ -n "$url" ] || url=$(asset '\.dmg$')
  [ -n "$url" ] || die "Release $TAG has no macOS build."
  fetch "$url"
  mnt="$TMP/mnt"; mkdir -p "$mnt"
  hdiutil attach -nobrowse -quiet -mountpoint "$mnt" "$FILE"
  dest=/Applications
  [ -w "$dest" ] || dest="$HOME/Applications"
  mkdir -p "$dest"
  rm -rf "$dest/Whittle.app"
  cp -R "$mnt/Whittle.app" "$dest/"
  hdiutil detach -quiet "$mnt" || true
  xattr -dr com.apple.quarantine "$dest/Whittle.app" 2>/dev/null || true
  say "Whittle $TAG is installed in $dest. Open it from Launchpad or Spotlight."
  exit 0
fi

[ "$OS" = Linux ] || die "Unsupported system: $OS. On Windows, run in PowerShell: irm https://raw.githubusercontent.com/$REPO/main/install.ps1 | iex"

# ---- desktop: Linux ----
if [ "$ARCH" = x86_64 ]; then DEB=amd64; RPM=x86_64; IMG=amd64; else DEB=arm64; RPM=aarch64; IMG=aarch64; fi

if [ "$APPIMAGE" = 0 ] && command -v apt-get >/dev/null 2>&1 && [ -n "$(asset "_$DEB\.deb\$")" ]; then
  fetch "$(asset "_$DEB\.deb\$")"
  chmod 644 "$FILE"; chmod 755 "$TMP"   # apt reads the file as the _apt user
  as_root apt-get update -qq || true
  as_root apt-get install -y "$FILE"
  say "Whittle $TAG is installed. Find it in your applications menu, or run: whittle-desktop"
  exit 0
fi
if [ "$APPIMAGE" = 0 ] && [ -n "$(asset "\.$RPM\.rpm\$")" ]; then
  for pm in dnf zypper yum; do
    if command -v $pm >/dev/null 2>&1; then
      fetch "$(asset "\.$RPM\.rpm\$")"
      if [ $pm = zypper ]; then as_root zypper -n install --allow-unsigned-rpm "$FILE"; else as_root $pm install -y "$FILE"; fi
      say "Whittle $TAG is installed. Find it in your applications menu, or run: whittle-desktop"
      exit 0
    fi
  done
fi

# Anything else: AppImage in ~/.local/bin, no root needed.
url=$(asset "_$IMG\.AppImage\$")
[ -n "$url" ] || die "Release $TAG has no Linux desktop build for $ARCH."
fetch "$url"
bin="$HOME/.local/bin"; apps="$HOME/.local/share/applications"; icons="$HOME/.local/share/icons/hicolor/256x256/apps"
mkdir -p "$bin" "$apps" "$icons"
install -m 755 "$FILE" "$bin/Whittle.AppImage"
ln -sf "$bin/Whittle.AppImage" "$bin/whittle"
curl -fsSL -o "$icons/whittle.png" "https://raw.githubusercontent.com/$REPO/$TAG/apps/desktop/src-tauri/icons/128x128@2x.png" || true
cat > "$apps/whittle.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Whittle
Comment=Parametric 3D CAD
Exec=$bin/Whittle.AppImage %f
Icon=whittle
Categories=Graphics;Engineering;3DGraphics;
MimeType=application/x-whittle;
Terminal=false
EOF
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$apps" 2>/dev/null || true
say "Whittle $TAG is installed. Find it in your applications menu, or run: whittle"
case ":$PATH:" in *":$bin:"*) ;; *) echo "Note: add $bin to your PATH to run 'whittle' from a terminal." ;; esac
if ! ldconfig -p 2>/dev/null | grep -q libfuse.so.2; then
  echo "Note: AppImages need FUSE 2. If Whittle doesn't start, install it (Debian/Ubuntu: sudo apt install libfuse2t64 or libfuse2)."
fi
