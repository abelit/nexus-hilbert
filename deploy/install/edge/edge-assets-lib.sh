#!/usr/bin/env bash
# Shared target-selection and embedded-asset validation for Manager installers.

ongrid_edge_config_value() {
    local file=$1 key=$2
    [[ -f "$file" ]] || return 1
    sed -n "s/^${key}=//p" "$file" | tail -n 1
}

# Distinguish a deliberately blank setting (disabled) from an absent key.
ongrid_edge_config_has_key() {
    local file=$1 key=$2
    [[ -f "$file" ]] && grep -q "^${key}=" "$file"
}

ongrid_detect_host_edge_target() {
    local arch=${1:-}
    [[ -n "$arch" ]] || arch=$(uname -m)
    case "$arch" in
        x86_64|amd64) printf '%s\n' linux-amd64 ;;
        aarch64|arm64) printf '%s\n' linux-arm64 ;;
        *)
            printf '[ERROR] unsupported host architecture: %s\n' "$arch" >&2
            return 1
            ;;
    esac
}

ongrid_normalize_edge_targets() {
    local raw=${1:-linux-amd64} target normalized=""
    local targets=()
    read -r -a targets <<<"$raw"
    (( ${#targets[@]} > 0 )) || targets=(linux-amd64)
    for target in "${targets[@]}"; do
        case "$target" in
            linux-amd64|linux-arm64|windows-amd64) ;;
            *) return 1 ;;
        esac
        case " $normalized " in
            *" $target "*) ;;
            *) normalized="${normalized:+$normalized }$target" ;;
        esac
    done
    printf '%s\n' "$normalized"
}

ongrid_edge_targets_from_directory() {
    local edge_dir=$1 file target targets=""
    [[ -d "$edge_dir" ]] || return 1
    for file in "$edge_dir"/ongrid-edge-linux-*; do
        [[ -f "$file" ]] || continue
        target=${file##*/ongrid-edge-}
        case "$target" in
            linux-amd64|linux-arm64)
                targets="${targets:+$targets }$target"
                ;;
        esac
    done
    [[ -n "$targets" ]] || return 1
    ongrid_normalize_edge_targets "$targets"
}

ongrid_resolve_edge_targets() {
    local explicit=$1 package_config=$2 installed_config=$3 existing_edge_dir=$4 raw=""
    if [[ -n "$explicit" ]]; then
        raw=$explicit
    else
        # The current package declares the artifacts required by its manager
        # version and must supersede an older generated selection. Operators
        # can still deliberately narrow it with the explicit environment var.
        raw=$(ongrid_edge_config_value "$package_config" ONGRID_EDGE_TARGETS 2>/dev/null || true)
        if [[ -z "$raw" ]]; then
            raw=$(ongrid_edge_config_value "$installed_config" ONGRID_EDGE_TARGETS 2>/dev/null || true)
        fi
        if [[ -z "$raw" ]]; then
            raw=$(ongrid_edge_targets_from_directory "$existing_edge_dir" 2>/dev/null || true)
        fi
    fi
    if [[ -z "$raw" ]]; then
        raw=$(ongrid_detect_host_edge_target) || return 1
    fi
    ongrid_normalize_edge_targets "$raw"
}

# Windows artifacts are staged separately and never enter a Linux Edge bundle.
# Only windows-amd64 is supported; an empty selection disables Windows staging.
ongrid_normalize_windows_edge_targets() {
    local raw=${1:-} target normalized=""
    local targets=()
    [[ -n "$raw" ]] || { printf '\n'; return 0; }
    read -r -a targets <<<"$raw"
    for target in "${targets[@]}"; do
        case "$target" in
            windows-amd64) ;;
            *) return 1 ;;
        esac
        case " $normalized " in
            *" $target "*) ;;
            *) normalized="${normalized:+$normalized }$target" ;;
        esac
    done
    printf '%s\n' "$normalized"
}

