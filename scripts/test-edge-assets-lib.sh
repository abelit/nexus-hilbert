#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck source=deploy/install/edge/edge-assets-lib.sh
source "$repo_root/deploy/install/edge/edge-assets-lib.sh"

tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT

fail() {
    printf 'edge target selection test failed: %s\n' "$*" >&2
    exit 1
}

mkdir -p "$tmp_dir/installed" "$tmp_dir/package" "$tmp_dir/existing"
printf 'ONGRID_EDGE_TARGETS=linux-amd64\n' \
    > "$tmp_dir/installed/edge-artifacts.env"
printf 'ONGRID_EDGE_TARGETS=linux-amd64 linux-arm64\n' \
    > "$tmp_dir/package/edge-artifacts.env"

resolved=$(ongrid_resolve_edge_targets "" \
    "$tmp_dir/package/edge-artifacts.env" \
    "$tmp_dir/installed/edge-artifacts.env" "$tmp_dir/existing")
[[ "$resolved" == 'linux-amd64 linux-arm64' ]] \
    || fail "a dual-architecture package did not supersede the old single-architecture selection"

resolved=$(ongrid_resolve_edge_targets linux-arm64 \
    "$tmp_dir/package/edge-artifacts.env" \
    "$tmp_dir/installed/edge-artifacts.env" "$tmp_dir/existing")
[[ "$resolved" == linux-arm64 ]] || fail "an explicit target did not override persisted state"

resolved=$(ongrid_resolve_edge_targets "" /does/not/exist \
    "$tmp_dir/installed/edge-artifacts.env" "$tmp_dir/existing")
[[ "$resolved" == linux-amd64 ]] \
    || fail "an installed selection was not preserved when the package had no target metadata"

: > "$tmp_dir/existing/ongrid-edge-linux-arm64"
: > "$tmp_dir/existing/ongrid-edge-linux-amd64"
resolved=$(ongrid_resolve_edge_targets "" /does/not/exist /does/not/exist "$tmp_dir/existing")
[[ "$resolved" == 'linux-amd64 linux-arm64' ]] \
    || fail "legacy installed binaries were not converted into a persistent target selection"

if ongrid_normalize_edge_targets 'linux-amd64 linux-ppc64le' >/dev/null; then
    fail "an unsupported Edge target was accepted"
fi

[[ "$(ongrid_normalize_edge_targets windows-amd64)" == windows-amd64 ]] \
    || fail "windows-amd64 was not accepted as a versioned Edge target"
[[ "$(ongrid_normalize_edge_targets 'linux-amd64 windows-amd64 linux-amd64')" \
    == 'linux-amd64 windows-amd64' ]] \
    || fail "windows targets were not normalized alongside linux targets"

[[ "$(ongrid_normalize_windows_edge_targets windows-amd64)" == windows-amd64 ]] \
    || fail "windows-amd64 was not accepted by the Windows target validator"
[[ -z "$(ongrid_normalize_windows_edge_targets '')" ]] \
    || fail "an empty Windows target selection was not normalized to none"
if ongrid_normalize_windows_edge_targets linux-amd64 >/dev/null 2>&1; then
    fail "the Windows target validator accepted a Linux target"
fi
if ongrid_normalize_windows_edge_targets 'windows-amd64 windows-amd64' \
    | grep -q 'windows-amd64 windows-amd64'; then
    fail "duplicate Windows targets were not collapsed"
fi

# The Windows selection defaults to windows-amd64, but a declared empty value
# disables staging and must survive the next upgrade.
[[ "$(ongrid_resolve_windows_edge_targets 0 '' /does/not/exist \
    "$repo_root/deploy/install/.env.example")" == windows-amd64 ]] \
    || fail ".env.example did not provide the default Windows target"
printf 'ONGRID_WINDOWS_EDGE_TARGETS=\n' > "$tmp_dir/windows-disabled.env"
[[ -z "$(ongrid_resolve_windows_edge_targets 0 '' "$tmp_dir/windows-disabled.env")" ]] \
    || fail "a persisted disabled Windows selection was not honored"
printf 'ONGRID_WINDOWS_EDGE_TARGETS=windows-amd64\n' > "$tmp_dir/windows-enabled.env"
[[ -z "$(ongrid_resolve_windows_edge_targets 1 '' "$tmp_dir/windows-enabled.env")" ]] \
    || fail "an explicit empty Windows selection did not override a persisted value"
[[ "$(ongrid_resolve_windows_edge_targets 0 '' "$tmp_dir/windows-enabled.env")" == windows-amd64 ]] \
    || fail "a persisted Windows selection was not resolved"
if ongrid_resolve_windows_edge_targets 1 linux-amd64 >/dev/null 2>&1; then
    fail "an unsupported Windows target was accepted"
fi

[[ "$(ongrid_detect_host_edge_target x86_64)" == linux-amd64 ]] \
    || fail "x86_64 host architecture was not mapped to linux-amd64"
[[ "$(ongrid_detect_host_edge_target aarch64)" == linux-arm64 ]] \
    || fail "aarch64 host architecture was not mapped to linux-arm64"
if ongrid_detect_host_edge_target ppc64le >/dev/null 2>&1; then
    fail "an unsupported host architecture was accepted"
fi

host_bin="$tmp_dir/host-bin"
mkdir -p "$host_bin"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" aarch64\n' > "$host_bin/uname"
chmod 0755 "$host_bin/uname"
resolved=$(PATH="$host_bin:$PATH" ongrid_resolve_edge_targets "" \
    /does/not/exist /does/not/exist "$tmp_dir/no-existing-assets")
