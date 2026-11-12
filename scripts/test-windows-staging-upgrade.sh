#!/usr/bin/env bash
# Hermetic test for Windows Edge artifact persistence in install.sh / upgrade.sh.
#
# The Manager serves Windows installers from /edge/windows/. Unlike the Linux
# targets, Windows artifacts are never part of the edge bundle: they must reach
# fetch-edge-assets.sh, must never reach build-edge-bundle.sh, and a Linux-only
# upgrade must not delete an existing windows/ tree.
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
lib="$repo_root/deploy/install/edge/edge-assets-lib.sh"
install_script="$repo_root/deploy/install/install.sh"
upgrade_script="$repo_root/deploy/install/upgrade.sh"
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT

fail() {
    printf 'windows staging upgrade test failed: %s\n' "$*" >&2
    exit 1
}

[[ -f "$lib" ]] || fail "missing edge-assets-lib.sh"
# shellcheck source=deploy/install/edge/edge-assets-lib.sh
source "$lib"

# --- target selection -------------------------------------------------------
[[ "$(ongrid_normalize_windows_edge_targets windows-amd64)" == windows-amd64 ]] \
    || fail "windows-amd64 was not accepted by the Windows target validator"
[[ -z "$(ongrid_normalize_windows_edge_targets '')" ]] \
    || fail "an empty Windows target selection was not normalized to none"
if ongrid_normalize_windows_edge_targets linux-amd64 >/dev/null 2>&1; then
    fail "the Windows target validator accepted a Linux target"
fi

# Default selection lives in .env.example and must resolve without any config.
[[ "$(ongrid_resolve_windows_edge_targets 0 '' /does/not/exist \
    "$repo_root/deploy/install/.env.example")" == windows-amd64 ]] \
    || fail ".env.example did not provide the default windows-amd64 target"

# An explicit empty value disables Windows staging, even when a package config
# or the template declares the default.
printf 'ONGRID_EDGE_TARGETS=linux-amd64\n' > "$tmp_dir/plain.env"
[[ -z "$(ongrid_resolve_windows_edge_targets 1 '' "$tmp_dir/plain.env")" ]] \
    || fail "an explicit empty ONGRID_WINDOWS_EDGE_TARGETS did not disable Windows staging"
printf 'ONGRID_WINDOWS_EDGE_TARGETS=windows-amd64\n' > "$tmp_dir/windows.env"
[[ "$(ongrid_resolve_windows_edge_targets 0 '' "$tmp_dir/windows.env")" == windows-amd64 ]] \
    || fail "a persisted Windows target selection was not preserved"

# --- user-facing errors -----------------------------------------------------
for script in "$install_script" "$upgrade_script"; do
    grep -Fq 'ONGRID_WINDOWS_EDGE_TARGETS accepts windows-amd64' "$script" \
        || fail "$(basename "$script") does not list windows-amd64 in its target error"
done

# --- install / upgrade wiring ----------------------------------------------
extract_prepare() {
    local script=$1 out=$2
    awk '/^prepare_edge_assets\(\) \{/{capture=1} capture{print} capture && /^}$/{exit}' \
        "$script" > "$out"
    [[ -s "$out" ]] || fail "could not extract prepare_edge_assets from $(basename "$script")"
}

extract_prepare "$install_script" "$tmp_dir/install-prepare.sh"
extract_prepare "$upgrade_script" "$tmp_dir/upgrade-prepare.sh"

make_package() {
    local package=$1
    mkdir -p "$package/edge"
    cp "$lib" "$package/edge/edge-assets-lib.sh"
    cat > "$package/edge/fetch-edge-assets.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
{
    printf 'fetch'
    printf ' %s' "$@"
    printf '\n'
} >> "$CALL_LOG"
dest=$1
for target in "${@:3}"; do
    if [[ "$target" == windows-amd64 ]]; then
        mkdir -p "$dest/windows/modern-amd64"
        printf 'new supervisor\n' > "$dest/windows/modern-amd64/ongrid-edge-supervisor.exe"
        printf 'new worker\n' > "$dest/windows/modern-amd64/ongrid-edge-worker.exe"
    fi
done
EOF
    cat > "$package/edge/build-edge-bundle.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'build %s\n' "$*" >> "$CALL_LOG"
printf 'bundle\n' > "$1/edge-bundle-$3-$2.tar.gz"
EOF
    chmod 0755 "$package/edge/fetch-edge-assets.sh" "$package/edge/build-edge-bundle.sh"
    printf 'ONGRID_EDGE_DEPS_TAG=edge-deps-test\nONGRID_EDGE_TARGETS=linux-amd64\n' \
        > "$package/edge/edge-artifacts.env"
    printf 'ONGRID_WINDOWS_EDGE_TARGETS=windows-amd64\n' > "$package/.env.example"
}

