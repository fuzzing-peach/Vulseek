#!/bin/bash

# Dokploy 开发环境管理脚本 (使用 Docker Swarm)

set -e

# 颜色定义
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# 配置变量
NETWORK_NAME="dokploy-dev-network"
POSTGRES_SERVICE="dokploy-postgres-dev"
REDIS_SERVICE="dokploy-redis-dev"
DOKPLOY_SERVICE="dokploy-dev"
TRAEFIK_SERVICE="dokploy-traefik-dev"
IMAGE_NAME="dokploy-dev:latest"
ENV_FILE="env.development"

# 当前脚本目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_SCAN_CONTEXT_HOST_PATH="$(cd "${SCRIPT_DIR}/.." && pwd)/dokploy-data"
SCAN_CONTEXT_HOST_PATH=""

# 显示帮助信息
show_help() {
    echo -e "${BLUE}Dokploy 开发环境管理脚本 (Docker Swarm)${NC}"
    echo ""
    echo "使用方法: ./dev.sh [命令] [选项]"
    echo ""
    echo "全局选项:"
    echo "  --scan-context-host-path PATH"
    echo "             指定宿主机 scan context 根目录，并挂载到 dokploy-dev:/scan-context"
    echo "             默认值: ${DEFAULT_SCAN_CONTEXT_HOST_PATH}"
    echo ""
    echo "基础命令:"
    echo "  init        - 初始化 Docker Swarm 和网络"
    echo "  build       - 构建开发镜像"
    echo "  start       - 启动开发环境"
    echo "  stop        - 停止开发环境"
    echo "  restart     - 重启开发环境"
    echo "  clean       - 清理服务和卷"
    echo ""
    echo "日志与调试:"
    echo "  logs [服务]  - 查看日志（可选服务：dokploy, postgres, redis, traefik）"
    echo "  shell [服务] - 进入容器 shell（默认：dokploy）"
    echo "  ps          - 查看所有服务状态"
    echo ""
    echo "数据库操作:"
    echo "  db          - 进入 PostgreSQL 命令行"
    echo "  db:migrate  - 运行数据库迁移"
    echo "  db:seed     - 填充测试数据"
    echo "  db:studio   - 启动数据库管理界面"
    echo "  redis       - 进入 Redis 命令行"
    echo ""
    echo "开发工具:"
    echo "  install     - 安装依赖"
    echo "  test        - 运行测试"
    echo "  lint        - 代码检查"
    echo "  format      - 格式化代码"
    echo ""
    echo "环境配置:"
    echo "  env         - 编辑环境配置文件"
    echo "  env:show    - 显示当前环境配置"
    echo ""
    echo "其他:"
    echo "  status      - 显示服务状态和访问地址"
    echo "  update      - 更新服务（重新部署）"
    echo "  help        - 显示此帮助信息"
    echo ""
}

# 检查 Docker Swarm 是否初始化
check_swarm() {
    if ! docker info 2>/dev/null | grep -q "Swarm: active"; then
        return 1
    fi
    return 0
}

# 检查环境文件
check_env_file() {
    if [ ! -f "$SCRIPT_DIR/$ENV_FILE" ]; then
        echo -e "${YELLOW}⚠️  环境文件不存在: $ENV_FILE${NC}"
        echo -e "${BLUE}💡 创建默认环境文件...${NC}"
        
        # 如果示例文件存在，复制它
        if [ -f "$SCRIPT_DIR/env.development.example" ]; then
            cp "$SCRIPT_DIR/env.development.example" "$SCRIPT_DIR/$ENV_FILE"
            echo -e "${GREEN}✅ 已从 env.development.example 创建 $ENV_FILE${NC}"
        else
            echo -e "${RED}❌ 环境文件不存在，且没有找到示例文件${NC}"
            echo -e "${YELLOW}💡 请手动创建 $ENV_FILE 文件${NC}"
            return 1
        fi
    fi
    
    echo -e "${GREEN}✅ 环境文件: $SCRIPT_DIR/$ENV_FILE${NC}"
    return 0
}

