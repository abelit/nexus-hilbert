#!/usr/bin/env bash
# Verify the Windows installer manifest generator.
#
# The staged tree uses the flat `<component>-windows-amd64[-legacy]` naming
# shared with the Linux payloads. The generator hashes each file and writes
# windows/manifest.json with an `install_as` canonical name for each entry,
# which the installer uses as the destination filename under /edge/windows/.
# The test checks the schema, ordering, digests, install_as mapping, and the
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

make_layout() {
    local windows_dir=$1
    mkdir -p "$windows_dir"
    printf 'supervisor\n' > "$windows_dir/ongrid-edge-supervisor-windows-amd64.exe"
    printf 'worker\n' > "$windows_dir/ongrid-edge-worker-windows-amd64.exe"
    printf 'legacy supervisor\n' > "$windows_dir/ongrid-edge-supervisor-legacy-windows-amd64.exe"
    printf 'legacy worker\n' > "$windows_dir/ongrid-edge-worker-legacy-windows-amd64.exe"
    for plugin in windows_exporter otelcol-contrib mysqld_exporter postgres_exporter redis_exporter; do
        printf '%s plugin\n' "$plugin" > "$windows_dir/${plugin}-windows-amd64.exe"
    done
    # The installer bootstrap sits at the Windows root and is deliberately not
    # a manifest file; the installer never downloads itself.
    printf 'installer\n' > "$windows_dir/ongrid-edge-installer.exe"
}

windows_dir="$tmp_dir/windows"
make_layout "$windows_dir"

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
    "windows-amd64",
    "legacy-windows-amd64",
]:
    fail(f"variant order = {variants!r}")

expected_min_os = {
    "windows-amd64": {"major": 10, "minor": 0, "build": 14393},
    "legacy-windows-amd64": {"major": 6, "minor": 1, "build": 7601},
}
plugins = [
    "windows_exporter",
    "otelcol-contrib",
    "mysqld_exporter",
    "postgres_exporter",
    "redis_exporter",
]
variant_roots = {
    "windows-amd64": ("ongrid-edge-supervisor-windows-amd64.exe", "ongrid-edge-worker-windows-amd64.exe"),
    "legacy-windows-amd64": (
        "ongrid-edge-supervisor-legacy-windows-amd64.exe",
        "ongrid-edge-worker-legacy-windows-amd64.exe",
    ),
}
plugin_names = {
    "windows_exporter": "windows_exporter.exe",
    "otelcol-contrib": "otelcol-contrib.exe",
    "mysqld_exporter": "mysqld_exporter.exe",
    "postgres_exporter": "postgres_exporter.exe",
    "redis_exporter": "redis_exporter.exe",
}

for variant in variants:
    variant_id = variant["id"]
    if variant.get("min_os") != expected_min_os[variant_id]:
        fail(f"{variant_id} min_os = {variant.get('min_os')!r}")
    files = variant.get("files")
    if not isinstance(files, list):
        fail(f"{variant_id} files is not a list")
    supervisor, worker = variant_roots[variant_id]
    expected_paths = [supervisor, worker, *[f"{p}-windows-amd64.exe" for p in plugins]]
    paths = [entry["path"] for entry in files]
    if paths != expected_paths:
        fail(f"{variant_id} paths = {paths!r}, want {expected_paths!r}")

    expected_install = {
        supervisor: "ongrid-edge-supervisor.exe",
        worker: "ongrid-edge-worker.exe",
    }
    plugin_paths = set()
    for name in plugins:
        plugin_paths.add(f"{name}-windows-amd64.exe")
        expected_install[f"{name}-windows-amd64.exe"] = plugin_names[name]

    for entry in files:
        path = entry["path"]
        if "/" in path or "\\" in path or ".." in path:
            fail(f"{variant_id} unsafe path {path!r}")
        expected_dest = "plugins" if path in plugin_paths else "bin"
        if entry.get("dest") != expected_dest:
            fail(f"{variant_id} {path} dest = {entry.get('dest')!r}, want {expected_dest!r}")
        if entry.get("install_as") != expected_install[path]:
            fail(f"{variant_id} {path} install_as = {entry.get('install_as')!r}")
        actual = hashlib.sha256((windows_dir / path).read_bytes()).hexdigest()
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
rm "$broken/redis_exporter-windows-amd64.exe"
rm -f "$broken/manifest.json"
if output=$(bash "$generator" "$broken" vtest 2>&1); then
    fail "a missing shared plugin was accepted"
fi
grep -Fq 'redis_exporter-windows-amd64.exe' <<<"$output" \
    || fail "missing-file error did not name the absent artifact: $output"
[[ ! -e "$broken/manifest.json" ]] || fail "a failed run still wrote manifest.json"

printf 'windows manifest tests passed\n'
