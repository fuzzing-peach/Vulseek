#!/bin/bash

# Vulseek release environment manager. Pulls the GHCR release image.

set -e

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

NETWORK_NAME="vulseek-release-network"
POSTGRES_SERVICE="vulseek-postgres-release"
REDIS_SERVICE="vulseek-redis-release"
VULSEEK_SERVICE="vulseek-release"
TRAEFIK_SERVICE="vulseek-traefik-release"
IMAGE_REPOSITORY="${IMAGE_REPOSITORY:-ghcr.io/fuzzing-peach/vulseek}"
RELEASE_TAG="${RELEASE_TAG:-latest}"
IMAGE_NAME="${IMAGE_REPOSITORY}:${RELEASE_TAG}"
ENV_FILE="${ENV_FILE:-.env.production}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CURRENT_DIR="$(pwd -P)"
DEFAULT_SCAN_CONTEXT_HOST_PATH="${CURRENT_DIR}/vulseek-data"
SCAN_CONTEXT_HOST_PATH="${VULSEEK_SCAN_CONTEXT_HOST_PATH:-}"

resolve_scan_context_host_path() {
    local configured_path="${SCAN_CONTEXT_HOST_PATH:-${VULSEEK_SCAN_CONTEXT_HOST_PATH:-$DEFAULT_SCAN_CONTEXT_HOST_PATH}}"
    mkdir -p "$configured_path"
    (cd "$configured_path" && pwd -P)
}

show_help() {
    echo -e "${BLUE}Vulseek release environment manager (Docker Swarm)${NC}"
    echo ""
    echo "Usage: ./run.sh [command] [options]"
    echo ""
    echo "Options:"
    echo "  --scan-context-host-path PATH"
    echo "             Host scan context root mounted to /scan-context"
    echo "             Default: ${DEFAULT_SCAN_CONTEXT_HOST_PATH}"
    echo ""
    echo "Commands:"
    echo "  init        Initialize Docker Swarm, network, and volumes"
    echo "  pull        Pull ${IMAGE_NAME}"
    echo "  start       Start the release environment"
    echo "  stop        Stop release services"
    echo "  restart     Force restart the Vulseek release service"
    echo "  logs [svc]  Follow logs for vulseek, postgres, redis, or traefik"
    echo "  ps          Show release services"
    echo "  status      Show service status and URLs"
    echo "  clean       Remove services and release volumes"
    echo "  help        Show this help"
    echo ""
}

check_swarm() {
    docker info 2>/dev/null | grep -q "Swarm: active"
}

init_swarm() {
    echo -e "${BLUE}Initializing Docker Swarm...${NC}"

    if ! check_swarm; then
        local_ip=$(ip addr show | grep -E "inet (192\.168\.|10\.|172\.1[6-9]\.|172\.2[0-9]\.|172\.3[0-1]\.)" | head -n1 | awk '{print $2}' | cut -d/ -f1)
        if [ -z "$local_ip" ]; then
            local_ip="127.0.0.1"
        fi
        docker swarm init --advertise-addr "$local_ip" || true
    fi

    docker network create --driver overlay --attachable "$NETWORK_NAME" 2>/dev/null || true
    docker volume create vulseek_release_data >/dev/null
    docker volume create docker_release_config >/dev/null
    docker volume create postgres_release_data >/dev/null
    docker volume create redis_release_data >/dev/null
    docker volume create traefik_release_data >/dev/null

    echo -e "${GREEN}Release environment initialized${NC}"
}

check_env_file() {
    if [ ! -f "$SCRIPT_DIR/$ENV_FILE" ]; then
        echo -e "${RED}Environment file not found: $SCRIPT_DIR/$ENV_FILE${NC}"
        echo -e "${YELLOW}Set ENV_FILE or create .env.production before starting release.${NC}"
        return 1
    fi
}

pull_image() {
    echo -e "${BLUE}Pulling release image: ${IMAGE_NAME}${NC}"
    docker pull --platform linux/amd64 "$IMAGE_NAME"
}

start_postgres() {
    docker service create \
        --name "$POSTGRES_SERVICE" \
        --network "$NETWORK_NAME" \
        --publish published=25432,target=5432,mode=host \
        --env POSTGRES_USER=vulseek \
        --env POSTGRES_PASSWORD=vulseek_release_password \
        --env POSTGRES_DB=vulseek \
        --mount type=volume,source=postgres_release_data,target=/var/lib/postgresql/data \
        --health-cmd "pg_isready -U vulseek" \
        --health-interval 10s \
        --health-timeout 5s \
        --health-retries 5 \
        --constraint 'node.role==manager' \
        postgres:16 2>/dev/null || echo -e "${YELLOW}PostgreSQL service already exists${NC}"
}

start_redis() {
    docker service create \
        --name "$REDIS_SERVICE" \
        --network "$NETWORK_NAME" \
        --publish published=26379,target=6379,mode=host \
        --mount type=volume,source=redis_release_data,target=/data \
        --health-cmd "redis-cli ping" \
        --health-interval 10s \
        --health-timeout 5s \
        --health-retries 5 \
        --constraint 'node.role==manager' \
        redis:7 2>/dev/null || echo -e "${YELLOW}Redis service already exists${NC}"
}