# 初始化 Docker Swarm
init_swarm() {
    echo -e "${BLUE}🔧 初始化 Docker Swarm...${NC}"
    
    if check_swarm; then
        echo -e "${YELLOW}⚠️  Swarm 已经初始化${NC}"
    else
        # 获取本地 IP
        local_ip=$(ip addr show | grep -E "inet (192\.168\.|10\.|172\.1[6-9]\.|172\.2[0-9]\.|172\.3[0-1]\.)" | head -n1 | awk '{print $2}' | cut -d/ -f1)
        
        if [ -z "$local_ip" ]; then
            local_ip="127.0.0.1"
        fi
        
        echo -e "${BLUE}使用 IP: $local_ip${NC}"
        docker swarm init --advertise-addr "$local_ip" || {
            echo -e "${YELLOW}⚠️  Swarm 已存在，尝试继续...${NC}"
        }
    fi
    
    # 创建 overlay 网络
    echo -e "${BLUE}📡 创建网络: $NETWORK_NAME${NC}"
    docker network create --driver overlay --attachable "$NETWORK_NAME" 2>/dev/null || {
        echo -e "${YELLOW}⚠️  网络已存在${NC}"
    }
    
    # 创建卷
    echo -e "${BLUE}💾 创建数据卷...${NC}"
    docker volume create node_modules 2>/dev/null || true
    docker volume create dokploy_node_modules 2>/dev/null || true
    docker volume create server_node_modules 2>/dev/null || true
    docker volume create dokploy_data 2>/dev/null || true
    docker volume create docker_config 2>/dev/null || true
    docker volume create postgres_data 2>/dev/null || true
    docker volume create redis_data 2>/dev/null || true
    docker volume create traefik_data 2>/dev/null || true
    
    echo -e "${GREEN}✅ 初始化完成！${NC}"
}

# 构建开发镜像
build_image() {
    echo -e "${YELLOW}🔨 构建开发镜像: $IMAGE_NAME${NC}"
    cd "$SCRIPT_DIR"

    rewrite_proxy_host() {
        local proxy_value="$1"
        if [ -z "$proxy_value" ]; then
            echo ""
            return 0
        fi
        # Rewrite proxy host to Docker bridge gateway and keep the original port.
        echo "$proxy_value" | sed -E 's#^(([a-zA-Z][a-zA-Z0-9+.-]*://)?([^/@]+@)?)([^/:?#]+)(:[0-9]+)?(.*)$#\1172.17.0.1\5\6#'
    }

    local build_http_proxy="${http_proxy:-${HTTP_PROXY:-}}"
    local build_https_proxy="${https_proxy:-${HTTPS_PROXY:-}}"
    local build_all_proxy="${all_proxy:-${ALL_PROXY:-}}"
    local build_no_proxy="${no_proxy:-${NO_PROXY:-}}"
    build_http_proxy="$(rewrite_proxy_host "$build_http_proxy")"
    build_https_proxy="$(rewrite_proxy_host "$build_https_proxy")"
    build_all_proxy="$(rewrite_proxy_host "$build_all_proxy")"
    docker build --progress=plain \
        --build-arg http_proxy="$build_http_proxy" \
        --build-arg https_proxy="$build_https_proxy" \
        --build-arg all_proxy="$build_all_proxy" \
        --build-arg no_proxy="$build_no_proxy" \
        --build-arg HTTP_PROXY="$build_http_proxy" \
        --build-arg HTTPS_PROXY="$build_https_proxy" \
        --build-arg ALL_PROXY="$build_all_proxy" \
        --build-arg NO_PROXY="$build_no_proxy" \
        -f Dockerfile.dev \
        -t "$IMAGE_NAME" .
    echo -e "${GREEN}✅ 镜像构建完成${NC}"
}