# Resolve the Windows selection. The first argument says whether the environment
# variable is set (1) or absent (0), so an explicit empty value can disable
# Windows staging instead of falling back to the default. When no argument is
# set, the first config file that declares the key wins, including an empty
# value; otherwise the selection defaults to windows-amd64.
ongrid_resolve_windows_edge_targets() {
    local explicit_is_set=$1 explicit=$2 raw="" found=0 file
    shift 2
    if (( explicit_is_set )); then
        raw=$explicit
    else
        for file in "$@"; do
            if ongrid_edge_config_has_key "$file" ONGRID_WINDOWS_EDGE_TARGETS; then
                raw=$(ongrid_edge_config_value "$file" ONGRID_WINDOWS_EDGE_TARGETS)
                found=1
                break
            fi
        done
        (( found )) || raw=windows-amd64
    fi
    ongrid_normalize_windows_edge_targets "$raw"
}

ongrid_write_edge_artifact_config() {
    local file=$1 deps_tag=$2 targets=$3 windows_targets=${4-} tmp
    tmp=$(mktemp "${file}.XXXXXX") || return 1
    {
        [[ -z "$deps_tag" ]] || printf 'ONGRID_EDGE_DEPS_TAG=%s\n' "$deps_tag"
        printf 'ONGRID_EDGE_TARGETS=%s\n' "$targets"
        # Persist the Windows selection (including "disabled") so the next
        # upgrade inherits the operator's choice.
        printf 'ONGRID_WINDOWS_EDGE_TARGETS=%s\n' "$windows_targets"
    } > "$tmp"
    chmod 0644 "$tmp"
    mv "$tmp" "$file"
}

# Carry the last served Windows tree into a new staging directory when the new
# package/fetch did not produce one. This keeps a Linux-only upgrade from
# deleting installers that the Manager still serves under /edge/windows/.
ongrid_preserve_windows_edge_assets() {
    local stage_dir=$1 installed_edge_dir=$2
    [[ -d "$installed_edge_dir/windows" ]] || return 0
    if [[ -d "$stage_dir/windows" ]]; then
        return 0
    fi
    mkdir -p "$stage_dir/windows" || return 1
    cp -a "$installed_edge_dir/windows/." "$stage_dir/windows/"
}

ongrid_validate_embedded_edge_assets() {
    local edge_dir=$1 raw_targets=$2 target component
    local targets=() components=(
        ongrid-edge node_exporter process_exporter mysqld_exporter postgres_exporter
        redis_exporter mongodb_exporter otelcol-contrib obi obi.NOTICES
    )
    local windows_files=(
        ongrid-edge-supervisor-windows-amd64.exe
        ongrid-edge-worker-windows-amd64.exe
        ongrid-edge-supervisor-legacy-windows-amd64.exe
        ongrid-edge-worker-legacy-windows-amd64.exe
        windows_exporter-windows-amd64.exe
        otelcol-contrib-windows-amd64.exe
        mysqld_exporter-windows-amd64.exe
        postgres_exporter-windows-amd64.exe
        redis_exporter-windows-amd64.exe
    )
    if [[ -n "$raw_targets" ]]; then
        read -r -a targets <<<"$raw_targets"
    fi
    for target in "${targets[@]}"; do
        case "$target" in
            windows-amd64)
                for component in "${windows_files[@]}"; do
                    [[ -f "$edge_dir/windows/${component}" \
                        && ! -L "$edge_dir/windows/${component}" \
                        && -s "$edge_dir/windows/${component}" ]] || {
                        printf '[ERROR] embedded Edge package is missing regular file %s\n' \
                            "windows/${component}" >&2
                        return 1
                    }
                done
                ;;
            *)
                for component in "${components[@]}"; do
                    [[ -f "$edge_dir/${component}-${target}" \
                        && ! -L "$edge_dir/${component}-${target}" \
                        && -s "$edge_dir/${component}-${target}" ]] || {
                        printf '[ERROR] embedded Edge package is missing regular file %s-%s\n' \
                            "$component" "$target" >&2
                        return 1
                    }
                done
                ;;
        esac
    done
}
