#!/usr/bin/env bash
# ongrid restore.sh - restore Manager data from a backup.sh archive.
#
# The stack is stopped, existing data directories are moved to
# <name>.pre-restore-<timestamp> instead of being deleted, MySQL is
# initialized from the archive dump, and the file data is unpacked. If any
# step before the restored stack becomes usable fails, the previous
# directories are moved back automatically.

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

ARCHIVE=""
ASSUME_YES=0
NO_START=0
WITH_CONFIG=0
STAGING=""
STACK_DOWN=0
RESTORE_COMPLETE=0
CONFIG_SWAPPED=0
DATA_DIR=""
LOG_DIR=""
RESTORE_TARGETS=()
PROCESSED_DIRS=()
RESTART_SERVICES=()

usage() {
    cat <<EOF
Usage: sudo ./restore.sh ARCHIVE [OPTIONS]

Restore ongrid Manager data from an archive created by backup.sh. The
stack is stopped and data is replaced; verify the archive path before
running this command.

Options:
  --yes           Skip the interactive confirmation.
  --no-start      Restore data but leave the stack stopped.
  --with-config   Also replace the current .env and certs/ with the copies
                  in the archive. Refused when the archived ONGRID_DATA_DIR
                  differs from the current one.
  -h, --help      Print this help.

Previous data directories are kept as <name>.pre-restore-<timestamp> so a
failed restore can be rolled back and a successful one can be verified
before the old copies are deleted.
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --yes|-y) ASSUME_YES=1; shift ;;
        --no-start) NO_START=1; shift ;;
        --with-config) WITH_CONFIG=1; shift ;;
        -h|--help) usage; exit 0 ;;
        -*) log_error "unknown flag: $1"; usage; exit 2 ;;
        *)
            [[ -z "$ARCHIVE" ]] || { log_error "only one archive may be restored"; exit 2; }
            ARCHIVE="$1"
            shift
            ;;
    esac
done

[[ -n "$ARCHIVE" ]] || {
    log_error "an archive path is required"
    usage
    exit 2
}

ongrid_backup_init

snapshot_current_config() {
    cp -a "$ENV_FILE" "$STAGING/original-env" || return 1
    if [[ -d "$INSTALL_DIR/certs" ]]; then
        cp -a "$INSTALL_DIR/certs" "$STAGING/original-certs" || return 1
    fi
}

# Replace .env and certs before the stack is stopped so MySQL initializes with
# the archived credentials and the import uses the same root password.
install_archived_config() {
    local tmp_env="$INSTALL_DIR/.env.restore.$$"
    local tmp_certs="$INSTALL_DIR/.certs.restore.$$"

    cp -a "$STAGING/config/.env" "$tmp_env" || return 1
    chmod 600 "$tmp_env" || return 1
    rm -rf -- "$tmp_certs"
    if [[ -d "$STAGING/config/certs" ]]; then
        cp -a "$STAGING/config/certs" "$tmp_certs" || return 1
    else
        mkdir -p "$tmp_certs" || return 1
    fi
    rm -rf -- "$INSTALL_DIR/certs" || return 1
    mv -- "$tmp_certs" "$INSTALL_DIR/certs" || return 1
    mv -f "$tmp_env" "$ENV_FILE"
}

rollback_restore() {
    local dir src dst

    log_warn "restore failed; rolling back to the previous data"
    if [[ "$CONFIG_SWAPPED" -eq 1 ]]; then
        cp -a "$STAGING/original-env" "$ENV_FILE" \
            || log_error "could not restore the previous .env"
        chmod 600 "$ENV_FILE" 2>/dev/null || true
        rm -rf -- "$INSTALL_DIR/certs" || log_error "could not remove the restored certs directory"
        if [[ -d "$STAGING/original-certs" ]]; then
            cp -a "$STAGING/original-certs" "$INSTALL_DIR/certs" \
                || log_error "could not restore the previous certs directory"
        fi
    fi

    if [[ "$STACK_DOWN" -eq 1 ]]; then
        ongrid_compose down >/dev/null 2>&1 || true
        for dir in "${PROCESSED_DIRS[@]}"; do
            src="$DATA_DIR/$dir"
            dst="$DATA_DIR/$dir.pre-restore-$RESTORE_TS"
            rm -rf -- "$src" || log_error "could not remove partially restored $src"
            if [[ -e "$dst" ]]; then
                mv -- "$dst" "$src" || log_error "could not move $dst back to $src"
            fi
        done

        if [[ "${#RESTART_SERVICES[@]}" -gt 0 ]]; then
            ongrid_compose up -d "${RESTART_SERVICES[@]}" \
                || log_error "could not restart the previous stack; check docker compose status"
        fi
    fi
    log_warn "previous data restored"
}