# 启动 PostgreSQL 服务
start_postgres() {
    echo -e "${BLUE}🗄️  启动 PostgreSQL...${NC}"
    
    docker service create \
        --name "$POSTGRES_SERVICE" \
        --network "$NETWORK_NAME" \
        --publish published=25432,target=5432,mode=host \
        --env POSTGRES_USER=dokploy \
        --env POSTGRES_PASSWORD=dokploy_dev_password \
        --env POSTGRES_DB=dokploy \
        --mount type=volume,source=postgres_data,target=/var/lib/postgresql/data \
        --health-cmd "pg_isready -U dokploy" \
        --health-interval 10s \
        --health-timeout 5s \
        --health-retries 5 \
        --constraint 'node.role==manager' \
        postgres:16 2>/dev/null || {
        echo -e "${YELLOW}⚠️  PostgreSQL 服务已存在${NC}"
    }
}

# 启动 Redis 服务
start_redis() {
    echo -e "${BLUE}📦 启动 Redis...${NC}"
    
    docker service create \
        --name "$REDIS_SERVICE" \
        --network "$NETWORK_NAME" \
        --publish published=26379,target=6379,mode=host \
        --mount type=volume,source=redis_data,target=/data \
        --health-cmd "redis-cli ping" \
        --health-interval 10s \
        --health-timeout 5s \
        --health-retries 5 \
        --constraint 'node.role==manager' \
        redis:7 2>/dev/null || {
        echo -e "${YELLOW}⚠️  Redis 服务已存在${NC}"
    }
}

