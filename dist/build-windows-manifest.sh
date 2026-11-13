#!/usr/bin/env bash
# Generate the Windows Edge installer manifest from a staged artifact tree.
#
# Usage: dist/build-windows-manifest.sh <windows-dir> <version>
#
# <windows-dir> is the directory served as /edge/windows/. It uses the same
# flat `<component>-<os>-<arch>[-variant].exe` naming as the Linux payloads:
#
#   ongrid-edge-supervisor-windows-amd64.exe
#   ongrid-edge-worker-windows-amd64.exe
#   windows_exporter-windows-amd64.exe
#   otelcol-contrib-windows-amd64.exe
#   mysqld_exporter-windows-amd64.exe
#   postgres_exporter-windows-amd64.exe
#   redis_exporter-windows-amd64.exe
#   ongrid-edge-supervisor-legacy-windows-amd64.exe
#   ongrid-edge-worker-legacy-windows-amd64.exe
#
# manifest.json (schema 1) lists each file once per variant. `install_as` is
# the canonical filename the installer writes into `bin/` or `plugins/`; the
# flat distribution name carries the OS/arch (and legacy) tag instead.
#
# Variants are emitted windows-amd64 then legacy-windows-amd64, and files are
# emitted in a fixed order, so an unchanged tree re-publishes byte-identical
# JSON. A missing or non-regular required artifact fails without replacing an
# existing manifest.
set -euo pipefail

usage() {
    echo "usage: $(basename "$0") <windows-dir> <version>" >&2
    exit 2
}

if [[ $# -ne 2 || -z "${1:-}" || -z "${2:-}" ]]; then
    usage
fi

windows_dir=${1%/}
version=$2

die() { echo "build-windows-manifest: $*" >&2; exit 1; }

[[ "$version" =~ ^[0-9A-Za-z][0-9A-Za-z._-]*$ ]] || die "invalid version: $version"
[[ -d "$windows_dir" ]] || die "windows directory not found: $windows_dir"
command -v sha256sum >/dev/null 2>&1 || die "sha256sum is required"

# Variant order and minimum OS versions are part of the installer contract
# (see tools/windows-installer/manifest.go).
variants=(windows-amd64 legacy-windows-amd64)
modern_major=10 modern_minor=0 modern_build=14393
legacy_major=6 legacy_minor=1 legacy_build=7601

# Plugins are shared by both variants: the legacy build only replaces the
# supervisor and worker. mongodb_exporter is absent because upstream
# publishes no Windows amd64 asset.
plugin_files=(
    windows_exporter otelcol-contrib mysqld_exporter postgres_exporter redis_exporter
)

is_regular_file() {
    [[ -f "$1" && ! -L "$1" && -s "$1" ]]
}

# Required flat files per variant, as "path:dest:install_as".
modern_files=(
    "ongrid-edge-supervisor-windows-amd64.exe:bin:ongrid-edge-supervisor.exe"
    "ongrid-edge-worker-windows-amd64.exe:bin:ongrid-edge-worker.exe"
    "windows_exporter-windows-amd64.exe:plugins:windows_exporter.exe"
    "otelcol-contrib-windows-amd64.exe:plugins:otelcol-contrib.exe"
    "mysqld_exporter-windows-amd64.exe:plugins:mysqld_exporter.exe"
    "postgres_exporter-windows-amd64.exe:plugins:postgres_exporter.exe"
    "redis_exporter-windows-amd64.exe:plugins:redis_exporter.exe"
)
legacy_files=(
    "ongrid-edge-supervisor-legacy-windows-amd64.exe:bin:ongrid-edge-supervisor.exe"
    "ongrid-edge-worker-legacy-windows-amd64.exe:bin:ongrid-edge-worker.exe"
    "windows_exporter-windows-amd64.exe:plugins:windows_exporter.exe"
    "otelcol-contrib-windows-amd64.exe:plugins:otelcol-contrib.exe"
    "mysqld_exporter-windows-amd64.exe:plugins:mysqld_exporter.exe"
    "postgres_exporter-windows-amd64.exe:plugins:postgres_exporter.exe"
    "redis_exporter-windows-amd64.exe:plugins:redis_exporter.exe"
)

for name in "${plugin_files[@]}"; do
    is_regular_file "$windows_dir/${name}-windows-amd64.exe" \
        || die "missing required artifact: ${name}-windows-amd64.exe"
done
for variant in "${variants[@]}"; do
    case "$variant" in
        windows-amd64) files=("${modern_files[@]}") ;;
        legacy-windows-amd64) files=("${legacy_files[@]}") ;;
        *) die "unknown variant: $variant" ;;
    esac
    for entry in "${files[@]}"; do
        IFS=: read -r path _dest _install_as <<<"$entry"
        is_regular_file "$windows_dir/$path" \
            || die "missing required artifact: $path"
    done
done

manifest="$windows_dir/manifest.json"
tmp_manifest=$(mktemp "$windows_dir/.manifest.XXXXXX")
trap 'rm -f "$tmp_manifest"' EXIT

min_os_for() {
    case "$1" in
        windows-amd64) printf '%d %d %d' "$modern_major" "$modern_minor" "$modern_build" ;;
        legacy-windows-amd64) printf '%d %d %d' "$legacy_major" "$legacy_minor" "$legacy_build" ;;
        *) die "unknown variant: $1" ;;
    esac
}

{
    printf '{\n'
    printf '  "schema": 1,\n'
    printf '  "version": "%s",\n' "$version"
    printf '  "variants": [\n'
    variant_index=0
    for variant in "${variants[@]}"; do
        read -r major minor build <<<"$(min_os_for "$variant")"
        case "$variant" in
            windows-amd64) files=("${modern_files[@]}") ;;
            legacy-windows-amd64) files=("${legacy_files[@]}") ;;
        esac
        printf '    {\n'
        printf '      "id": "%s",\n' "$variant"
        printf '      "min_os": {"major": %d, "minor": %d, "build": %d},\n' \
            "$major" "$minor" "$build"
        printf '      "files": [\n'

        file_index=0
        last_index=$(( ${#files[@]} - 1 ))
        for entry in "${files[@]}"; do
            IFS=: read -r path dest install_as <<<"$entry"
            [[ "$path" =~ ^[A-Za-z0-9._-]+$ ]] \
                || die "unsupported file name in $variant: $path"
            [[ "$install_as" =~ ^[A-Za-z0-9._-]+$ ]] \
                || die "unsupported install_as in $variant: $install_as"
            digest=$(sha256sum "$windows_dir/$path" | awk '{print $1}')
            if (( file_index == last_index )); then
                comma=""
            else
                comma=","
            fi
            printf '        {"path": "%s", "sha256": "%s", "dest": "%s", "install_as": "%s"}%s\n' \
                "$path" "$digest" "$dest" "$install_as" "$comma"
            file_index=$((file_index + 1))
        done

        printf '      ]\n'
        printf '    }%s\n' "$([[ $variant_index -eq $(( ${#variants[@]} - 1 )) ]] && echo '' || echo ',')"
        variant_index=$((variant_index + 1))
    done
    printf '  ]\n'
    printf '}\n'
} > "$tmp_manifest"

mv -f "$tmp_manifest" "$manifest"
trap - EXIT
# mktemp creates 0600; nginx runs as a different user and must be able to
# serve the manifest from the read-only /edge/windows/ route.
chmod 0644 "$manifest"
echo "wrote $manifest"
