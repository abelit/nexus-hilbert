#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
build_script="$repo_root/dist/build-edge-attachments.sh"
makefile="$repo_root/Makefile"
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT

fail() {
    printf 'windows attachment test failed: %s\n' "$*" >&2
    exit 1
}

version=vtest
bin_root="$tmp_dir/bin"
mkdir -p "$bin_root/windows-amd64" "$bin_root/legacy-windows-amd64"
printf 'supervisor payload\n' > "$bin_root/windows-amd64/ongrid-edge-supervisor.exe"
printf 'worker payload\n' > "$bin_root/windows-amd64/ongrid-edge-worker.exe"
printf 'installer payload\n' > "$bin_root/windows-amd64/ongrid-edge-installer.exe"
printf 'legacy supervisor payload\n' > "$bin_root/legacy-windows-amd64/ongrid-edge-supervisor.exe"
printf 'legacy worker payload\n' > "$bin_root/legacy-windows-amd64/ongrid-edge-worker.exe"
windows_plugins=(windows_exporter otelcol-contrib mysqld_exporter postgres_exporter redis_exporter)
for plugin in "${windows_plugins[@]}"; do
    printf '%s payload\n' "$plugin" > "$bin_root/windows-amd64/$plugin.exe"
done

out="$tmp_dir/out"
EDGE_BIN_ROOT="$bin_root" \
    bash "$build_script" edge "$version" "$out" windows-amd64 legacy-windows-amd64

modern_supervisor="$out/ongrid-edge-windows-amd64-$version-supervisor.exe"
modern_worker="$out/ongrid-edge-windows-amd64-$version-worker.exe"
installer="$out/ongrid-edge-windows-amd64-$version-installer.exe"
legacy_supervisor="$out/ongrid-edge-legacy-windows-amd64-$version-supervisor.exe"
legacy_worker="$out/ongrid-edge-legacy-windows-amd64-$version-worker.exe"
for file in "$modern_supervisor" "$modern_worker" "$installer" \
    "$legacy_supervisor" "$legacy_worker" \
    "$modern_supervisor.sha256" "$modern_worker.sha256" "$installer.sha256" \
    "$legacy_supervisor.sha256" "$legacy_worker.sha256"; do
    [[ -f "$file" ]] || fail "missing $(basename "$file")"
done

cmp -s "$bin_root/windows-amd64/ongrid-edge-supervisor.exe" "$modern_supervisor" \
    || fail "supervisor attachment does not match its input"
cmp -s "$bin_root/windows-amd64/ongrid-edge-worker.exe" "$modern_worker" \
    || fail "worker attachment does not match its input"
cmp -s "$bin_root/windows-amd64/ongrid-edge-installer.exe" "$installer" \
    || fail "installer attachment does not match its input"
cmp -s "$bin_root/legacy-windows-amd64/ongrid-edge-supervisor.exe" "$legacy_supervisor" \
    || fail "legacy supervisor attachment does not match its input"
cmp -s "$bin_root/legacy-windows-amd64/ongrid-edge-worker.exe" "$legacy_worker" \
    || fail "legacy worker attachment does not match its input"

for plugin in "${windows_plugins[@]}"; do
    plugin_file="$out/ongrid-edge-windows-amd64-$version-$plugin.exe"
    [[ -f "$plugin_file" ]] || fail "missing $(basename "$plugin_file")"
    [[ -f "$plugin_file.sha256" ]] || fail "missing $(basename "$plugin_file").sha256"
    cmp -s "$bin_root/windows-amd64/$plugin.exe" "$plugin_file" \
        || fail "$plugin attachment does not match its input"
done
[[ ! -e "$out/ongrid-edge-windows-amd64-$version-mongodb_exporter.exe" ]] \
    || fail "mongodb_exporter must not be packaged without a Windows upstream asset"
[[ ! -e "$out/ongrid-edge-legacy-windows-amd64-$version-installer.exe" ]] \
    || fail "the installer bootstrap is shared by both variants and must not be duplicated"

(cd "$out" && sha256sum -c \
    "$(basename "$modern_supervisor").sha256" "$(basename "$modern_worker").sha256" \
    "$(basename "$installer").sha256" \
    "$(basename "$legacy_supervisor").sha256" "$(basename "$legacy_worker").sha256" \
    ongrid-edge-windows-amd64-"$version"-*.exe.sha256) >/dev/null \
    || fail "attachment sidecars did not verify"