# 启动 Dokploy 主服务
start_dokploy() {
    echo -e "${BLUE}🚀 启动 Dokploy 主应用...${NC}"
    local effective_scan_context_host_path="${SCAN_CONTEXT_HOST_PATH:-$DEFAULT_SCAN_CONTEXT_HOST_PATH}"
    
    # 检查镜像是否存在
    if ! docker image inspect "$IMAGE_NAME" >/dev/null 2>&1; then
        echo -e "${YELLOW}⚠️  镜像不存在，开始构建...${NC}"
        build_image
    fi
    
    # 检查环境文件
    if ! check_env_file; then
        echo -e "${RED}❌ 环境文件检查失败${NC}"
        return 1
    fi
    
    # 构建环境变量文件路径
    local env_file_path="${SCRIPT_DIR}/${ENV_FILE}"
    mkdir -p "${effective_scan_context_host_path}"
    
    echo -e "${BLUE}📝 使用环境文件: $env_file_path${NC}"
    echo -e "${BLUE}📁 Scan Context Host Path: ${effective_scan_context_host_path}${NC}"
    
    # 读取环境文件并构建 --env 参数
    local env_args=""
    while IFS= read -r line; do
        # 跳过注释和空行
        if [[ ! $line =~ ^[[:space:]]*# ]] && [[ -n $line ]]; then
            # 移除行尾注释
            line=$(echo "$line" | sed 's/#.*$//' | xargs)
            if [[ -n $line ]]; then
                env_args="$env_args --env $line"
            fi
        fi
    done < "$env_file_path"
    
    echo -e "${GREEN}✅ 已加载环境变量${NC}"
    
    # 使用 eval 执行命令以正确处理环境变量
    eval docker service create \
        --name "$DOKPLOY_SERVICE" \
        --network "$NETWORK_NAME" \
        --publish published=23000,target=3000,mode=host \
        --publish published=29229,target=9229,mode=host \
        --publish published=25555,target=5555,mode=host \
        --env DOKPLOY_SCAN_CONTEXT_HOST_PATH="${effective_scan_context_host_path}" \
        $env_args \
        --mount type=bind,source="${SCRIPT_DIR}/apps",target=/app/apps \
        --mount type=bind,source="${SCRIPT_DIR}/agents",target=/app/agents \
        --mount type=bind,source="${SCRIPT_DIR}/packages",target=/app/packages \
        --mount type=bind,source="${SCRIPT_DIR}/package.json",target=/app/package.json \
        --mount type=bind,source="${SCRIPT_DIR}/pnpm-workspace.yaml",target=/app/pnpm-workspace.yaml \
        --mount type=bind,source="${env_file_path}",target=/app/.env \
        --mount type=volume,source=node_modules,target=/app/node_modules \
        --mount type=volume,source=dokploy_node_modules,target=/app/apps/dokploy/node_modules \
        --mount type=volume,source=server_node_modules,target=/app/packages/server/node_modules \
        --mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock \
        --mount type=bind,source="${effective_scan_context_host_path}",target=/scan-context \
        --mount type=volume,source=dokploy_data,target=/etc/dokploy \
        --mount type=volume,source=docker_config,target=/root/.docker \
        --constraint "'node.role==manager'" \
        "$IMAGE_NAME" 2>/dev/null || {
        echo -e "${YELLOW}⚠️  Dokploy 服务已存在${NC}"
    }
}

# 启动 Traefik 服务
start_traefik() {
    echo -e "${BLUE}🌐 启动 Traefik...${NC}"
    
    docker service create \
        --name "$TRAEFIK_SERVICE" \
        --network "$NETWORK_NAME" \
        --publish published=20080,target=80,mode=host \
        --publish published=28080,target=8080,mode=host \
        --mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock,readonly \
        --mount type=volume,source=traefik_data,target=/etc/traefik \
        --constraint 'node.role==manager' \
        traefik:v3.5.0 \
        --api.insecure=true \
        --api.dashboard=true \
        --providers.swarm=true \
        --providers.swarm.endpoint=unix:///var/run/docker.sock \
        --providers.swarm.exposedbydefault=false \
        --providers.swarm.network="$NETWORK_NAME" \
        --entrypoints.web.address=:80 \
        --log.level=DEBUG \
        --accesslog=true 2>/dev/null || {
        echo -e "${YELLOW}⚠️  Traefik 服务已存在${NC}"
    }
}

# 启动所有服务
start_all() {
    echo -e "${GREEN}🚀 启动 Dokploy 开发环境...${NC}"
    
    # 确保 Swarm 已初始化
    if ! check_swarm; then
        echo -e "${YELLOW}⚠️  Swarm 未初始化，执行初始化...${NC}"
        init_swarm
    fi
    
    # 按顺序启动服务
    start_postgres
    sleep 2
    start_redis
    sleep 2
    start_dokploy
    sleep 2
    start_traefik
    
    echo ""
    echo -e "${GREEN}✅ 开发环境已启动！${NC}"
    echo -e "${BLUE}📱 访问: http://localhost:23000${NC}"
    echo -e "${BLUE}🐛 调试端口: localhost:29229${NC}"
    echo ""
    echo -e "${YELLOW}💡 提示: 使用 './dev.sh status' 查看服务状态${NC}"
}

# 停止所有服务
stop_all() {
    echo -e "${YELLOW}⏹️  停止 Dokploy 开发环境...${NC}"
    
    docker service rm "$DOKPLOY_SERVICE" 2>/dev/null || true
    docker service rm "$TRAEFIK_SERVICE" 2>/dev/null || true
    docker service rm "$REDIS_SERVICE" 2>/dev/null || true
    docker service rm "$POSTGRES_SERVICE" 2>/dev/null || true
    
    echo -e "${GREEN}✅ 开发环境已停止${NC}"
}

# 重启服务
restart_service() {
    local service=${1:-$DOKPLOY_SERVICE}
    echo -e "${YELLOW}🔄 重启服务: $service${NC}"
    docker service update --force "$service"
    echo -e "${GREEN}✅ 服务已重启${NC}"
}

# 查看日志
show_logs() {
    local service_name=${1:-}
    
    case "$service_name" in
        dokploy|"")
            service_name="$DOKPLOY_SERVICE"
            ;;
        postgres)
            service_name="$POSTGRES_SERVICE"
            ;;
        redis)
            service_name="$REDIS_SERVICE"
            ;;
        traefik)
            service_name="$TRAEFIK_SERVICE"
            ;;
    esac
    
    echo -e "${BLUE}📋 查看 $service_name 日志 (Ctrl+C 退出)${NC}"
    
    # 获取任务 ID
    task_id=$(docker service ps "$service_name" --filter "desired-state=running" -q | head -n1)
    
    if [ -n "$task_id" ]; then
        # 获取容器 ID
        container_id=$(docker inspect --format '{{.Status.ContainerStatus.ContainerID}}' "$task_id")
        if [ -n "$container_id" ]; then
            docker logs -f "$container_id"
        else
            echo -e "${RED}❌ 无法获取容器 ID${NC}"
        fi
    else
        echo -e "${RED}❌ 服务未运行${NC}"
    fi
}

