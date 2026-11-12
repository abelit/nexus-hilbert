#!/usr/bin/env bash
#
# Hermetic test for the Go 1.20 legacy Windows build harness.
#
# Builds both Windows executables into a temporary directory, verifies they are
# non-empty, and verifies the Go build metadata records the Go 1.20 toolchain.
# Nothing is written inside the repository.
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "$script_dir/.." && pwd)

legacy_go=go1.20.14

fail() {
	echo "FAIL: $*" >&2
	exit 1
}

# Fail loudly and early if the real Go 1.20 toolchain cannot be downloaded or
# unpacked. Go 1.21+ cannot produce binaries for Windows Server 2008 R2, so a
# silent fallback to the default toolchain would be worse than failing.
if ! GOTOOLCHAIN=$legacy_go go version >/dev/null 2>&1; then
	echo "FAIL: the $legacy_go toolchain is unavailable." >&2
	echo "The legacy Windows build requires a real Go 1.20.x toolchain; Go 1.21+ binaries do not run on Windows Server 2008 R2." >&2
	echo "Ensure the Go module proxy is reachable, or install it explicitly:" >&2
	echo "  go install golang.org/dl/$legacy_go@latest && $legacy_go download" >&2
	exit 1
fi

out_dir=$(mktemp -d)
cleanup() {
	rm -rf -- "$out_dir"
}
trap cleanup EXIT

bash "$repo_root/tools/build-legacy-windows.sh" "$out_dir"

for artifact in ongrid-edge-supervisor.exe ongrid-edge-worker.exe; do
	path="$out_dir/$artifact"
	[[ -s "$path" ]] || fail "$artifact is missing or empty"
	version_output=$(GOTOOLCHAIN=$legacy_go go version -m "$path")
	first_line=${version_output%%$'\n'*}
	[[ "$first_line" == *"$legacy_go"* ]] || fail "$artifact was not built with $legacy_go: $first_line"
	echo "ok: $artifact ($(wc -c <"$path") bytes) built with $legacy_go"
done

echo "PASS: legacy Windows binaries built with $legacy_go"