# Windows selection modes: unset -> template default; explicit -> caller value.
run_prepare() {
    local prepare=$1 package=$2 install_dir=$3 mode=$4 value=$5 log=$6 stage_out=$7
    set +e
    (
        set -e
        SCRIPT_DIR="$package"
        INSTALL_DIR="$install_dir"
        EDGE_ASSET_VERSION=vtest
        NEW_VERSION=vtest
        CALL_LOG="$log"
        export CALL_LOG
        case "$mode" in
            unset) unset ONGRID_WINDOWS_EDGE_TARGETS ;;
            explicit) export ONGRID_WINDOWS_EDGE_TARGETS="$value" ;;
            *) exit 64 ;;
        esac
        log_info()  { :; }
        log_warn()  { :; }
        log_error() { printf '%s\n' "$*" >&2; }
        ongrid_with_shared_asset_umask() { "$@"; }
        source "$prepare"
        prepare_edge_assets
        printf '%s\n' "$EDGE_STAGE_DIR" > "$stage_out"
    ) >"$tmp_dir/run.log" 2>&1
    local rc=$?
    set -e
    if [[ $rc -ne 0 ]]; then
        cat "$tmp_dir/run.log" >&2
        fail "prepare_edge_assets failed for $(basename "$prepare") ($mode)"
    fi
    [[ -s "$stage_out" ]] || fail "prepare_edge_assets did not expose a staging directory"
}

for prepare in "$tmp_dir/install-prepare.sh" "$tmp_dir/upgrade-prepare.sh"; do
    label=$(basename "$prepare" .sh)
    package="$tmp_dir/package-$label"
    install_dir="$tmp_dir/install-$label"
    log="$tmp_dir/$label-calls.log"
    stage_out="$tmp_dir/$label-stage.txt"
    make_package "$package"
    mkdir -p "$install_dir"
    : > "$log"

    run_prepare "$prepare" "$package" "$install_dir" unset '' "$log" "$stage_out"
    stage=$(cat "$stage_out")

    grep -Eq '^fetch .*windows-amd64' "$log" \
        || fail "$label did not pass windows-amd64 to fetch-edge-assets.sh"
    if grep -q '^build .*windows-amd64' "$log"; then
        fail "$label passed windows-amd64 to the Linux-only bundle builder"
    fi
    grep -Eq '^build ' "$log" || fail "$label did not build the Linux bundle"
    [[ -f "$stage/windows/modern-amd64/ongrid-edge-supervisor.exe" ]] \
        || fail "$label did not stage windows/modern-amd64"
    grep -Fxq 'ONGRID_WINDOWS_EDGE_TARGETS=windows-amd64' "$stage/edge-artifacts.env" \
        || fail "$label did not persist the Windows target selection"
done

# A Linux-only upgrade must preserve the served windows/ tree across the swap.
package="$tmp_dir/package-upgrade-prepare"
install_dir="$tmp_dir/install-preserve"
log="$tmp_dir/preserve-calls.log"
stage_out="$tmp_dir/preserve-stage.txt"
make_package "$package"
mkdir -p "$install_dir/edge/windows/modern-amd64"
printf 'old supervisor\n' > "$install_dir/edge/windows/modern-amd64/ongrid-edge-supervisor.exe"
printf 'old worker\n' > "$install_dir/edge/windows/modern-amd64/ongrid-edge-worker.exe"
: > "$log"

run_prepare "$tmp_dir/upgrade-prepare.sh" "$package" "$install_dir" explicit '' "$log" "$stage_out"
stage=$(cat "$stage_out")

if grep -q '^fetch .*windows-amd64' "$log"; then
    fail "a Linux-only upgrade still fetched Windows artifacts"
fi
if grep -q '^build .*windows-amd64' "$log"; then
    fail "a Linux-only upgrade passed windows-amd64 to the bundle builder"
fi
cmp -s "$install_dir/edge/windows/modern-amd64/ongrid-edge-supervisor.exe" \
    "$stage/windows/modern-amd64/ongrid-edge-supervisor.exe" \
    || fail "the Linux-only upgrade stage did not preserve the existing Windows supervisor"
grep -Fxq 'ONGRID_WINDOWS_EDGE_TARGETS=' "$stage/edge-artifacts.env" \
    || fail "the Linux-only upgrade did not persist the disabled Windows selection"

# Simulate upgrade.sh's atomic swap: the prepared tree replaces the served one.
backup="$tmp_dir/preserve-backup"
mkdir -p "$backup"
mv "$install_dir/edge" "$backup/edge"
mv "$stage" "$install_dir/edge"
cmp -s "$install_dir/edge/windows/modern-amd64/ongrid-edge-supervisor.exe" \
    <(printf 'old supervisor\n') \
    || fail "the upgrade swap deleted the served windows/ tree"

printf 'windows staging upgrade tests passed\n'