# 进入容器 shell
enter_shell() {
    local service_name=${1:-dokploy}
    
    case "$service_name" in
        dokploy|"")
            service_name="$DOKPLOY_SERVICE"
            ;;
        postgres)
            service_name="$POSTGRES_SERVICE"
            ;;
        redis)
            service_name="$REDIS_SERVICE"
            ;;
        traefik)
            service_name="$TRAEFIK_SERVICE"
            ;;
    esac
    
    echo -e "${BLUE}🐚 进入 $service_name 容器 shell...${NC}"
    
    # 获取任务 ID
    task_id=$(docker service ps "$service_name" --filter "desired-state=running" -q | head -n1)
    
    if [ -n "$task_id" ]; then
        # 获取容器 ID
        container_id=$(docker inspect --format '{{.Status.ContainerStatus.ContainerID}}' "$task_id")
        if [ -n "$container_id" ]; then
            docker exec -it "$container_id" bash || docker exec -it "$container_id" sh
        else
            echo -e "${RED}❌ 无法获取容器 ID${NC}"
        fi
    else
        echo -e "${RED}❌ 服务未运行${NC}"
    fi
}

# 查看服务状态
show_status() {
    local effective_scan_context_host_path="${SCAN_CONTEXT_HOST_PATH:-$DEFAULT_SCAN_CONTEXT_HOST_PATH}"
    echo -e "${BLUE}📊 服务状态:${NC}"
    echo ""
    docker service ls --filter "name=dokploy"
    echo ""
    echo -e "${GREEN}🌐 访问地址:${NC}"
    echo -e "  ${BLUE}主应用:${NC}        http://localhost:23000"
    echo -e "  ${BLUE}调试端口:${NC}      localhost:29229"
    echo -e "  ${BLUE}Traefik 面板:${NC}  http://localhost:28080"
    echo -e "  ${BLUE}PostgreSQL:${NC}    localhost:25432 (用户: dokploy, 密码: dokploy_dev_password)"
    echo -e "  ${BLUE}Redis:${NC}         localhost:26379"
    echo -e "  ${BLUE}Scan Context:${NC}  ${effective_scan_context_host_path}"
    echo ""
}

# 进入 PostgreSQL
enter_db() {
    echo -e "${BLUE}🗄️  进入 PostgreSQL 命令行...${NC}"
    enter_shell postgres
    # 在进入后执行 psql
    # 注意：这个命令在上面的 enter_shell 结束后不会执行
}

# 直接连接数据库
connect_db() {
    echo -e "${BLUE}🗄️  连接 PostgreSQL...${NC}"
    
    task_id=$(docker service ps "$POSTGRES_SERVICE" --filter "desired-state=running" -q | head -n1)
    
    if [ -n "$task_id" ]; then
        container_id=$(docker inspect --format '{{.Status.ContainerStatus.ContainerID}}' "$task_id")
        if [ -n "$container_id" ]; then
            docker exec -it "$container_id" psql -U dokploy -d dokploy
        else
            echo -e "${RED}❌ 无法获取容器 ID${NC}"
        fi
    else
        echo -e "${RED}❌ PostgreSQL 服务未运行${NC}"
    fi
}

