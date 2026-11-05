#!/usr/bin/env bash
# ongrid backup.sh - consistent offline backup of Manager business data.
#
# The stack is stopped for the duration of the backup so MySQL, RustFS,
# Qdrant and the other bind-mounted data directories are copied while
# quiescent. MySQL is dumped logically, not copied as raw data files.

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)

BACKUP_LIB="$SCRIPT_DIR/backup-lib.sh"
if [[ ! -r "$BACKUP_LIB" ]]; then
    printf '[ERROR] install package is missing backup-lib.sh\n' >&2
    exit 1
fi
# shellcheck source=backup-lib.sh
source "$BACKUP_LIB"

umask 077

OUTPUT_DIR="${ONGRID_BACKUP_DIR:-/var/backups/ongrid}"
KEEP=0
INCLUDE_MONITORING=0
STAGING=""
TMP_ARCHIVE=""
STACK_STOPPED=0
RESTART_SERVICES=()

usage() {
    cat <<EOF
Usage: sudo ./backup.sh [OPTIONS]

Back up ongrid Manager business data to a single archive. The stack is
stopped while the data directories are copied, then the services that
were running are started again.

Options:
  --output DIR           Archive directory (default: \$ONGRID_BACKUP_DIR
                         or /var/backups/ongrid)
  --keep N               Keep only the newest N archives (0 = keep all).
  --include-monitoring   Also archive prometheus, loki, tempo and grafana
                         data.
  -h, --help             Print this help.

Archives contain secrets (.env, TLS keys) and are written with mode 600.
Restore them with restore.sh.
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --output)
            [[ $# -ge 2 ]] || { log_error "--output requires a directory"; exit 2; }
            OUTPUT_DIR="$2"
            shift 2
            ;;
        --keep)
            [[ $# -ge 2 ]] || { log_error "--keep requires a number"; exit 2; }
            KEEP="$2"
            shift 2
            ;;
        --include-monitoring) INCLUDE_MONITORING=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) log_error "unknown flag: $1"; usage; exit 2 ;;
    esac
done

[[ "$KEEP" =~ ^[0-9]+$ ]] || {
    log_error "--keep must be a non-negative integer"
    exit 2
}

ongrid_backup_init
ongrid_require_runtime

DATA_DIR=$(ongrid_data_dir) || {
    log_error "could not resolve ONGRID_DATA_DIR from $ENV_FILE"
    exit 1
}
[[ -d "$DATA_DIR" ]] || {
    log_error "data directory does not exist: $DATA_DIR"
    exit 1
}

mkdir -p "$OUTPUT_DIR"
[[ -d "$OUTPUT_DIR" ]] || {
    log_error "backup directory is not a directory: $OUTPUT_DIR"
    exit 1
}

VERSION=$(ongrid_env_value ONGRID_VERSION || true)
if [[ -z "$VERSION" && -r "$INSTALL_DIR/VERSION" ]]; then
    VERSION=$(tr -d '[:space:]' <"$INSTALL_DIR/VERSION" || true)
fi
VERSION=${VERSION:-unknown}
SAFE_VERSION=${VERSION//[^A-Za-z0-9._-]/_}
[[ -n "$SAFE_VERSION" ]] || SAFE_VERSION=unknown
TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)

select_data_dirs() {
    local dir

    SELECTED_DATA_DIRS=()
    for dir in "${ONGRID_CORE_DATA_DIRS[@]}"; do
        SELECTED_DATA_DIRS+=("$dir")
    done
    if [[ "$INCLUDE_MONITORING" -eq 1 ]]; then
        for dir in "${ONGRID_MONITORING_DATA_DIRS[@]}"; do
            SELECTED_DATA_DIRS+=("$dir")
        done
    fi
}

restart_stack() {
    if [[ "${#RESTART_SERVICES[@]}" -gt 0 ]]; then
        ongrid_compose start "${RESTART_SERVICES[@]}" || return 1
        return 0
    fi
    # The stack was fully stopped before the backup. MySQL was started only
    # for the dump, so put it back into the stopped state.
    ongrid_compose stop mysql >/dev/null 2>&1 || true
    return 0
}

cleanup() {
    local rc=$?

    if [[ "$STACK_STOPPED" -eq 1 ]]; then
        log_warn "backup interrupted; restarting the services that were running"
        restart_stack || log_error "could not restart the stack; check docker compose status"
    fi
    if [[ -n "$STAGING" ]]; then
        rm -rf -- "$STAGING"
    fi
    if [[ -n "$TMP_ARCHIVE" ]]; then
        rm -f -- "$TMP_ARCHIVE"
    fi
    exit "$rc"
}
trap cleanup EXIT

select_data_dirs

mapfile -t RESTART_SERVICES < <(ongrid_compose ps --status running --services 2>/dev/null || true)

if [[ "${#RESTART_SERVICES[@]}" -gt 0 ]]; then
    log_info "stopping running services for a consistent backup"
    STACK_STOPPED=1
    ongrid_compose stop
else
    log_warn "stack is not running; creating a cold backup"
fi

STAGING=$(mktemp -d "$OUTPUT_DIR/.ongrid-backup.XXXXXX")
mkdir -p "$STAGING/mysql" "$STAGING/data" "$STAGING/config"

log_info "starting MySQL for the logical dump"
ongrid_compose up -d mysql
if ! ongrid_wait_for_mysql; then
    log_error "MySQL did not become ready for the dump"
    exit 1
fi

log_info "dumping database ongrid"
ongrid_compose exec -T mysql sh -c \
    'exec mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --quick --routines --events --triggers --hex-blob --default-character-set=utf8mb4 --databases ongrid' \
    | gzip -c >"$STAGING/mysql/ongrid.sql.gz"

log_info "archiving configuration"
cp -a "$ENV_FILE" "$STAGING/config/.env"
if [[ -d "$INSTALL_DIR/certs" ]]; then
    cp -a "$INSTALL_DIR/certs" "$STAGING/config/certs"
fi
if [[ -f "$INSTALL_DIR/VERSION" ]]; then
    cp -a "$INSTALL_DIR/VERSION" "$STAGING/config/VERSION"
fi
cp -a "$COMPOSE_FILE" "$STAGING/config/docker-compose.yml"

INCLUDED_DATA_DIRS=()
for dir in "${SELECTED_DATA_DIRS[@]}"; do
    if [[ ! -d "$DATA_DIR/$dir" ]]; then
        log_warn "data directory not present, skipping: $DATA_DIR/$dir"
        continue
    fi
    log_info "archiving $dir"
    tar -C "$DATA_DIR" -cpzf "$STAGING/data/$dir.tar.gz" --numeric-owner -- "$dir"
    INCLUDED_DATA_DIRS+=("$dir")
done

{
    printf 'ONGRID_BACKUP_FORMAT=1\n'
    printf 'ONGRID_VERSION=%s\n' "$VERSION"
    printf 'CREATED_AT=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'ONGRID_DATA_DIR=%s\n' "$DATA_DIR"
    printf 'DATA_DIRS=%s\n' "${INCLUDED_DATA_DIRS[*]:-}"
} >"$STAGING/manifest.env"

(
    cd "$STAGING"
    find . -type f ! -name manifest.sha256 -print0 \
        | sort -z \
        | xargs -0 sha256sum >manifest.sha256
)

ARCHIVE_BASE="$OUTPUT_DIR/ongrid-backup-${SAFE_VERSION}-${TIMESTAMP}"
ARCHIVE="${ARCHIVE_BASE}.tar.gz"
suffix=0
while [[ -e "$ARCHIVE" ]]; do
    suffix=$((suffix + 1))
    ARCHIVE="${ARCHIVE_BASE}-${suffix}.tar.gz"
done
TMP_ARCHIVE=$(mktemp "$OUTPUT_DIR/.ongrid-backup.XXXXXX.tar.gz")
tar -C "$STAGING" -cpzf "$TMP_ARCHIVE" .
mv -f "$TMP_ARCHIVE" "$ARCHIVE"
TMP_ARCHIVE=""
chmod 600 "$ARCHIVE"

if ! restart_stack; then
    STACK_STOPPED=0
    log_error "backup written to $ARCHIVE, but the stack did not restart"
    log_error "start it manually: docker compose --project-directory $INSTALL_DIR -f $COMPOSE_FILE up -d"
    exit 1
fi
STACK_STOPPED=0

log_info "backup written: $ARCHIVE"
log_info "size: $(du -h "$ARCHIVE" | cut -f1)"
if [[ "${#INCLUDED_DATA_DIRS[@]}" -gt 0 ]]; then
    log_info "data directories: ${INCLUDED_DATA_DIRS[*]}"
fi

if [[ "$KEEP" -gt 0 ]]; then
    mapfile -t OLD_ARCHIVES < <(
        find "$OUTPUT_DIR" -maxdepth 1 -type f -name 'ongrid-backup-*.tar.gz' -printf '%T@ %p\n' \
            | sort -rn \
            | tail -n +$((KEEP + 1)) \
            | cut -d' ' -f2-
    )
    if [[ "${#OLD_ARCHIVES[@]}" -gt 0 ]]; then
        for old in "${OLD_ARCHIVES[@]}"; do
            log_info "pruning old backup: $old"
            rm -f -- "$old" || log_warn "could not remove $old"
        done
    fi
fi

log_info "done"
