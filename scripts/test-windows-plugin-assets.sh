#!/usr/bin/env bash
# Verify the Windows plugin/version-pin contract:
#   - the Makefile pins every Windows plugin version and exposes fetch targets;
#   - the real attachment builder packages every plugin plus a .sha256 sidecar;
#   - a missing plugin binary fails the build instead of emitting a partial set;
#   - the design doc records the pins and the mongodb omission.
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
build_script="$repo_root/dist/build-edge-attachments.sh"
makefile="$repo_root/Makefile"
design_doc="$repo_root/docs/design/windows-edge-installation.md"
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT

fail() {
    printf 'windows plugin assets test failed: %s\n' "$*" >&2
    exit 1
}

require_file_text() {
    local file=$1 needle=$2 label=$3
    grep -Fq "$needle" "$file" || fail "$label: missing '$needle' in $file"
}

# 1. Version pins and fetch targets.
require_file_text "$makefile" 'WINDOWS_EXPORTER_VERSION ?= 0.29.2' "windows_exporter pin"
require_file_text "$makefile" 'MYSQLD_EXPORTER_VERSION ?= 0.19.0' "mysqld_exporter pin"
require_file_text "$makefile" 'POSTGRES_EXPORTER_VERSION ?= 0.19.1' "postgres_exporter pin"
require_file_text "$makefile" 'REDIS_EXPORTER_VERSION ?= 1.86.0' "redis_exporter pin"
require_file_text "$makefile" 'OTELCOL_VERSION ?= 0.157.0' "otelcol pin"
for target in fetch-windows-exporter fetch-otelcol-windows fetch-db-exporters-windows \
    fetch-mysqld-exporter-windows fetch-postgres-exporter-windows fetch-redis-exporter-windows; do
    grep -Eq "^${target}:" "$makefile" || fail "Makefile target $target is missing"
done
if grep -Eq '^fetch-mongodb-exporter-windows:' "$makefile"; then
    fail "Makefile must not fetch mongodb_exporter for Windows (no upstream asset)"
fi

# 2. The design doc must record the pins and the capability decision.
require_file_text "$design_doc" 'WINDOWS_EXPORTER_VERSION=0.29.2' "design doc windows_exporter pin"
require_file_text "$design_doc" 'windows_exporter-0.29.2-amd64.exe' "design doc windows_exporter asset"
require_file_text "$design_doc" 'otelcol-contrib_0.157.0_windows_amd64.tar.gz' "design doc otelcol asset"
require_file_text "$design_doc" 'mongodb' "design doc mongodb omission"
require_file_text "$design_doc" 'windows/<plugin>-windows-amd64.exe' "design doc flat plugin staging"
require_file_text "$design_doc" 'legacy-windows-amd64' "design doc legacy tag"

# 3. Real builder with fake fixture binaries.
version=vtest
bin_root="$tmp_dir/bin"
mkdir -p "$bin_root/windows-amd64"
plugins=(windows_exporter otelcol-contrib mysqld_exporter postgres_exporter redis_exporter)
printf 'supervisor payload\n' > "$bin_root/windows-amd64/ongrid-edge-supervisor.exe"
printf 'worker payload\n' > "$bin_root/windows-amd64/ongrid-edge-worker.exe"
printf 'installer payload\n' > "$bin_root/windows-amd64/ongrid-edge-installer.exe"
for plugin in "${plugins[@]}"; do
    printf '%s fixture\n' "$plugin" > "$bin_root/windows-amd64/$plugin.exe"
done

out="$tmp_dir/out"
EDGE_BIN_ROOT="$bin_root" \
    bash "$build_script" edge "$version" "$out" windows-amd64 >/dev/null

for artifact in supervisor worker installer "${plugins[@]}"; do
    file="$out/ongrid-edge-windows-amd64-$version-$artifact.exe"
    [[ -s "$file" ]] || fail "missing attachment $(basename "$file")"
    [[ -s "$file.sha256" ]] || fail "missing sidecar $(basename "$file").sha256"
    (cd "$out" && sha256sum -c "$(basename "$file").sha256" >/dev/null) \
        || fail "sidecar did not verify for $(basename "$file")"
done
for plugin in "${plugins[@]}"; do
    cmp -s "$bin_root/windows-amd64/$plugin.exe" \
        "$out/ongrid-edge-windows-amd64-$version-$plugin.exe" \
        || fail "$plugin attachment does not match its fixture"
done
[[ ! -e "$out/ongrid-edge-windows-amd64-$version-mongodb_exporter.exe" ]] \
    || fail "mongodb_exporter must not be packaged for Windows"

# 4. A missing plugin binary must fail loudly.
rm "$bin_root/windows-amd64/windows_exporter.exe"
if output=$(EDGE_BIN_ROOT="$bin_root" \
    bash "$build_script" edge "$version" "$tmp_dir/missing" windows-amd64 2>&1); then
    fail "missing windows_exporter input was accepted"
fi
grep -Fq 'missing' <<<"$output" \
    || fail "missing plugin did not produce an actionable error: $output"
grep -Fq 'windows_exporter.exe' <<<"$output" \
    || fail "missing-plugin error did not name the absent binary: $output"

printf 'windows plugin asset tests passed\n'