cleanup() {
    local rc=$?

    if [[ "$RESTORE_COMPLETE" -eq 0 ]] \
        && { [[ "$STACK_DOWN" -eq 1 ]] || [[ "$CONFIG_SWAPPED" -eq 1 ]]; }; then
        rollback_restore
    fi
    if [[ -n "$STAGING" ]]; then
        rm -rf -- "$STAGING"
    fi
    exit "$rc"
}
trap cleanup EXIT

[[ -r "$ARCHIVE" ]] || {
    log_error "cannot read archive: $ARCHIVE"
    exit 1
}

STAGING=$(mktemp -d "${TMPDIR:-/tmp}/ongrid-restore.XXXXXX")

log_info "verifying archive"
tar -tzf "$ARCHIVE" >"$STAGING/archive.list"
if grep -Eq '(^/|(^|/)\.\.(/|$))' "$STAGING/archive.list"; then
    log_error "archive contains absolute or parent-directory paths; refusing to extract"
    exit 1
fi
tar -xzf "$ARCHIVE" -C "$STAGING"

[[ -f "$STAGING/manifest.env" ]] || {
    log_error "archive is missing manifest.env"
    exit 1
}
[[ -f "$STAGING/manifest.sha256" ]] || {
    log_error "archive is missing manifest.sha256"
    exit 1
}
[[ "$(ongrid_value_from "$STAGING/manifest.env" ONGRID_BACKUP_FORMAT || true)" == "1" ]] || {
    log_error "unsupported backup format"
    exit 1
}
[[ -f "$STAGING/mysql/ongrid.sql.gz" ]] || {
    log_error "archive is missing the MySQL dump"
    exit 1
}

(
    cd "$STAGING"
    sha256sum --quiet -c manifest.sha256
) || {
    log_error "archive checksum verification failed; refusing to modify data"
    exit 1
}

ARCHIVE_VERSION=$(ongrid_value_from "$STAGING/manifest.env" ONGRID_VERSION || true)
ARCHIVE_CREATED_AT=$(ongrid_value_from "$STAGING/manifest.env" CREATED_AT || true)
MANIFEST_DATA_DIRS=$(ongrid_value_from "$STAGING/manifest.env" DATA_DIRS || true)
read -r -a RESTORE_DATA_DIRS <<<"$MANIFEST_DATA_DIRS"

for dir in "${RESTORE_DATA_DIRS[@]}"; do
    ongrid_valid_data_dir_name "$dir" || {
        log_error "archive manifest contains an unsafe data directory: $dir"
        exit 1
    }
    [[ "$dir" != "mysql" ]] || {
        log_error "archive manifest must not list mysql as a data directory"
        exit 1
    }
    [[ -f "$STAGING/data/$dir.tar.gz" ]] || {
        log_error "archive is missing data/$dir.tar.gz"
        exit 1
    }
done

DATA_DIR=$(ongrid_data_dir) || {
    log_error "could not resolve ONGRID_DATA_DIR from $ENV_FILE"
    exit 1
}
LOG_DIR=$(ongrid_log_dir) || {
    log_error "could not resolve ONGRID_LOG_DIR from $ENV_FILE"
    exit 1
}
ongrid_require_runtime

CURRENT_VERSION=$(ongrid_env_value ONGRID_VERSION || true)
if [[ -n "$ARCHIVE_VERSION" && -n "$CURRENT_VERSION" && "$ARCHIVE_VERSION" != "$CURRENT_VERSION" ]]; then
    log_warn "archive was created by $ARCHIVE_VERSION, current install is $CURRENT_VERSION"
    log_warn "database schema compatibility is not guaranteed across versions"
fi
if [[ -n "$ARCHIVE_CREATED_AT" ]]; then
    log_info "archive created at $ARCHIVE_CREATED_AT"
fi