# 数据库迁移（推送 schema）
db_migrate() {
    echo -e "${BLUE}🔄 运行数据库迁移...${NC}"
    
    task_id=$(docker service ps "$DOKPLOY_SERVICE" --filter "desired-state=running" -q | head -n1)
    
    if [ -n "$task_id" ]; then
        container_id=$(docker inspect --format '{{.Status.ContainerStatus.ContainerID}}' "$task_id")
        if [ -n "$container_id" ]; then
            docker exec "$container_id" sh -c "cd apps/dokploy && pnpm db:push"
            echo -e "${GREEN}✅ 数据库迁移完成${NC}"
        else
            echo -e "${RED}❌ 无法获取容器 ID${NC}"
        fi
    else
        echo -e "${RED}❌ Dokploy 服务未运行${NC}"
    fi
}

# 数据库填充
db_seed() {
    echo -e "${BLUE}🌱 填充测试数据...${NC}"
    
    task_id=$(docker service ps "$DOKPLOY_SERVICE" --filter "desired-state=running" -q | head -n1)
    
    if [ -n "$task_id" ]; then
        container_id=$(docker inspect --format '{{.Status.ContainerStatus.ContainerID}}' "$task_id")
        if [ -n "$container_id" ]; then
            docker exec "$container_id" sh -c "cd apps/dokploy && pnpm db:seed"
            echo -e "${GREEN}✅ 测试数据填充完成${NC}"
        else
            echo -e "${RED}❌ 无法获取容器 ID${NC}"
        fi
    else
        echo -e "${RED}❌ Dokploy 服务未运行${NC}"
    fi
}

# 数据库管理界面
db_studio() {
    echo -e "${BLUE}🎨 启动数据库管理界面...${NC}"
    echo -e "${YELLOW}💡 Drizzle Studio 将在 http://localhost:25555 启动${NC}"
    
    task_id=$(docker service ps "$DOKPLOY_SERVICE" --filter "desired-state=running" -q | head -n1)
    
    if [ -n "$task_id" ]; then
        container_id=$(docker inspect --format '{{.Status.ContainerStatus.ContainerID}}' "$task_id")
        if [ -n "$container_id" ]; then
            docker exec -it "$container_id" sh -c "cd apps/dokploy && pnpm db:studio"
        else
            echo -e "${RED}❌ 无法获取容器 ID${NC}"
        fi
    else
        echo -e "${RED}❌ Dokploy 服务未运行${NC}"
    fi
}

# 进入 Redis
enter_redis() {
    echo -e "${BLUE}📦 进入 Redis 命令行...${NC}"
    
    task_id=$(docker service ps "$REDIS_SERVICE" --filter "desired-state=running" -q | head -n1)
    
    if [ -n "$task_id" ]; then
        container_id=$(docker inspect --format '{{.Status.ContainerStatus.ContainerID}}' "$task_id")
        if [ -n "$container_id" ]; then
            docker exec -it "$container_id" redis-cli
        else
            echo -e "${RED}❌ 无法获取容器 ID${NC}"
        fi
    else
        echo -e "${RED}❌ Redis 服务未运行${NC}"
    fi
}

# 安装依赖
install_deps() {
    echo -e "${BLUE}📦 安装依赖...${NC}"
    
    task_id=$(docker service ps "$DOKPLOY_SERVICE" --filter "desired-state=running" -q | head -n1)
    
    if [ -n "$task_id" ]; then
        container_id=$(docker inspect --format '{{.Status.ContainerStatus.ContainerID}}' "$task_id")
        if [ -n "$container_id" ]; then
            docker exec "$container_id" pnpm install
            echo -e "${GREEN}✅ 依赖安装完成${NC}"
        else
            echo -e "${RED}❌ 无法获取容器 ID${NC}"
        fi
    else
        echo -e "${RED}❌ Dokploy 服务未运行${NC}"
    fi
}

# 运行测试
run_tests() {
    echo -e "${BLUE}🧪 运行测试...${NC}"
    
    task_id=$(docker service ps "$DOKPLOY_SERVICE" --filter "desired-state=running" -q | head -n1)
    
    if [ -n "$task_id" ]; then
        container_id=$(docker inspect --format '{{.Status.ContainerStatus.ContainerID}}' "$task_id")
        if [ -n "$container_id" ]; then
            docker exec "$container_id" pnpm test
        else
            echo -e "${RED}❌ 无法获取容器 ID${NC}"
        fi
    else
        echo -e "${RED}❌ Dokploy 服务未运行${NC}"
    fi
}

