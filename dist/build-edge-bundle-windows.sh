#!/usr/bin/env bash
# Build a Windows whole-package upgrade bundle for the Manager-driven
# fetch_package/apply_package flow.
#
# Usage: dist/build-edge-bundle-windows.sh <out-dir> <version> [variant]
#   variant: windows-amd64 (default) | legacy-windows-amd64
#
# Produces <out-dir>/edge-bundle-<variant>-<version>.tar.gz plus a pure-hash
# .sha256 sidecar (same format as the Linux builder).
#
# Bundle layout (tar root):
#   MANIFEST.txt
#   VERSION
#   ongrid-edge-supervisor.exe
#   ongrid-edge-worker.exe
#   <plugin>.exe
#
# MANIFEST.txt lines: `<sha256>  <mode>  <src>  <dest>`; dest may contain
# spaces (C:\Program Files\...), the edge parser joins the remaining fields.
set -euo pipefail

usage() {
    echo "usage: $(basename "$0") <out-dir> <version> [windows-amd64|legacy-windows-amd64]" >&2
    exit 2
}

[[ $# -ge 2 && $# -le 3 ]] || usage
OUT_DIR=${1%/}
VERSION=$2
VARIANT=${3:-windows-amd64}

case "$VARIANT" in
    windows-amd64) SRC_DIR="bin/windows-amd64" ;;
    legacy-windows-amd64) SRC_DIR="bin/legacy-windows-amd64" ;;
    *) echo "build-edge-bundle-windows: unsupported variant: $VARIANT" >&2; exit 2 ;;
esac

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PLUGIN_SRC="$ROOT/bin/windows-amd64"
SRC="$ROOT/$SRC_DIR"
INSTALL_ROOT='C:\Program Files\ongrid-edge'
PLUGINS=(windows_exporter otelcol-contrib mysqld_exporter postgres_exporter redis_exporter)

[[ "$VERSION" =~ ^[0-9A-Za-z][0-9A-Za-z._-]*$ ]] || { echo "invalid version: $VERSION" >&2; exit 2; }

die() { echo "build-edge-bundle-windows: $*" >&2; exit 1; }
command -v sha256sum >/dev/null 2>&1 || die "sha256sum is required"
command -v tar >/dev/null 2>&1 || die "tar is required"

is_regular() { [[ -f "$1" && ! -L "$1" && -s "$1" ]]; }

for name in ongrid-edge-supervisor.exe ongrid-edge-worker.exe; do
    is_regular "$SRC/$name" || die "missing $SRC_DIR/$name"
done
for plugin in "${PLUGINS[@]}"; do
    is_regular "$PLUGIN_SRC/$plugin.exe" || die "missing bin/windows-amd64/$plugin.exe"
done

work=$(mktemp -d "${TMPDIR:-/tmp}/edge-bundle-windows.XXXXXX")
trap 'rm -rf "$work"' EXIT

install -m 0755 "$SRC/ongrid-edge-supervisor.exe" "$work/ongrid-edge-supervisor.exe"
install -m 0755 "$SRC/ongrid-edge-worker.exe" "$work/ongrid-edge-worker.exe"
for plugin in "${PLUGINS[@]}"; do
    install -m 0755 "$PLUGIN_SRC/$plugin.exe" "$work/$plugin.exe"
done
printf '%s\n' "$VERSION" > "$work/VERSION"

manifest="$work/MANIFEST.txt"
{
    printf '# Windows Edge upgrade bundle\n'
    printf '# fields: sha256 mode src dest\n'
    for entry in \
        "ongrid-edge-supervisor.exe|${INSTALL_ROOT}\\bin\\ongrid-edge-supervisor.exe" \
        "ongrid-edge-worker.exe|${INSTALL_ROOT}\\bin\\ongrid-edge-worker.exe"
    do
        src=${entry%%|*}
        dest=${entry#*|}
        sha=$(sha256sum "$work/$src" | awk '{print $1}')
        printf '%s  0755  %s  %s\n' "$sha" "$src" "$dest"
    done
    for plugin in "${PLUGINS[@]}"; do
        src="$plugin.exe"
        dest="${INSTALL_ROOT}\\plugins\\$src"
        sha=$(sha256sum "$work/$src" | awk '{print $1}')
        printf '%s  0755  %s  %s\n' "$sha" "$src" "$dest"
    done
} > "$manifest"

mkdir -p "$OUT_DIR"
tarball="$OUT_DIR/edge-bundle-$VARIANT-$VERSION.tar.gz"
rm -f "$tarball" "$tarball.sha256"
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$tarball" -C "$work" . 2>/dev/null \
    || COPYFILE_DISABLE=1 tar -czf "$tarball" -C "$work" .
sha256sum "$tarball" | awk '{print $1}' > "$tarball.sha256"
chmod 0644 "$tarball" "$tarball.sha256"
echo "built $tarball ($(du -h "$tarball" | cut -f1))"