ARCHIVED_DATA_DIR=""
if [[ -r "$STAGING/config/.env" ]]; then
    ARCHIVED_DATA_DIR=$(ongrid_value_from "$STAGING/config/.env" ONGRID_DATA_DIR || true)
    ARCHIVED_DATA_DIR=${ARCHIVED_DATA_DIR:-/var/lib/ongrid}
    case "$ARCHIVED_DATA_DIR" in
        /*) ;;
        *) ARCHIVED_DATA_DIR="$INSTALL_DIR/$ARCHIVED_DATA_DIR" ;;
    esac
    ARCHIVED_DATA_DIR=${ARCHIVED_DATA_DIR%/}
fi
if [[ "$WITH_CONFIG" -eq 1 && -n "$ARCHIVED_DATA_DIR" && "$ARCHIVED_DATA_DIR" != "$DATA_DIR" ]]; then
    log_error "--with-config would point ONGRID_DATA_DIR at $ARCHIVED_DATA_DIR, but data was restored to $DATA_DIR"
    log_error "re-run without --with-config, or restore on the original path"
    exit 1
fi

if [[ "$ASSUME_YES" -ne 1 ]]; then
    if [[ ! -t 0 ]]; then
        log_error "restore is destructive; re-run with --yes in a non-interactive session"
        exit 1
    fi
    printf 'This replaces MySQL and %s with the contents of %s.\n' "$DATA_DIR" "$ARCHIVE"
    printf 'Type "restore" to continue: '
    read -r answer
    [[ "$answer" == "restore" ]] || {
        log_info "aborted"
        exit 1
    }
fi

RESTORE_TS="$(date -u +%Y%m%dT%H%M%SZ)-$$"

if [[ "$WITH_CONFIG" -eq 1 ]]; then
    log_info "installing .env and certs from the archive"
    snapshot_current_config || {
        log_error "could not snapshot the current .env and certs"
        exit 1
    }
    cp -a "$ENV_FILE" "$INSTALL_DIR/.env.pre-restore-$RESTORE_TS" || {
        log_error "could not preserve the current .env"
        exit 1
    }
    chmod 600 "$INSTALL_DIR/.env.pre-restore-$RESTORE_TS"
    if [[ -d "$INSTALL_DIR/certs" ]]; then
        cp -a "$INSTALL_DIR/certs" "$INSTALL_DIR/certs.pre-restore-$RESTORE_TS" || {
            log_error "could not preserve the current certs directory"
            exit 1
        }
    fi
    CONFIG_SWAPPED=1
    install_archived_config || {
        log_error "could not install the archived .env and certs"
        exit 1
    }
fi

RESTORE_TARGETS=("${RESTORE_DATA_DIRS[@]}" mysql)

log_info "stopping the stack"
mapfile -t RESTART_SERVICES < <(ongrid_compose ps --status running --services 2>/dev/null || true)
ongrid_compose down
STACK_DOWN=1

for dir in "${RESTORE_TARGETS[@]}"; do
    src="$DATA_DIR/$dir"
    dst="$DATA_DIR/$dir.pre-restore-$RESTORE_TS"
    if [[ -e "$dst" ]]; then
        log_error "refusing to overwrite existing directory: $dst"
        exit 1
    fi
    if [[ -e "$src" ]]; then
        log_info "preserving $dir as $(basename "$dst")"
        mv -- "$src" "$dst"
    fi
    PROCESSED_DIRS+=("$dir")
done

mkdir -p "$DATA_DIR"
if [[ "$EUID" -eq 0 && -r "$SCRIPT_DIR/data-permissions.sh" ]]; then
    # shellcheck source=data-permissions.sh
    source "$SCRIPT_DIR/data-permissions.sh"
    if ! ongrid_prepare_data_directories "$DATA_DIR" "$LOG_DIR"; then
        log_error "could not initialize data directory ownership"
        exit 1
    fi
else
    mkdir -p "$DATA_DIR/mysql"
    if [[ "$EUID" -eq 0 ]]; then
        log_warn "data-permissions.sh not found; relying on the archive's ownership metadata"
    else
        log_warn "not running as root; skipping numeric-owner initialization"
        log_warn "run restore.sh with sudo if containers cannot write to $DATA_DIR"
    fi
fi

for dir in "${RESTORE_DATA_DIRS[@]}"; do
    log_info "restoring $dir"
    tar -C "$DATA_DIR" -xpzf "$STAGING/data/$dir.tar.gz" --numeric-owner
done

log_info "starting MySQL and importing the dump"
ongrid_compose up -d mysql
if ! ongrid_wait_for_mysql; then
    log_error "MySQL did not become ready for the import"
    exit 1
fi
gzip -dc "$STAGING/mysql/ongrid.sql.gz" \
    | ongrid_compose exec -T mysql sh -c \
        'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" --default-character-set=utf8mb4'

if [[ "$WITH_CONFIG" -eq 1 ]]; then
    log_info "using .env and certs restored from the archive"
else
    log_info "kept existing $ENV_FILE (use --with-config to replace it)"
    if [[ ! -e "$INSTALL_DIR/certs" && -d "$STAGING/config/certs" ]]; then
        cp -a "$STAGING/config/certs" "$INSTALL_DIR/certs"
        log_info "restored missing certs directory from the archive"
    fi
fi

if [[ "$NO_START" -eq 1 ]]; then
    ongrid_compose stop mysql >/dev/null 2>&1 || true
    log_info "stack left stopped because --no-start was given"
else
    log_info "starting the stack"
    if ! ongrid_compose up -d; then
        RESTORE_COMPLETE=1
        log_error "data was restored, but the stack failed to start"
        log_error "inspect: docker compose --project-directory $INSTALL_DIR -f $COMPOSE_FILE logs"
        exit 1
    fi
fi

RESTORE_COMPLETE=1
log_info "restore complete"
if [[ "${#RESTORE_TARGETS[@]}" -gt 0 ]]; then
    log_info "previous data kept at $DATA_DIR/*.pre-restore-$RESTORE_TS"
    if [[ "$CONFIG_SWAPPED" -eq 1 ]]; then
        log_info "previous config kept at $INSTALL_DIR/.env.pre-restore-$RESTORE_TS"
    fi
    log_info "delete those files and directories after verifying the restored deployment"
fi