# The publish and verify lists are the release contract. Neither may drift
# from the builder's actual output set, or an immutable release would be
# created without (or with extra) Windows payloads.
mapfile -t built < <(
    find "$out" -maxdepth 1 -type f -name '*.exe' -printf '%f\n' | LC_ALL=C sort
)
if (( ${#built[@]} == 0 )); then
    fail "builder produced no Windows attachments"
fi

extract_release_names() {
    grep -oE 'ongrid-edge-(windows-amd64|legacy-windows-amd64)-[0-9A-Za-z._-]+-[A-Za-z0-9._-]+\.exe' \
        | LC_ALL=C sort -u
}

verify_output=$(make -n -C "$repo_root" verify-edge-version-release \
    VERSION="$version" EDGE_ATTACHMENT_TARGETS="" \
    EDGE_VERSION_ATTACHMENT_TARGETS="windows-amd64 legacy-windows-amd64")
mapfile -t verified < <(extract_release_names <<<"$verify_output")
if [[ "${verified[*]}" != "${built[*]}" ]]; then
    fail "verify-edge-version-release list does not match the builder output set
  built:    ${built[*]}
  verified: ${verified[*]}"
fi

# `make -n` executes recipes containing $(MAKE), so inspect the publisher's
# source instead of dry-running it: publish and verify must share the same
# single-source variable whose expansion was just compared to the builder.
mapfile -t release_names < <(
    make -s -C "$repo_root" edge-version-attachment-names \
        VERSION="$version" EDGE_ATTACHMENT_TARGETS="" \
        EDGE_VERSION_ATTACHMENT_TARGETS="windows-amd64 legacy-windows-amd64"
)
mapfile -t release_names < <(printf '%s\n' "${release_names[@]}" | LC_ALL=C sort)
if [[ "${release_names[*]}" != "${built[*]}" ]]; then
    fail "edge-version-attachment-names does not match the builder output set
  built:        ${built[*]}
  release names: ${release_names[*]}"
fi
grep -Fq 'bash "$(CURDIR)/scripts/verify-cnb-release-attachments.sh"' "$makefile" \
    || fail "Makefile does not declare the release verifier"
grep -Fq '"$(VERSION)" $(EDGE_VERSION_ATTACHMENT_NAMES)' "$makefile" \
    || fail "verify-edge-version-release does not use the shared attachment-name list"
grep -Fq 'for name in $(EDGE_VERSION_ATTACHMENT_NAMES)' "$makefile" \
    || fail "publish-edge-version-attachments does not use the shared attachment-name list"
grep -Fq "EDGE_VERSION_ATTACHMENT_TARGETS" "$makefile" \
    || fail "Makefile does not declare the versioned attachment target set"

# The override above proves the shared list tracks the builder. Also check the
# production default: if legacy-windows-amd64 silently dropped out of
# EDGE_VERSION_ATTACHMENT_TARGETS, verify/publish would omit legacy artifacts
# and this test would still pass without the default expansion.
mapfile -t default_names < <(
    env -u EDGE_ATTACHMENT_TARGETS -u EDGE_VERSION_ATTACHMENT_TARGETS \
        make -s -C "$repo_root" edge-version-attachment-names VERSION="$version"
)
for required in \
    "ongrid-edge-windows-amd64-$version-supervisor.exe" \
    "ongrid-edge-windows-amd64-$version-worker.exe" \
    "ongrid-edge-windows-amd64-$version-installer.exe" \
    "ongrid-edge-legacy-windows-amd64-$version-supervisor.exe" \
    "ongrid-edge-legacy-windows-amd64-$version-worker.exe"; do
    grep -Fxq "$required" < <(printf '%s\n' "${default_names[@]}") \
        || fail "production default does not include $required"
done

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

# The installer bootstrap is mandatory for a complete Windows release.
printf 'redis payload\n' > "$bin_root/windows-amd64/redis_exporter.exe"
rm "$bin_root/windows-amd64/ongrid-edge-installer.exe"
if output=$(EDGE_BIN_ROOT="$bin_root" \
    bash "$build_script" edge "$version" "$tmp_dir/missing-installer" windows-amd64 2>&1); then
    fail "missing installer input was accepted"
fi
grep -Fq 'ongrid-edge-installer.exe' <<<"$output" \
    || fail "missing-installer error did not name the absent binary: $output"

# Legacy artifacts are mandatory as well.
rm "$bin_root/legacy-windows-amd64/ongrid-edge-supervisor.exe"
if EDGE_BIN_ROOT="$bin_root" \
    bash "$build_script" edge "$version" "$tmp_dir/missing-legacy" legacy-windows-amd64 >/dev/null 2>&1; then
    fail "missing legacy supervisor input was accepted"
fi

printf 'windows attachment tests passed\n'