# 代码检查
run_lint() {
    echo -e "${BLUE}🔍 代码检查...${NC}"
    
    task_id=$(docker service ps "$DOKPLOY_SERVICE" --filter "desired-state=running" -q | head -n1)
    
    if [ -n "$task_id" ]; then
        container_id=$(docker inspect --format '{{.Status.ContainerStatus.ContainerID}}' "$task_id")
        if [ -n "$container_id" ]; then
            docker exec "$container_id" pnpm format-and-lint
        else
            echo -e "${RED}❌ 无法获取容器 ID${NC}"
        fi
    else
        echo -e "${RED}❌ Dokploy 服务未运行${NC}"
    fi
}

# 格式化代码
run_format() {
    echo -e "${BLUE}✨ 格式化代码...${NC}"
    
    task_id=$(docker service ps "$DOKPLOY_SERVICE" --filter "desired-state=running" -q | head -n1)
    
    if [ -n "$task_id" ]; then
        container_id=$(docker inspect --format '{{.Status.ContainerStatus.ContainerID}}' "$task_id")
        if [ -n "$container_id" ]; then
            docker exec "$container_id" pnpm format-and-lint:fix
            echo -e "${GREEN}✅ 代码格式化完成${NC}"
        else
            echo -e "${RED}❌ 无法获取容器 ID${NC}"
        fi
    else
        echo -e "${RED}❌ Dokploy 服务未运行${NC}"
    fi
}

# 编辑环境文件
edit_env() {
    local env_path="${SCRIPT_DIR}/${ENV_FILE}"
    
    # 如果文件不存在，先创建
    if [ ! -f "$env_path" ]; then
        echo -e "${YELLOW}⚠️  环境文件不存在，创建新文件...${NC}"
        if [ -f "$SCRIPT_DIR/env.development.example" ]; then
            cp "$SCRIPT_DIR/env.development.example" "$env_path"
            echo -e "${GREEN}✅ 已从示例文件创建 $ENV_FILE${NC}"
        else
            touch "$env_path"
            echo -e "${YELLOW}⚠️  创建空环境文件${NC}"
        fi
    fi
    
    # 使用默认编辑器打开
    local editor="${EDITOR:-vi}"
    echo -e "${BLUE}📝 使用 $editor 编辑环境文件...${NC}"
    "$editor" "$env_path"
    
    echo -e "${GREEN}✅ 环境文件已保存${NC}"
    echo -e "${YELLOW}💡 提示: 修改环境文件后需要运行 './dev.sh update dokploy' 使更改生效${NC}"
}

