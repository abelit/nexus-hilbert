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

(cd "$out" && sha256sum -c \
    "$(basename "$supervisor").sha256" "$(basename "$worker").sha256") >/dev/null \
    || fail "attachment sidecars did not verify"

# Both inputs are required. A missing worker must fail instead of emitting a
# partial Windows release.
rm "$bin_root/windows-amd64/ongrid-edge-worker.exe"
if EDGE_BIN_ROOT="$bin_root" \
    bash "$build_script" edge "$version" "$tmp_dir/missing" windows-amd64 >/dev/null 2>&1; then
    fail "missing worker input was accepted"
fi

printf 'windows attachment tests passed\n'
