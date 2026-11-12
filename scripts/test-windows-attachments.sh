#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
build_script="$repo_root/dist/build-edge-attachments.sh"
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT

fail() {
    printf 'windows attachment test failed: %s\n' "$*" >&2
    exit 1
}

version=vtest
bin_root="$tmp_dir/bin"
mkdir -p "$bin_root/windows-amd64"
printf 'supervisor payload\n' > "$bin_root/windows-amd64/ongrid-edge-supervisor.exe"
printf 'worker payload\n' > "$bin_root/windows-amd64/ongrid-edge-worker.exe"
windows_plugins=(windows_exporter otelcol-contrib mysqld_exporter postgres_exporter redis_exporter)
for plugin in "${windows_plugins[@]}"; do
    printf '%s payload\n' "$plugin" > "$bin_root/windows-amd64/$plugin.exe"
done

out="$tmp_dir/out"
EDGE_BIN_ROOT="$bin_root" \
    bash "$build_script" edge "$version" "$out" windows-amd64

supervisor="$out/ongrid-edge-windows-amd64-$version-supervisor.exe"
worker="$out/ongrid-edge-windows-amd64-$version-worker.exe"
for file in "$supervisor" "$worker" "$supervisor.sha256" "$worker.sha256"; do
    [[ -f "$file" ]] || fail "missing $(basename "$file")"
done

cmp -s "$bin_root/windows-amd64/ongrid-edge-supervisor.exe" "$supervisor" \
    || fail "supervisor attachment does not match its input"
cmp -s "$bin_root/windows-amd64/ongrid-edge-worker.exe" "$worker" \
    || fail "worker attachment does not match its input"

for plugin in "${windows_plugins[@]}"; do
    plugin_file="$out/ongrid-edge-windows-amd64-$version-$plugin.exe"
    [[ -f "$plugin_file" ]] || fail "missing $(basename "$plugin_file")"
    [[ -f "$plugin_file.sha256" ]] || fail "missing $(basename "$plugin_file").sha256"
    cmp -s "$bin_root/windows-amd64/$plugin.exe" "$plugin_file" \
        || fail "$plugin attachment does not match its input"
done
[[ ! -e "$out/ongrid-edge-windows-amd64-$version-mongodb_exporter.exe" ]] \
    || fail "mongodb_exporter must not be packaged without a Windows upstream asset"

(cd "$out" && sha256sum -c \
    "$(basename "$supervisor").sha256" "$(basename "$worker").sha256" \
    ongrid-edge-windows-amd64-"$version"-*.exe.sha256) >/dev/null \
    || fail "attachment sidecars did not verify"

# Both inputs are required. A missing worker must fail instead of emitting a
# partial Windows release.
rm "$bin_root/windows-amd64/ongrid-edge-worker.exe"
if EDGE_BIN_ROOT="$bin_root" \
    bash "$build_script" edge "$version" "$tmp_dir/missing" windows-amd64 >/dev/null 2>&1; then
    fail "missing worker input was accepted"
fi

# Every plugin binary is required too.
printf 'worker payload\n' > "$bin_root/windows-amd64/ongrid-edge-worker.exe"
rm "$bin_root/windows-amd64/redis_exporter.exe"
if output=$(EDGE_BIN_ROOT="$bin_root" \
    bash "$build_script" edge "$version" "$tmp_dir/missing-plugin" windows-amd64 2>&1); then
    fail "missing plugin input was accepted"
fi
grep -Fq 'missing' <<<"$output" \
    || fail "missing plugin did not produce an actionable error"

printf 'windows attachment tests passed\n'
