#!/usr/bin/env bash
#
# Build the Windows Edge binaries with a real Go 1.20 toolchain.
#
# Windows Server 2008 R2 SP1 is the legacy target, and Go 1.21+ binaries do not
# run there. The main module requires Go 1.25, so this harness copies only the
# edge dependency closure into a temporary module, rewrites the Go 1.21+ stdlib
# imports to internal/compat shims, pins dependencies to Go 1.20-compatible
# releases, and builds the two Windows executables.
#
# Usage: tools/build-legacy-windows.sh <out-dir>
#
# Nothing is written inside the repository: the source copy and Go module cache
# work happen in a temporary directory that is removed on exit.
set -euo pipefail

usage() {
	echo "usage: $(basename "$0") <out-dir>" >&2
	exit 2
}

if [[ $# -ne 1 || -z "${1:-}" ]]; then
	usage
fi

out_dir=$1
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "$script_dir/.." && pwd)

# Keep this pinned: Go 1.21+ emits a PE subsystem version that 2008 R2 cannot
# load, so anything newer than 1.20.x would silently defeat the legacy target.
legacy_go=go1.20.14

if [[ ! -f "$repo_root/VERSION" ]]; then
	echo "error: $repo_root/VERSION not found" >&2
	exit 1
fi
version=$(tr -d '[:space:]' <"$repo_root/VERSION")

mkdir -p -- "$out_dir"
out_dir=$(cd -- "$out_dir" && pwd)

work=$(mktemp -d)
cleanup() {
	rm -rf -- "$work"
}
trap cleanup EXIT

# 1. Copy only the edge dependency closure. Manager, cmdb, iam, web, the
#    tool modules, and VCS data are intentionally excluded: importing them from
#    the temporary module would pull dependencies that require a newer Go.
mkdir -p "$work/cmd" "$work/internal" "$work/third_party"
for command in ongrid-edge ongrid-edge-supervisor; do
	cp -a -- "$repo_root/cmd/$command" "$work/cmd/"
done
for package in edgeagent pkg skill compat; do
	cp -a -- "$repo_root/internal/$package" "$work/internal/"
done
cp -- "$repo_root/go.mod" "$repo_root/go.sum" "$work/"

# Tests are not part of the build closure. Removing them keeps `go mod tidy`
# from resolving test-only modules (the built package contents are unchanged).
find "$work" -type f -name '*_test.go' -delete

# Production copy of the Phase 0 patched geminio (go 1.20, pruned tests/tools,
# pinned x/crypto and x/sys).
if [[ ! -f "$repo_root/third_party/geminio/go.mod" ]]; then
	echo "error: $repo_root/third_party/geminio/go.mod not found" >&2
	exit 1
fi
cp -a -- "$repo_root/third_party/geminio" "$work/third_party/geminio"

# 2. Rewrite the temporary module's go directive and dependency pins.
sed -i -E 's/^go [0-9].*/go 1.20/; /^toolchain[[:space:]]/d' "$work/go.mod"
cat >>"$work/go.mod" <<'EOF'

// Keep the legacy build on Go 1.20. Replacements (rather than plain require
// lines) are required because MVS would otherwise select the newer releases
// already listed by the main module.
replace github.com/singchia/geminio => ./third_party/geminio

replace golang.org/x/crypto => golang.org/x/crypto v0.31.0

replace golang.org/x/exp => golang.org/x/exp v0.0.0-20230905200255-921286631fa9

replace golang.org/x/net => golang.org/x/net v0.26.0

replace golang.org/x/sync => golang.org/x/sync v0.7.0

replace golang.org/x/sys => golang.org/x/sys v0.28.0

replace golang.org/x/text => golang.org/x/text v0.21.0

replace github.com/grpc-ecosystem/grpc-gateway/v2 => github.com/grpc-ecosystem/grpc-gateway/v2 v2.19.1

replace github.com/klauspost/compress => github.com/klauspost/compress v1.17.9

replace github.com/gosnmp/gosnmp => github.com/gosnmp/gosnmp v1.38.0

replace go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp => go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp v0.49.0

replace go.opentelemetry.io/otel => go.opentelemetry.io/otel v1.24.0

replace go.opentelemetry.io/otel/exporters/otlp/otlptrace => go.opentelemetry.io/otel/exporters/otlp/otlptrace v1.24.0

replace go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp => go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp v1.24.0

replace go.opentelemetry.io/otel/metric => go.opentelemetry.io/otel/metric v1.24.0

replace go.opentelemetry.io/otel/sdk => go.opentelemetry.io/otel/sdk v1.24.0

replace go.opentelemetry.io/otel/trace => go.opentelemetry.io/otel/trace v1.24.0

replace go.opentelemetry.io/proto/otlp => go.opentelemetry.io/proto/otlp v1.3.1

replace google.golang.org/genproto/googleapis/api => google.golang.org/genproto/googleapis/api v0.0.0-20240102182953-50ed04b92917

replace google.golang.org/genproto/googleapis/rpc => google.golang.org/genproto/googleapis/rpc v0.0.0-20240102182953-50ed04b92917

replace google.golang.org/grpc => google.golang.org/grpc v1.63.2

replace google.golang.org/protobuf => google.golang.org/protobuf v1.34.2
EOF

# 3. Rewrite stdlib imports that did not exist in Go 1.20. Only import lines
#    are touched; strings and comments keep their original text. semconv is
#    pinned to the newest schema bundled with otel v1.24.0; only stable
#    ServiceName/ServiceNamespace helpers are used.
find "$work" -type f -name '*.go' -print0 | xargs -0 sed -i -E \
	-e 's#^([[:space:]]*([A-Za-z_][A-Za-z0-9_]*[[:space:]]+)?)"log/slog"#\1"github.com/ongridio/ongrid/internal/compat/slog"#' \
	-e 's#^([[:space:]]*([A-Za-z_][A-Za-z0-9_]*[[:space:]]+)?)"slices"#\1"github.com/ongridio/ongrid/internal/compat/slices"#' \
	-e 's#^([[:space:]]*([A-Za-z_][A-Za-z0-9_]*[[:space:]]+)?)"maps"#\1"github.com/ongridio/ongrid/internal/compat/maps"#' \
	-e 's#^([[:space:]]*([A-Za-z_][A-Za-z0-9_]*[[:space:]]+)?)"math/rand/v2"#\1"github.com/ongridio/ongrid/internal/compat/rand"#' \
	-e 's#"go\.opentelemetry\.io/otel/semconv/v1\.27\.0"#"go.opentelemetry.io/otel/semconv/v1.24.0"#'

# The Go 1.21 clear builtin is used for two slice call sites. Rewrite those
# files to the compat helper and add its import to the existing import block.
clear_files=$(grep -rlE --include='*.go' '\bclear\(' "$work/internal" || true)
if [[ -n "$clear_files" ]]; then
	while IFS= read -r file; do
		perl -0pi -e 's/\bclear\(/compatclear.Clear(/g; s/import \(\n/import (\n\tcompatclear "github.com\/ongridio\/ongrid\/internal\/compat\/clear"\n/' "$file"
	done <<<"$clear_files"
fi

# 4. Resolve the pruned module graph with the real Go 1.20 toolchain.
(
	cd "$work"
	GOTOOLCHAIN=$legacy_go go mod tidy
)

# 5. Build only the two command entry points. `go build ./...` would try to
#    compile packages that are not part of the Windows variant (for example
#    edgeagent/plugins/autoapm, which uses slices.Chunk from Go 1.23).
(
	cd "$work"
	GOTOOLCHAIN=$legacy_go GOOS=windows GOARCH=amd64 CGO_ENABLED=0 \
		go build -trimpath -ldflags "-s -w -X main.version=$version" \
		-o "$out_dir/ongrid-edge-supervisor.exe" ./cmd/ongrid-edge-supervisor
	GOTOOLCHAIN=$legacy_go GOOS=windows GOARCH=amd64 CGO_ENABLED=0 \
		go build -trimpath -ldflags "-s -w -X main.version=$version" \
		-o "$out_dir/ongrid-edge-worker.exe" ./cmd/ongrid-edge
)

# 6. Fail loudly if an artifact is missing, empty, or built by a newer Go.
for artifact in ongrid-edge-supervisor.exe ongrid-edge-worker.exe; do
	path="$out_dir/$artifact"
	if [[ ! -s "$path" ]]; then
		echo "error: $path is missing or empty" >&2
		exit 1
	fi
	version_output=$(GOTOOLCHAIN=$legacy_go go version -m "$path")
	first_line=${version_output%%$'\n'*}
	if [[ "$first_line" != *"$legacy_go"* ]]; then
		echo "error: $artifact was not built with $legacy_go: $first_line" >&2
		exit 1
	fi
	echo "built $path ($(wc -c <"$path") bytes, $first_line)"
done
