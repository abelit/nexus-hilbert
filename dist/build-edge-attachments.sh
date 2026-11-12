#!/usr/bin/env bash
# Build direct-download CNB Release attachments for Edge installation.

set -euo pipefail

MODE=${1:?usage: build-edge-attachments.sh <deps|edge> <tag-or-version> <out-dir> <target...>}
IDENTIFIER=${2:?tag or version}
OUT_DIR=${3:?output directory}
shift 3
(( $# > 0 )) || { echo "build-edge-attachments: at least one target is required" >&2; exit 2; }

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
BIN_ROOT=${EDGE_BIN_ROOT:-$REPO_ROOT/bin}

command -v sha256sum >/dev/null 2>&1 || { echo "sha256sum is required" >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { echo "tar is required" >&2; exit 1; }
command -v xz >/dev/null 2>&1 || { echo "xz is required" >&2; exit 1; }

deps=(
    node_exporter process_exporter mysqld_exporter postgres_exporter
    redis_exporter mongodb_exporter otelcol-contrib obi obi.NOTICES
)

# Windows plugin payloads are versioned (not part of the immutable Linux deps
# archive). mongodb_exporter is absent because percona publishes no Windows
# amd64 asset; the Windows databasemetrics capability omits the mongodb source.
windows_plugins=(
    windows_exporter otelcol-contrib mysqld_exporter postgres_exporter
    redis_exporter
)

mkdir -p "$OUT_DIR"
work=$(mktemp -d "${TMPDIR:-/tmp}/ongrid-edge-attachments.XXXXXX")
trap 'rm -rf "$work"' EXIT

write_sidecar() {
    local file=$1
    (cd "$(dirname "$file")" && sha256sum "$(basename "$file")" > "$(basename "$file").sha256")
}

for target in "$@"; do
    case "$target" in
        linux-amd64|linux-arm64|windows-amd64|legacy-windows-amd64) ;;
        *) echo "build-edge-attachments: unsupported target $target" >&2; exit 2 ;;
    esac

    case "$MODE" in
        deps)
            # Dependency archives are Linux-only payloads; Windows attaches its
            # own binaries through the edge mode below.
            case "$target" in
                linux-amd64|linux-arm64) ;;
                *) echo "build-edge-attachments: deps mode does not support $target" >&2; exit 2 ;;
            esac
            : "${OBI_VERSION:?OBI_VERSION is required}"
            : "${OTELCOL_VERSION:?OTELCOL_VERSION is required}"
            : "${NODE_EXPORTER_VERSION:?NODE_EXPORTER_VERSION is required}"
            : "${PROCESS_EXPORTER_VERSION:?PROCESS_EXPORTER_VERSION is required}"
            : "${MYSQLD_EXPORTER_VERSION:?MYSQLD_EXPORTER_VERSION is required}"
            : "${POSTGRES_EXPORTER_VERSION:?POSTGRES_EXPORTER_VERSION is required}"
            : "${REDIS_EXPORTER_VERSION:?REDIS_EXPORTER_VERSION is required}"
            : "${MONGODB_EXPORTER_VERSION:?MONGODB_EXPORTER_VERSION is required}"

            stage="$work/deps-$target"
            mkdir -p "$stage"
            for component in "${deps[@]}"; do
                src="$BIN_ROOT/$target/$component"
                [[ -s "$src" ]] || { echo "build-edge-attachments: missing $src" >&2; exit 1; }
                install -m 0755 "$src" "$stage/$component"
            done
            printf '%s\n' "$target" > "$stage/TARGET"
            cat > "$stage/DEPENDENCIES" <<EOF