[[ "$resolved" == linux-arm64 ]] \
    || fail "a fresh universal package did not select the host architecture"

ongrid_write_edge_artifact_config "$tmp_dir/written.env" edge-deps-test \
    'linux-amd64 linux-arm64' windows-amd64
grep -Fxq 'ONGRID_EDGE_DEPS_TAG=edge-deps-test' "$tmp_dir/written.env"
grep -Fxq 'ONGRID_EDGE_TARGETS=linux-amd64 linux-arm64' "$tmp_dir/written.env"
grep -Fxq 'ONGRID_WINDOWS_EDGE_TARGETS=windows-amd64' "$tmp_dir/written.env"

# A disabled selection must persist as a blank key, otherwise the next upgrade
# would re-enable the default.
ongrid_write_edge_artifact_config "$tmp_dir/written-disabled.env" "" linux-amd64 ""
grep -Fxq 'ONGRID_WINDOWS_EDGE_TARGETS=' "$tmp_dir/written-disabled.env" \
    || fail "a disabled Windows selection was not persisted"

embedded="$tmp_dir/embedded"
mkdir -p "$embedded"
components=(
    ongrid-edge node_exporter process_exporter mysqld_exporter postgres_exporter
    redis_exporter mongodb_exporter otelcol-contrib obi obi.NOTICES
)
for target in linux-amd64 linux-arm64; do
    for component in "${components[@]}"; do
        printf '%s %s\n' "$component" "$target" > "$embedded/${component}-${target}"
    done
done
ongrid_validate_embedded_edge_assets "$embedded" 'linux-amd64 linux-arm64' \
    || fail "a complete embedded dual-architecture package was rejected"
rm "$embedded/otelcol-contrib-linux-arm64"
if ongrid_validate_embedded_edge_assets "$embedded" 'linux-amd64 linux-arm64' \
    >/dev/null 2>&1; then
    fail "an incomplete embedded package was accepted"
fi

# Windows binaries live under windows/modern-amd64 and validate independently
# of the Linux component list.
mkdir -p "$embedded/windows/modern-amd64"
printf 'supervisor\n' > "$embedded/windows/modern-amd64/ongrid-edge-supervisor.exe"
printf 'worker\n' > "$embedded/windows/modern-amd64/ongrid-edge-worker.exe"
ongrid_validate_embedded_edge_assets "$embedded" windows-amd64 \
    || fail "a complete embedded Windows payload was rejected"
ongrid_validate_embedded_edge_assets "$embedded" 'linux-amd64 windows-amd64' \
    || fail "a mixed Linux/Windows embedded payload was rejected"
rm "$embedded/windows/modern-amd64/ongrid-edge-worker.exe"
if ongrid_validate_embedded_edge_assets "$embedded" windows-amd64 >/dev/null 2>&1; then
    fail "an incomplete embedded Windows payload was accepted"
fi
ongrid_validate_embedded_edge_assets "$embedded" linux-amd64 \
    || fail "Windows validation broke the existing Linux check"

# Preserve the served Windows tree when the new stage did not produce one.
preserve_stage="$tmp_dir/preserve-stage"
preserve_installed="$tmp_dir/preserve-installed"
mkdir -p "$preserve_stage" "$preserve_installed/windows/modern-amd64"
printf 'old supervisor\n' > "$preserve_installed/windows/modern-amd64/ongrid-edge-supervisor.exe"
ongrid_preserve_windows_edge_assets "$preserve_stage" "$preserve_installed" \
    || fail "preserving an existing Windows tree failed"
cmp -s "$preserve_installed/windows/modern-amd64/ongrid-edge-supervisor.exe" \
    "$preserve_stage/windows/modern-amd64/ongrid-edge-supervisor.exe" \
    || fail "the existing Windows tree was not carried into the new stage"
# A stage that already has fresh Windows artifacts wins; preservation is a
# fallback for Linux-only packages, not an overwrite.
printf 'new supervisor\n' > "$preserve_stage/windows/modern-amd64/ongrid-edge-supervisor.exe"
ongrid_preserve_windows_edge_assets "$preserve_stage" "$preserve_installed"
grep -Fxq 'new supervisor' "$preserve_stage/windows/modern-amd64/ongrid-edge-supervisor.exe" \
    || fail "preservation overwrote freshly staged Windows artifacts"
ongrid_preserve_windows_edge_assets "$tmp_dir/absent-stage" "$tmp_dir/absent-installed" \
    || fail "preservation without an existing Windows tree should succeed"

bundle_dir="$tmp_dir/bundle"
mkdir -p "$bundle_dir"
for component in "${components[@]}"; do
    printf '%s\n' "$component" > "$bundle_dir/${component}-linux-amd64"
done
printf 'apply\n' > "$bundle_dir/apply-pending-upgrade.sh"
bash "$repo_root/deploy/install/edge/build-edge-bundle.sh" \
    "$bundle_dir" vtest linux-amd64 >/dev/null
[[ -s "$bundle_dir/edge-bundle-linux-amd64-vtest.tar.gz" \
    && -s "$bundle_dir/edge-bundle-linux-amd64-vtest.tar.gz.sha256" ]] \
    || fail "a complete Edge tree did not produce an upgrade bundle"
rm "$bundle_dir/process_exporter-linux-amd64"
if bash "$repo_root/deploy/install/edge/build-edge-bundle.sh" \
    "$bundle_dir" vnext linux-amd64 >/dev/null 2>&1; then
    fail "an incomplete Edge tree produced an upgrade bundle"
fi

printf 'edge target selection tests passed\n'
