#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT

fail() {
    printf '%s\n' "$*" >&2
    exit 1
}

backup_script="$repo_root/deploy/install/backup.sh"
restore_script="$repo_root/deploy/install/restore.sh"

[[ -r "$backup_script" ]] || fail "missing $backup_script"
[[ -r "$restore_script" ]] || fail "missing $restore_script"

# Help must work without Docker and without root.
backup_help=$(bash "$backup_script" --help) || fail "backup.sh --help failed"
grep -Fq -- '--output' <<<"$backup_help" || fail "backup help does not document --output"
grep -Fq -- '--include-monitoring' <<<"$backup_help" \
    || fail "backup help does not document --include-monitoring"
grep -Fq -- '--keep' <<<"$backup_help" || fail "backup help does not document --keep"

restore_help=$(bash "$restore_script" --help) || fail "restore.sh --help failed"
grep -Fq -- '--with-config' <<<"$restore_help" \
    || fail "restore help does not document --with-config"
grep -Fq -- '--no-start' <<<"$restore_help" || fail "restore help does not document --no-start"
grep -Fq -- '--yes' <<<"$restore_help" || fail "restore help does not document --yes"

# ---------- fixture install ----------
install_dir="$tmp_dir/install"
data_dir="$tmp_dir/data"
backup_dir="$tmp_dir/backups"
mkdir -p "$install_dir/certs" \
    "$data_dir"/{rustfs,cmdb-files,qdrant,workspace,mysql,prometheus,loki}
cp "$repo_root/deploy/install/docker-compose.yml" "$install_dir/docker-compose.yml"
printf 'v9.9.9\n' >"$install_dir/VERSION"
cat >"$install_dir/.env" <<EOF
ONGRID_VERSION=v9.9.9
ONGRID_DATA_DIR=$data_dir
ONGRID_LOG_DIR=$tmp_dir/log
MYSQL_ROOT_PASSWORD=test-root
EOF
printf 'test-cert\n' >"$install_dir/certs/tls.crt"
printf 'test-key\n' >"$install_dir/certs/tls.key"
printf 'server-file\n' >"$data_dir/rustfs/object.bin"
printf 'cmdb-file\n' >"$data_dir/cmdb-files/a.txt"
printf 'vector\n' >"$data_dir/qdrant/collection.bin"
printf 'workspace-file\n' >"$data_dir/workspace/note.txt"
printf 'raw-datadir\n' >"$data_dir/mysql/ibdata1"
printf 'monitoring\n' >"$data_dir/prometheus/chunk"
printf 'monitoring\n' >"$data_dir/loki/chunk"

# ---------- fake docker ----------
fake_bin="$tmp_dir/bin"
mkdir -p "$fake_bin"
cat >"$fake_bin/docker" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"${FAKE_DOCKER_LOG:?}"

[[ "${1:-}" == "compose" ]] || {
    printf 'fake docker: unsupported command: %s\n' "$*" >&2
    exit 1
}
shift

while [[ $# -gt 0 ]]; do
    case "$1" in
        --project-directory|-f|--env-file|--status|--format) shift 2 ;;
        *) break ;;
    esac
done

sub="${1:-}"
shift || true

case "$sub" in
    version)
        printf 'Docker Compose version v2.24.0\n'
        ;;
    ps)
        printf '%s\n' ${FAKE_RUNNING_SERVICES:-mysql ongrid ongrid-cmdb rustfs qdrant}
        ;;
    stop|start|down|up)
        ;;
    exec)
        [[ "${1:-}" == "-T" ]] && shift
        service="${1:-}"
        shift || true
        [[ "$service" == "mysql" ]] || {
            printf 'fake docker: unexpected exec service: %s\n' "$service" >&2
            exit 1
        }
        [[ "${1:-}" == "sh" ]] && shift
        [[ "${1:-}" == "-c" ]] && shift
        command="${1:-}"
        if [[ "$command" == *mysqladmin* ]]; then
            exit 0
        elif [[ "$command" == *mysqldump* ]]; then
            printf 'CREATE DATABASE ongrid;\nUSE ongrid;\nCREATE TABLE demo (id int);\n'
        elif [[ "$command" == *mysql* ]]; then
            cat >"${FAKE_MYSQL_IMPORT:?}"
        else
            printf 'fake docker: unexpected exec command: %s\n' "$command" >&2
            exit 1
        fi
        ;;
    *)
        printf 'fake docker: unsupported compose subcommand: %s\n' "$sub" >&2
        exit 1
        ;;
esac
FAKE
chmod +x "$fake_bin/docker"

export PATH="$fake_bin:$PATH"
export FAKE_DOCKER_LOG="$tmp_dir/docker.log"
export FAKE_MYSQL_IMPORT="$tmp_dir/import.sql"
: >"$FAKE_DOCKER_LOG"
: >"$FAKE_MYSQL_IMPORT"

