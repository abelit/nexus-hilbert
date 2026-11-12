#!/usr/bin/env bash
# Generate the Windows Edge installer manifest from a staged artifact tree.
#
# Usage: dist/build-windows-manifest.sh <windows-dir> <version>
#
# <windows-dir> is the directory served as /edge/windows/; it must contain
# modern-amd64/ and legacy-amd64/ trees with supervisor, worker, and the
# bundled plugin binaries. Every regular file below a variant directory is
# listed, hashed, and mapped to an install destination:
#
#   <variant>/ongrid-edge-*.exe  -> bin
#   <variant>/plugins/*.exe      -> plugins
#
# The resulting manifest.json is schema 1 and is consumed by
# tools/windows-installer, which resolves each entry as
# /edge/windows/<variant>/<path>. Output is deterministic: variants are
# emitted modern then legacy, and file paths are sorted bytewise, so an
# unchanged tree re-publishes byte-identical JSON.
#
# A missing or non-regular required artifact fails without replacing an
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
variants=(modern-amd64 legacy-amd64)
modern_major=10 modern_minor=0 modern_build=14393
legacy_major=6 legacy_minor=1 legacy_build=7601

# Both variants carry the same runtime payload. mongodb_exporter is absent
# because upstream publishes no Windows amd64 asset.
required_root=(ongrid-edge-supervisor.exe ongrid-edge-worker.exe)
required_plugins=(
    windows_exporter.exe otelcol-contrib.exe mysqld_exporter.exe
    postgres_exporter.exe redis_exporter.exe
)

is_regular_file() {
    [[ -f "$1" && ! -L "$1" && -s "$1" ]]
}

for variant in "${variants[@]}"; do
    variant_dir="$windows_dir/$variant"
    [[ -d "$variant_dir" ]] || die "missing variant directory: $variant_dir"
    for name in "${required_root[@]}"; do
        is_regular_file "$variant_dir/$name" \
            || die "missing required artifact: $variant/$name"
    done
    for name in "${required_plugins[@]}"; do
        is_regular_file "$variant_dir/plugins/$name" \
            || die "missing required artifact: $variant/plugins/$name"
    done
done

manifest="$windows_dir/manifest.json"
tmp_manifest=$(mktemp "$windows_dir/.manifest.XXXXXX")
trap 'rm -f "$tmp_manifest"' EXIT

min_os_for() {
    case "$1" in
        modern-amd64) printf '%d %d %d' "$modern_major" "$modern_minor" "$modern_build" ;;
        legacy-amd64) printf '%d %d %d' "$legacy_major" "$legacy_minor" "$legacy_build" ;;
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
        variant_dir="$windows_dir/$variant"
        printf '    {\n'
        printf '      "id": "%s",\n' "$variant"
        printf '      "min_os": {"major": %d, "minor": %d, "build": %d},\n' \
            "$major" "$minor" "$build"
        printf '      "files": [\n'

        mapfile -t paths < <(
            cd "$variant_dir"
            find . -type f -print | LC_ALL=C sort | sed 's|^\./||'
        )
        file_index=0
        last_index=$(( ${#paths[@]} - 1 ))
        for path in "${paths[@]}"; do
            # Manifest paths become URLs and later Win32 paths. Restrict them
            # to the canonical relative form the installer validates, instead
            # of trying to JSON-escape arbitrary filesystem names.
            [[ "$path" =~ ^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$ ]] \
                || die "unsupported file name in $variant: $path"
            case "$path" in
                /*|*/../*|../*|*/..|..) die "unsafe path in $variant: $path" ;;
            esac
            if [[ "$path" == plugins/* ]]; then
                dest=plugins
            else
                dest=bin
            fi
            digest=$(sha256sum "$variant_dir/$path" | awk '{print $1}')
            if (( file_index == last_index )); then
                comma=""
            else
                comma=","
            fi
            printf '        {"path": "%s", "sha256": "%s", "dest": "%s"}%s\n' \
                "$path" "$digest" "$dest" "$comma"
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
echo "wrote $manifest"