start_vulseek() {
    check_env_file

    local effective_scan_context_host_path
    effective_scan_context_host_path="$(resolve_scan_context_host_path)"
    export VULSEEK_SCAN_CONTEXT_HOST_PATH="$effective_scan_context_host_path"

    pull_image

    local env_file_path="${SCRIPT_DIR}/${ENV_FILE}"
    local env_args=""
    while IFS= read -r line; do
        if [[ ! $line =~ ^[[:space:]]*# ]] && [[ -n $line ]]; then
            line=$(echo "$line" | sed 's/#.*$//' | xargs)
            if [[ -n $line ]]; then
                env_args="$env_args --env $line"
            fi
        fi
    done < "$env_file_path"

    eval docker service create \
        --name "$VULSEEK_SERVICE" \
        --network "$NETWORK_NAME" \
        --publish published=23000,target=3000,mode=host \
        --env NODE_ENV=production \
        --env RELEASE_TAG="$RELEASE_TAG" \
        --env VULSEEK_IMAGE_REPOSITORY="$IMAGE_REPOSITORY" \
        --env VULSEEK_SERVICE_NAME="$VULSEEK_SERVICE" \
        --env DATABASE_URL=postgresql://vulseek:vulseek_release_password@"$POSTGRES_SERVICE":5432/vulseek \
        --env REDIS_URL=redis://"$REDIS_SERVICE":6379 \
        --env VULSEEK_SCAN_CONTEXT_HOST_PATH="${effective_scan_context_host_path}" \
        --env VULSEEK_SCAN_CONTEXT_APP_PATH=/scan-context \
        $env_args \
        --mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock \
        --mount type=bind,source="${effective_scan_context_host_path}",target=/scan-context \
        --mount type=volume,source=vulseek_release_data,target=/etc/vulseek \
        --mount type=volume,source=traefik_release_data,target=/etc/traefik \
        --mount type=volume,source=docker_release_config,target=/root/.docker \
        --constraint "'node.role==manager'" \
        "$IMAGE_NAME" 2>/dev/null || echo -e "${YELLOW}Vulseek release service already exists${NC}"
}

start_traefik() {
    docker service create \
        --name "$TRAEFIK_SERVICE" \
        --network "$NETWORK_NAME" \
        --publish published=20080,target=80,mode=host \
        --publish published=28080,target=8080,mode=host \
        --mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock,readonly \
        --mount type=volume,source=traefik_release_data,target=/etc/traefik \
        --constraint 'node.role==manager' \
        traefik:v3.5.0 \
        --api.insecure=true \
        --api.dashboard=true \
        --providers.swarm=true \
        --providers.swarm.endpoint=unix:///var/run/docker.sock \
        --providers.swarm.exposedbydefault=false \
        --providers.swarm.network="$NETWORK_NAME" \
        --entrypoints.web.address=:80 \
        --log.level=INFO \
        --accesslog=true 2>/dev/null || echo -e "${YELLOW}Traefik service already exists${NC}"
}

start_all() {
    if ! check_swarm; then
        init_swarm
    fi
    start_postgres
    start_redis
    start_vulseek
    start_traefik
    show_status
}

stop_all() {
    docker service rm "$VULSEEK_SERVICE" 2>/dev/null || true
    docker service rm "$TRAEFIK_SERVICE" 2>/dev/null || true
    docker service rm "$REDIS_SERVICE" 2>/dev/null || true
    docker service rm "$POSTGRES_SERVICE" 2>/dev/null || true
    echo -e "${GREEN}Release environment stopped${NC}"
}

restart_vulseek() {
    docker service update --force --image "$IMAGE_NAME" "$VULSEEK_SERVICE"
}

show_logs() {
    local service_name=${1:-vulseek}
    case "$service_name" in
        vulseek) service_name="$VULSEEK_SERVICE" ;;
        postgres) service_name="$POSTGRES_SERVICE" ;;
        redis) service_name="$REDIS_SERVICE" ;;
        traefik) service_name="$TRAEFIK_SERVICE" ;;
    esac

    local task_id
    task_id=$(docker service ps "$service_name" --filter "desired-state=running" -q | head -n1)
    if [ -z "$task_id" ]; then
        echo -e "${RED}Service is not running: $service_name${NC}"
        return 1
    fi

    local container_id
    container_id=$(docker inspect --format '{{.Status.ContainerStatus.ContainerID}}' "$task_id")
    docker logs -f "$container_id"
}

show_status() {
    local effective_scan_context_host_path
    effective_scan_context_host_path="$(resolve_scan_context_host_path)"
    echo -e "${BLUE}Release image:${NC} ${IMAGE_NAME}"
    echo -e "${BLUE}Main app:${NC}      http://localhost:23000"
    echo -e "${BLUE}Traefik:${NC}       http://localhost:28080"
    echo -e "${BLUE}PostgreSQL:${NC}    localhost:25432"
    echo -e "${BLUE}Redis:${NC}         localhost:26379"
    echo -e "${BLUE}Scan Context:${NC}  ${effective_scan_context_host_path}"
    docker service ls --filter "name=vulseek-"
}

clean_all() {
    stop_all
    docker volume rm vulseek_release_data docker_release_config postgres_release_data redis_release_data traefik_release_data 2>/dev/null || true
    echo -e "${GREEN}Release volumes removed${NC}"
}

COMMAND=""
ARGS=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --scan-context-host-path)
            SCAN_CONTEXT_HOST_PATH="$2"
            shift 2
            ;;
        --scan-context-host-path=*)
            SCAN_CONTEXT_HOST_PATH="${1#*=}"
            shift
            ;;
        *)
            if [ -z "$COMMAND" ]; then
                COMMAND="$1"
            else
                ARGS+=("$1")
            fi
            shift
            ;;
    esac
done

case "${COMMAND:-help}" in
    init) init_swarm ;;
    pull) pull_image ;;
    start) start_all ;;
    stop) stop_all ;;
    restart) restart_vulseek ;;
    logs) show_logs "${ARGS[0]}" ;;
    ps) docker service ls --filter "name=vulseek-" ;;
    status) show_status ;;
    clean) clean_all ;;
    help|--help|-h) show_help ;;
    *)
        echo -e "${RED}Unknown command: ${COMMAND}${NC}"
        show_help
        exit 1
        ;;
esac