# 显示环境配置
show_env() {
    local env_path="${SCRIPT_DIR}/${ENV_FILE}"
    
    if [ ! -f "$env_path" ]; then
        echo -e "${RED}❌ 环境文件不存在: $ENV_FILE${NC}"
        echo -e "${YELLOW}💡 运行 './dev.sh env' 创建环境文件${NC}"
        return 1
    fi
    
    echo -e "${BLUE}📝 环境配置文件: $env_path${NC}"
    echo ""
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    
    # 显示文件内容，但隐藏敏感信息
    while IFS= read -r line; do
        # 隐藏包含敏感信息的行
        if [[ $line =~ ^[[:space:]]*#.* ]] || [[ -z $line ]]; then
            # 注释和空行直接显示
            echo "$line"
        elif [[ $line =~ (PASSWORD|SECRET|KEY|TOKEN)= ]]; then
            # 敏感信息行部分隐藏
            key=$(echo "$line" | cut -d'=' -f1)
            echo "${key}=********"
        else
            # 其他行正常显示
            echo "$line"
        fi
    done < "$env_path"
    
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    echo -e "${YELLOW}💡 提示: 敏感信息（PASSWORD、SECRET、KEY、TOKEN）已隐藏${NC}"
    echo -e "${YELLOW}💡 运行 './dev.sh env' 编辑完整配置${NC}"
}

# 更新服务
update_service() {
    local service=${1:-$DOKPLOY_SERVICE}
    echo -e "${YELLOW}🔄 更新服务: $service${NC}"
    
    # 如果是 Dokploy 服务，重新构建镜像
    if [ "$service" = "$DOKPLOY_SERVICE" ] || [ "$service" = "dokploy" ]; then
        build_image
        docker service update --image "$IMAGE_NAME" --force "$DOKPLOY_SERVICE"
    else
        docker service update --force "$service"
    fi
    
    echo -e "${GREEN}✅ 服务已更新${NC}"
}

# 清理
clean_all() {
    echo -e "${RED}🧹 清理服务和资源...${NC}"
    read -p "这将删除所有开发服务和数据卷，确认吗？(y/N) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        # 停止服务
        stop_all
        
        # 删除网络
        echo -e "${BLUE}📡 删除网络...${NC}"
        docker network rm "$NETWORK_NAME" 2>/dev/null || true
        
        # 删除卷
        echo -e "${BLUE}💾 删除数据卷...${NC}"
        read -p "是否删除数据卷（包括数据库数据）？(y/N) " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            docker volume rm node_modules 2>/dev/null || true
            docker volume rm dokploy_node_modules 2>/dev/null || true
            docker volume rm server_node_modules 2>/dev/null || true
            docker volume rm dokploy_data 2>/dev/null || true
            docker volume rm docker_config 2>/dev/null || true
            docker volume rm postgres_data 2>/dev/null || true
            docker volume rm redis_data 2>/dev/null || true
            docker volume rm traefik_data 2>/dev/null || true
        fi
        
        # 删除镜像
        read -p "是否删除开发镜像？(y/N) " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            docker rmi "$IMAGE_NAME" 2>/dev/null || true
        fi
        
        echo -e "${GREEN}✅ 清理完成${NC}"
    else
        echo -e "${YELLOW}❌ 取消清理${NC}"
    fi
}

# 参数解析
COMMAND="${1:-}"
if [ -n "$COMMAND" ]; then
    shift
fi
POSITIONAL_ARGS=()

while [ $# -gt 0 ]; do
    case "$1" in
        --scan-context-host-path)
            if [ -z "${2:-}" ]; then
                echo -e "${RED}❌ --scan-context-host-path 需要一个路径参数${NC}"
                exit 1
            fi
            SCAN_CONTEXT_HOST_PATH="$2"
            shift 2
            ;;
        --help|-h)
            show_help
            exit 0
            ;;
        *)
            POSITIONAL_ARGS+=("$1")
            shift
            ;;
    esac
done

# 主命令处理
case "$COMMAND" in
    init)
        init_swarm
        ;;
    build)
        build_image
        ;;
    start)
        start_all
        ;;
    stop)
        stop_all
        ;;
    restart)
        restart_service "${POSITIONAL_ARGS[0]}"
        ;;
    logs)
        show_logs "${POSITIONAL_ARGS[0]}"
        ;;
    shell)
        enter_shell "${POSITIONAL_ARGS[0]}"
        ;;
    ps|status)
        show_status
        ;;
    db)
        connect_db
        ;;
    db:migrate)
        db_migrate
        ;;
    db:seed)
        db_seed
        ;;
    db:studio)
        db_studio
        ;;
    redis)
        enter_redis
        ;;
    install)
        install_deps
        ;;
    test)
        run_tests
        ;;
    lint)
        run_lint
        ;;
    format)
        run_format
        ;;
    env)
        edit_env
        ;;
    env:show)
        show_env
        ;;
    update)
        update_service "${POSITIONAL_ARGS[0]}"
        ;;
    clean)
        clean_all
        ;;
    help|--help|-h)
        show_help
        ;;
    *)
        if [ -z "$COMMAND" ]; then
            show_help
        else
            echo -e "${RED}❌ 未知命令: $COMMAND${NC}"
            echo ""
            show_help
            exit 1
        fi
        ;;
esac