layout=2
obi=${OBI_VERSION}
otelcol-contrib=${OTELCOL_VERSION}
node_exporter=${NODE_EXPORTER_VERSION}
process_exporter=${PROCESS_EXPORTER_VERSION}
mysqld_exporter=${MYSQLD_EXPORTER_VERSION}
postgres_exporter=${POSTGRES_EXPORTER_VERSION}
redis_exporter=${REDIS_EXPORTER_VERSION}
mongodb_exporter=${MONGODB_EXPORTER_VERSION}
release_tag=${IDENTIFIER}
EOF
            (cd "$stage" && sha256sum TARGET DEPENDENCIES "${deps[@]}" > MANIFEST.sha256)
            archive_files=(TARGET DEPENDENCIES MANIFEST.sha256 "${deps[@]}")
            chmod 0644 "$stage/TARGET" "$stage/DEPENDENCIES" "$stage/MANIFEST.sha256"
            TZ=UTC touch -t 200001010000.00 "${archive_files[@]/#/$stage/}"
            output="$OUT_DIR/edge-deps-${target}.tar.xz"
            if tar --version 2>/dev/null | grep -q 'GNU tar'; then
                tar --format=ustar --owner=0 --group=0 --numeric-owner \
                    -C "$stage" -cf - "${archive_files[@]}"
            else
                COPYFILE_DISABLE=1 tar --format ustar --uid 0 --gid 0 --uname root --gname root \
                    -C "$stage" -cf - "${archive_files[@]}"
            fi | xz -T0 --block-size=64MiB -9 -c > "$output"
            write_sidecar "$output"
            ;;
        edge)
            case "$target" in
                windows-amd64)
                    supervisor_src="$BIN_ROOT/$target/ongrid-edge-supervisor.exe"
                    worker_src="$BIN_ROOT/$target/ongrid-edge-worker.exe"
                    installer_src="$BIN_ROOT/$target/ongrid-edge-installer.exe"
                    [[ -s "$supervisor_src" ]] || { echo "build-edge-attachments: missing $supervisor_src" >&2; exit 1; }
                    [[ -s "$worker_src" ]] || { echo "build-edge-attachments: missing $worker_src" >&2; exit 1; }
                    [[ -s "$installer_src" ]] || { echo "build-edge-attachments: missing $installer_src" >&2; exit 1; }
                    supervisor_output="$OUT_DIR/ongrid-edge-${target}-${IDENTIFIER}-supervisor.exe"
                    worker_output="$OUT_DIR/ongrid-edge-${target}-${IDENTIFIER}-worker.exe"
                    installer_output="$OUT_DIR/ongrid-edge-${target}-${IDENTIFIER}-installer.exe"
                    install -m 0755 "$supervisor_src" "$supervisor_output"
                    install -m 0755 "$worker_src" "$worker_output"
                    install -m 0755 "$installer_src" "$installer_output"
                    write_sidecar "$supervisor_output"
                    write_sidecar "$worker_output"
                    write_sidecar "$installer_output"
                    outputs=("$supervisor_output" "$worker_output" "$installer_output")
                    # Every Windows plugin is mandatory: a release that omits
                    # one would register a plugin on the agent whose binary is
                    # never staged, leaving it permanently unhealthy.
                    for plugin in "${windows_plugins[@]}"; do
                        plugin_src="$BIN_ROOT/$target/$plugin.exe"
                        [[ -s "$plugin_src" ]] \
                            || { echo "build-edge-attachments: missing $plugin_src" >&2; exit 1; }
                        plugin_output="$OUT_DIR/ongrid-edge-${target}-${IDENTIFIER}-${plugin}.exe"
                        install -m 0755 "$plugin_src" "$plugin_output"
                        write_sidecar "$plugin_output"
                        outputs+=("$plugin_output")
                    done
                    output="${outputs[*]}"
                    ;;
                legacy-windows-amd64)
                    # Legacy 2008 R2 builds are produced by
                    # tools/build-legacy-windows.sh with Go 1.20. The plugin
                    # payload is shared with the modern variant, so only the
                    # supervisor/worker differ.
                    supervisor_src="$BIN_ROOT/$target/ongrid-edge-supervisor.exe"
                    worker_src="$BIN_ROOT/$target/ongrid-edge-worker.exe"
                    [[ -s "$supervisor_src" ]] || { echo "build-edge-attachments: missing $supervisor_src" >&2; exit 1; }
                    [[ -s "$worker_src" ]] || { echo "build-edge-attachments: missing $worker_src" >&2; exit 1; }
                    supervisor_output="$OUT_DIR/ongrid-edge-${target}-${IDENTIFIER}-supervisor.exe"
                    worker_output="$OUT_DIR/ongrid-edge-${target}-${IDENTIFIER}-worker.exe"
                    install -m 0755 "$supervisor_src" "$supervisor_output"
                    install -m 0755 "$worker_src" "$worker_output"
                    write_sidecar "$supervisor_output"
                    write_sidecar "$worker_output"
                    output="$supervisor_output $worker_output"
                    ;;
                *)
                    src="$BIN_ROOT/$target/ongrid-edge"
                    [[ -s "$src" ]] || { echo "build-edge-attachments: missing $src" >&2; exit 1; }
                    output="$OUT_DIR/ongrid-edge-${target}-${IDENTIFIER}"
                    install -m 0755 "$src" "$output"
                    write_sidecar "$output"
                    ;;
            esac
            ;;
        *)
            echo "build-edge-attachments: mode must be deps or edge" >&2
            exit 2
            ;;
    esac
    echo "built $output"
done
