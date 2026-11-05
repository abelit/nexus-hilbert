#!/usr/bin/env bash
# Shared helpers for ongrid Compose data backup and restore scripts.

if [[ -t 1 ]]; then
    C_RED=$'\033[0;31m'; C_GREEN=$'\033[0;32m'; C_YELLOW=$'\033[1;33m'
    C_BOLD=$'\033[1m'; C_RESET=$'\033[0m'
else
    C_RED=''; C_GREEN=''; C_YELLOW=''; C_BOLD=''; C_RESET=''
fi

log_info()  { printf '%s[INFO]%s %s\n'  "$C_GREEN"  "$C_RESET" "$*"; }
log_warn()  { printf '%s[WARN]%s %s\n'  "$C_YELLOW" "$C_RESET" "$*"; }
log_error() { printf '%s[ERROR]%s %s\n' "$C_RED"    "$C_RESET" "$*" >&2; }

# Business data lives under ONGRID_DATA_DIR. MySQL is excluded because it is
# dumped logically; the remaining directories are archived as-is.
ONGRID_CORE_DATA_DIRS=(
    rustfs
    cmdb-files
    chat-attachments
    pages
    packet-captures
    pcap-parser
    qdrant
    workspace
    skills
    embeddings
    tools
)
ONGRID_MONITORING_DATA_DIRS=(prometheus loki tempo grafana)

ongrid_backup_init() {
    INSTALL_DIR="${ONGRID_INSTALL_DIR:-/opt/ongrid}"
    COMPOSE_FILE="$INSTALL_DIR/docker-compose.yml"
    OVERRIDE_FILE="$INSTALL_DIR/docker-compose.override.yml"
    ENV_FILE="$INSTALL_DIR/.env"
}

# Read a KEY=VALUE entry without sourcing the file. Docker Compose .env files
# are data, not shell scripts; sourcing them would execute caller-controlled
# content during restore.
ongrid_value_from() {
    local file="$1" key="$2" line value

    [[ -r "$file" ]] || return 1
    line=$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "$file" | tail -n 1) || return 1
    value=${line#*=}
    value=${value%$'\r'}

    case "$value" in
        \"*) value=${value#\"}; value=${value%%\"*} ;;
        \'*) value=${value#\'}; value=${value%%\'*} ;;
        *)
            value=${value%%[[:space:]]#*}
            value=${value%"${value##*[![:space:]]}"}
            ;;
    esac
    printf '%s\n' "$value"
}

ongrid_env_value() {
    ongrid_value_from "$ENV_FILE" "$1"
}

ongrid_compose() {
    local args=(--project-directory "$INSTALL_DIR" -f "$COMPOSE_FILE")
    [[ -f "$OVERRIDE_FILE" ]] && args+=(-f "$OVERRIDE_FILE")
    args+=(--env-file "$ENV_FILE")
    docker compose "${args[@]}" "$@"
}

ongrid_require_runtime() {
    command -v docker >/dev/null 2>&1 || {
        log_error "docker not found in PATH"
        return 1
    }
    docker compose version >/dev/null 2>&1 || {
        log_error "docker compose v2 is required (the 'docker compose' subcommand)"
        return 1
    }
    [[ -f "$COMPOSE_FILE" ]] || {
        log_error "compose file not found: $COMPOSE_FILE"
        log_error "run install.sh first, or set ONGRID_INSTALL_DIR"
        return 1
    }
    [[ -r "$ENV_FILE" ]] || {
        log_error "cannot read $ENV_FILE; run this script with sudo"
        return 1
    }
}

ongrid_data_dir() {
    local dir
    dir=$(ongrid_env_value ONGRID_DATA_DIR || true)
    dir=${dir:-/var/lib/ongrid}
    case "$dir" in
        /*) ;;
        *) dir="$INSTALL_DIR/$dir" ;;
    esac
    dir=${dir%/}
    [[ -n "$dir" && "$dir" != "/" ]] || return 1
    printf '%s\n' "$dir"
}

ongrid_log_dir() {
    local dir
    dir=$(ongrid_env_value ONGRID_LOG_DIR || true)
    dir=${dir:-/var/log/ongrid}
    case "$dir" in
        /*) ;;
        *) dir="$INSTALL_DIR/$dir" ;;
    esac
    dir=${dir%/}
    [[ -n "$dir" && "$dir" != "/" ]] || return 1
    printf '%s\n' "$dir"
}

ongrid_valid_data_dir_name() {
    [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]
}

ongrid_wait_for_mysql() {
    local attempt
    for attempt in $(seq 1 60); do
        if ongrid_compose exec -T mysql sh -c \
            'mysqladmin ping -uroot -p"$MYSQL_ROOT_PASSWORD" --silent' >/dev/null 2>&1; then
            return 0
        fi
        sleep 2
    done
    return 1
}