# ---------- backup ----------
ONGRID_INSTALL_DIR="$install_dir" bash "$backup_script" --output "$backup_dir" \
    >"$tmp_dir/backup.log" 2>&1 || {
    cat "$tmp_dir/backup.log" >&2
    fail "backup failed"
}

archive=$(find "$backup_dir" -maxdepth 1 -type f -name 'ongrid-backup-*.tar.gz' | head -n1)
[[ -n "$archive" ]] || fail "backup did not create an archive"
[[ "$(stat -c %a "$archive")" == "600" ]] || fail "backup archive is not mode 600"

tar -tzf "$archive" >"$tmp_dir/archive.list"
for required in \
    ./manifest.env \
    ./manifest.sha256 \
    ./mysql/ongrid.sql.gz \
    ./data/rustfs.tar.gz \
    ./data/cmdb-files.tar.gz \
    ./data/qdrant.tar.gz \
    ./data/workspace.tar.gz \
    ./config/.env \
    ./config/certs/tls.crt \
    ./config/VERSION; do
    grep -Fqx "$required" "$tmp_dir/archive.list" \
        || fail "archive is missing $required"
done

if grep -Fq './data/mysql' "$tmp_dir/archive.list"; then
    fail "backup archived the raw MySQL data directory"
fi
if grep -Fq './data/prometheus' "$tmp_dir/archive.list" \
    || grep -Fq './data/loki' "$tmp_dir/archive.list"; then
    fail "backup included monitoring data without --include-monitoring"
fi

mkdir -p "$tmp_dir/extract"
tar -xzf "$archive" -C "$tmp_dir/extract"
gzip -dc "$tmp_dir/extract/mysql/ongrid.sql.gz" | grep -Fq 'CREATE DATABASE ongrid' \
    || fail "MySQL dump was not captured"
tar -tzf "$tmp_dir/extract/data/rustfs.tar.gz" | grep -Fq 'rustfs/object.bin' \
    || fail "rustfs data was not archived"

stop_line=$(grep -n ' stop$' "$FAKE_DOCKER_LOG" | head -n1 | cut -d: -f1 || true)
dump_line=$(grep -n 'mysqldump' "$FAKE_DOCKER_LOG" | head -n1 | cut -d: -f1 || true)
start_line=$(grep -n ' start ' "$FAKE_DOCKER_LOG" | head -n1 | cut -d: -f1 || true)
[[ -n "$stop_line" && -n "$dump_line" && -n "$start_line" ]] \
    || fail "backup did not stop, dump, and restart the stack"
[[ "$stop_line" -lt "$dump_line" && "$dump_line" -lt "$start_line" ]] \
    || fail "backup did not quiesce the stack around the MySQL dump"

# ---------- restore ----------
printf 'changed\n' >"$data_dir/rustfs/object.bin"
rm -f "$data_dir/cmdb-files/a.txt"
printf '# keep-me\n' >>"$install_dir/.env"
: >"$FAKE_DOCKER_LOG"
: >"$FAKE_MYSQL_IMPORT"

ONGRID_INSTALL_DIR="$install_dir" bash "$restore_script" "$archive" --yes --no-start \
    >"$tmp_dir/restore.log" 2>&1 || {
    cat "$tmp_dir/restore.log" >&2
    fail "restore failed"
}

[[ "$(cat "$data_dir/rustfs/object.bin")" == "server-file" ]] \
    || fail "restore did not restore rustfs data"
[[ "$(cat "$data_dir/cmdb-files/a.txt")" == "cmdb-file" ]] \
    || fail "restore did not restore cmdb-files data"
[[ "$(cat "$data_dir/workspace/note.txt")" == "workspace-file" ]] \
    || fail "restore did not restore workspace data"
grep -Fq 'CREATE DATABASE ongrid' "$FAKE_MYSQL_IMPORT" \
    || fail "restore did not import the MySQL dump"
grep -Fq '# keep-me' "$install_dir/.env" \
    || fail "restore overwrote .env without --with-config"

pre_restore=$(find "$data_dir" -maxdepth 1 -type d -name 'rustfs.pre-restore-*' | head -n1)
[[ -n "$pre_restore" ]] || fail "restore did not preserve the previous data directory"
[[ "$(cat "$pre_restore/object.bin")" == "changed" ]] \
    || fail "restore moved the wrong data into the pre-restore directory"

grep -Eq ' down$' "$FAKE_DOCKER_LOG" || fail "restore did not stop the stack"
grep -Fq 'up -d mysql' "$FAKE_DOCKER_LOG" || fail "restore did not start MySQL for import"
if grep -Eq ' up -d$' "$FAKE_DOCKER_LOG"; then
    fail "restore started the full stack despite --no-start"
fi

# ---------- tampered archive is rejected before touching data ----------
printf 'original\n' >"$data_dir/rustfs/object.bin"
mkdir -p "$tmp_dir/tamper"
tar -xzf "$archive" -C "$tmp_dir/tamper"
printf 'tampered' >>"$tmp_dir/tamper/mysql/ongrid.sql.gz"
tar -czf "$tmp_dir/tampered.tar.gz" -C "$tmp_dir/tamper" .
: >"$FAKE_DOCKER_LOG"
: >"$FAKE_MYSQL_IMPORT"

