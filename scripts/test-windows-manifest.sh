#!/usr/bin/env bash
# Verify the Windows installer manifest generator.
#
# The generator walks the staged windows/<variant>/ trees, hashes every file,
# and writes windows/manifest.json with the exact relative paths the installer
# turns into /edge/windows/<variant>/<path> URLs. The test builds a fixture
# layout, checks the v1 schema, deterministic ordering, digests, and the
# missing-file failure path.
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
generator="$repo_root/dist/build-windows-manifest.sh"
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT

fail() {
    printf 'windows manifest test failed: %s\n' "$*" >&2
    exit 1
}

make_variant() {
    local windows_dir=$1 variant=$2
    mkdir -p "$windows_dir/$variant/plugins"
    printf '%s supervisor\n' "$variant" > "$windows_dir/$variant/ongrid-edge-supervisor.exe"
    printf '%s worker\n' "$variant" > "$windows_dir/$variant/ongrid-edge-worker.exe"
    for plugin in windows_exporter otelcol-contrib mysqld_exporter postgres_exporter redis_exporter; do
        printf '%s %s plugin\n' "$variant" "$plugin" \
            > "$windows_dir/$variant/plugins/$plugin.exe"
    done
}

windows_dir="$tmp_dir/windows"
make_variant "$windows_dir" modern-amd64
make_variant "$windows_dir" legacy-amd64
# The installer bootstrap sits at the Windows root and is deliberately not a
# manifest file; the installer never downloads itself.
printf 'installer\n' > "$windows_dir/ongrid-edge-installer.exe"

bash "$generator" "$windows_dir" vtest || fail "manifest generation failed"

manifest="$windows_dir/manifest.json"
[[ -s "$manifest" ]] || fail "manifest.json was not written"
# nginx serves the manager directory as a non-root user.
[[ "$(stat -c '%a' "$manifest")" == "644" ]] \
    || fail "manifest.json is not world-readable (mode $(stat -c '%a' "$manifest"))"

python3 - "$manifest" "$windows_dir" <<'PY' || exit 1
import hashlib
import json
import pathlib
import sys

manifest_path = pathlib.Path(sys.argv[1])
windows_dir = pathlib.Path(sys.argv[2])
data = json.loads(manifest_path.read_text())

def fail(message):
    print(f"windows manifest test failed: {message}", file=sys.stderr)
    sys.exit(1)

if data.get("schema") != 1:
    fail(f"schema = {data.get('schema')!r}, want 1")
if data.get("version") != "vtest":
    fail(f"version = {data.get('version')!r}, want vtest")

variants = data.get("variants")
if not isinstance(variants, list) or [v.get("id") for v in variants] != [
    "modern-amd64",
    "legacy-amd64",
]:
    fail(f"variant order = {variants!r}")

expected_min_os = {
    "modern-amd64": {"major": 10, "minor": 0, "build": 14393},
    "legacy-amd64": {"major": 6, "minor": 1, "build": 7601},
}
plugins = [
    "mysqld_exporter",
    "otelcol-contrib",
    "postgres_exporter",
    "redis_exporter",
    "windows_exporter",
]
expected_paths = [
    "ongrid-edge-supervisor.exe",
    "ongrid-edge-worker.exe",
    *[f"plugins/{plugin}.exe" for plugin in plugins],
]

for variant in variants:
    variant_id = variant["id"]
    if variant.get("min_os") != expected_min_os[variant_id]:
        fail(f"{variant_id} min_os = {variant.get('min_os')!r}")
    files = variant.get("files")
    if not isinstance(files, list):
        fail(f"{variant_id} files is not a list")
    paths = [entry["path"] for entry in files]
    if paths != expected_paths:
        fail(f"{variant_id} paths = {paths!r}, want {expected_paths!r}")
    for entry in files:
        path = entry["path"]
        if path.startswith("/") or path.startswith("\\") or ".." in path.split("/"):
            fail(f"{variant_id} unsafe path {path!r}")
        expected_dest = "plugins" if path.startswith("plugins/") else "bin"
        if entry.get("dest") != expected_dest:
            fail(f"{variant_id} {path} dest = {entry.get('dest')!r}, want {expected_dest!r}")
        actual = hashlib.sha256((windows_dir / variant_id / path).read_bytes()).hexdigest()
        if entry.get("sha256") != actual:
            fail(f"{variant_id} {path} sha256 does not match its file")
PY

first=$(sha256sum "$manifest" | awk '{print $1}')

# Deterministic output: an unchanged tree must produce byte-identical JSON.
bash "$generator" "$windows_dir" vtest || fail "second manifest generation failed"
second=$(sha256sum "$manifest" | awk '{print $1}')
[[ "$first" == "$second" ]] || fail "manifest output is not deterministic"

# A required artifact missing from either variant must fail loudly instead of
# publishing a manifest the installer cannot satisfy.
broken="$tmp_dir/broken"
cp -a "$windows_dir" "$broken"
rm "$broken/legacy-amd64/plugins/redis_exporter.exe"
rm -f "$broken/manifest.json"
if output=$(bash "$generator" "$broken" vtest 2>&1); then
    fail "a missing legacy plugin was accepted"
fi
grep -Fq 'redis_exporter.exe' <<<"$output" \
    || fail "missing-file error did not name the absent artifact: $output"
[[ ! -e "$broken/manifest.json" ]] || fail "a failed run still wrote manifest.json"

printf 'windows manifest tests passed\n'