if ONGRID_INSTALL_DIR="$install_dir" bash "$restore_script" "$tmp_dir/tampered.tar.gz" \
    --yes --no-start >"$tmp_dir/tampered.log" 2>&1; then
    fail "restore accepted an archive with a bad checksum"
fi
[[ "$(cat "$data_dir/rustfs/object.bin")" == "original" ]] \
    || fail "restore modified data before verifying the archive checksum"
[[ ! -s "$FAKE_DOCKER_LOG" ]] \
    || fail "restore ran docker commands before verifying the archive checksum"

# ---------- rollback only touches directories already moved aside ----------
find "$data_dir" -maxdepth 1 -type d -name '*.pre-restore-*' -exec rm -rf {} +
printf 'rollback-original\n' >"$data_dir/rustfs/object.bin"
printf 'cmdb-original\n' >"$data_dir/cmdb-files/a.txt"
mkdir -p "$tmp_dir/fail-bin"
cat >"$tmp_dir/fail-bin/mv" <<'MV'
#!/usr/bin/env bash
set -euo pipefail
src=""
dst=""
for arg in "$@"; do
    [[ "$arg" == "--" ]] && continue
    if [[ -z "$src" ]]; then
        src="$arg"
    else
        dst="$arg"
    fi
done
if [[ "$(basename "$src")" == "cmdb-files" && "$dst" == *.pre-restore-* ]]; then
    printf 'fake mv: refusing to move cmdb-files\n' >&2
    exit 1
fi
exec /bin/mv "$@"
MV
chmod +x "$tmp_dir/fail-bin/mv"
: >"$FAKE_DOCKER_LOG"

if PATH="$tmp_dir/fail-bin:$PATH" ONGRID_INSTALL_DIR="$install_dir" \
    bash "$restore_script" "$archive" --yes --no-start >"$tmp_dir/rollback.log" 2>&1; then
    fail "restore succeeded even though a data directory could not be moved aside"
fi
[[ "$(cat "$data_dir/rustfs/object.bin")" == "rollback-original" ]] \
    || fail "rollback did not restore the directory it had moved aside"
[[ "$(cat "$data_dir/cmdb-files/a.txt")" == "cmdb-original" ]] \
    || fail "rollback deleted a directory that had not been moved aside yet"
[[ -z "$(find "$data_dir" -maxdepth 1 -type d -name 'rustfs.pre-restore-*' -print -quit)" ]] \
    || fail "rollback left the moved directory in the pre-restore location"

# ---------- --with-config is rolled back together with the data ----------
printf '# with-config-marker\n' >>"$install_dir/.env"
if PATH="$tmp_dir/fail-bin:$PATH" ONGRID_INSTALL_DIR="$install_dir" \
    bash "$restore_script" "$archive" --yes --no-start --with-config \
    >"$tmp_dir/config-rollback.log" 2>&1; then
    fail "restore succeeded even though a data directory could not be moved aside"
fi
grep -Fq '# with-config-marker' "$install_dir/.env" \
    || fail "failed restore did not roll back the archived .env"

# ---------- --with-config replaces .env only on success ----------
: >"$FAKE_DOCKER_LOG"
: >"$FAKE_MYSQL_IMPORT"
ONGRID_INSTALL_DIR="$install_dir" bash "$restore_script" "$archive" --yes --no-start \
    --with-config >"$tmp_dir/config-restore.log" 2>&1 || {
    cat "$tmp_dir/config-restore.log" >&2
    fail "restore --with-config failed"
}
if grep -Fq '# with-config-marker' "$install_dir/.env"; then
    fail "restore --with-config did not replace .env"
fi
grep -Fq "ONGRID_DATA_DIR=$data_dir" "$install_dir/.env" \
    || fail "restore --with-config wrote an .env with the wrong data directory"
grep -Fq 'CREATE DATABASE ongrid' "$FAKE_MYSQL_IMPORT" \
    || fail "restore --with-config did not import the MySQL dump"

# ---------- retention ----------
mkdir -p "$tmp_dir/retention"
printf 'old\n' >"$tmp_dir/retention/ongrid-backup-v0.0.0-20000101T000000Z.tar.gz"
: >"$FAKE_DOCKER_LOG"
ONGRID_INSTALL_DIR="$install_dir" bash "$backup_script" --output "$tmp_dir/retention" --keep 1 \
    >"$tmp_dir/retention.log" 2>&1 || {
    cat "$tmp_dir/retention.log" >&2
    fail "backup with --keep failed"
}
[[ "$(find "$tmp_dir/retention" -maxdepth 1 -type f -name 'ongrid-backup-*.tar.gz' | wc -l)" -eq 1 ]] \
    || fail "--keep 1 did not prune old archives"

printf 'backup/restore tests passed\n'
