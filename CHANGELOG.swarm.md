# Docker Swarm 迁移变更日志

## 📅 变更日期

2025-11-04

## 🎯 变更目标

将开发环境从 **docker-compose** 迁移到 **Docker Swarm**，以与生产环境保持一致。

## 📦 主要变更

### 1. `dev.sh` 脚本重写

#### 变更前
- 使用 `docker-compose` 命令
- 依赖 `docker-compose.dev.yml` 文件
- 简单的容器管理

#### 变更后
- 使用 `docker service` 命令
- 服务配置直接写在脚本中
- 基于 Docker Swarm 的服务编排
- 新增功能：
  - `init` - 初始化 Docker Swarm
  - `build` - 构建开发镜像
  - `update` - 更新服务（重新部署）
  - 改进的日志和 shell 访问方式

### 2. 服务管理方式

#### PostgreSQL 服务
```bash
# 变更前 (docker-compose)
services:
  postgres:
    image: postgres:16
    ports:
      - "25432:5432"

# 变更后 (Docker Swarm)
docker service create \
  --name dokploy-postgres-dev \
  --network dokploy-dev-network \
  --publish published=25432,target=5432,mode=host \
  postgres:16
```

#### Redis 服务
```bash
# 变更前 (docker-compose)
services:
  redis:
    image: redis:7
    ports:
      - "26379:6379"

# 变更后 (Docker Swarm)
docker service create \
  --name dokploy-redis-dev \
  --network dokploy-dev-network \
  --publish published=26379,target=6379,mode=host \
  redis:7
```

#### Dokploy 主应用
```bash
# 变更前 (docker-compose)
services:
  dokploy-dev:
    build:
      context: .
      dockerfile: Dockerfile.dev

# 变更后 (Docker Swarm)
# 1. 先构建镜像
docker build -f Dockerfile.dev -t dokploy-dev:latest .

# 2. 创建服务
docker service create \
  --name dokploy-dev \
  --network dokploy-dev-network \
  --publish published=23000,target=3000,mode=host \
  dokploy-dev:latest
```

#### Traefik 服务
```bash
# 变更前 (docker-compose)
services:
  traefik:
    image: traefik:v3.5.0
    command:
      - "--api.insecure=true"

# 变更后 (Docker Swarm)
docker service create \
  --name dokploy-traefik-dev \
  --network dokploy-dev-network \
  --publish published=20080,target=80,mode=host \
  --publish published=28080,target=8080,mode=host \
  traefik:v3.5.0 \
  --api.insecure=true \
  --providers.docker.swarmMode=true
```

### 3. 网络变更

```bash
# 变更前 (docker-compose)
networks:
  dokploy-dev-network:
    driver: bridge

# 变更后 (Docker Swarm)
docker network create --driver overlay --attachable dokploy-dev-network
```

### 4. 卷管理

```bash
# 变更前 (docker-compose 自动管理)
volumes:
  postgres_data:
  redis_data:

# 变更后 (手动创建)
docker volume create postgres_data
docker volume create redis_data
```

## 🔧 使用方式变更

### 初始化

```bash
# 新增步骤：初始化 Swarm
./dev.sh init
```

### 启动服务

```bash
# 变更前
docker-compose -f docker-compose.dev.yml up -d

# 变更后
./dev.sh start
```

### 查看日志

```bash
# 变更前
docker-compose -f docker-compose.dev.yml logs -f

# 变更后
./dev.sh logs dokploy  # 需要指定服务名
```

### 进入容器

```bash
# 变更前
docker-compose -f docker-compose.dev.yml exec dokploy-dev bash

# 变更后
./dev.sh shell  # 脚本自动获取容器 ID
```

### 代码更新

```bash
# 变更前
docker-compose -f docker-compose.dev.yml restart

# 变更后（推荐）
./dev.sh update dokploy

# 或者
./dev.sh restart dokploy
```

### 停止服务

```bash
# 变更前
docker-compose -f docker-compose.dev.yml down

# 变更后
./dev.sh stop
```

### 清理

```bash
# 变更前
docker-compose -f docker-compose.dev.yml down -v

# 变更后
./dev.sh clean
```

## 📝 新增命令

| 命令 | 说明 |
|------|------|
| `./dev.sh init` | 初始化 Docker Swarm 和网络 |
| `./dev.sh build` | 构建开发镜像 |
| `./dev.sh update <service>` | 更新服务（重新部署） |
| `./dev.sh restart <service>` | 重启特定服务 |

## ⚠️ 重要变更

### 1. 必须初始化 Swarm

```bash
# 首次使用必须执行
./dev.sh init
```

### 2. 不支持 build 配置

Swarm 不支持在服务定义中使用 `build`，必须先构建镜像：

```bash
# 必须先构建
./dev.sh build

# 然后启动
./dev.sh start
```

### 3. 代码修改后需要更新服务

```bash
# 修改代码后
./dev.sh update dokploy

# 或重新构建+更新
./dev.sh build
./dev.sh update dokploy
```

### 4. 日志和 Shell 访问方式改变

脚本会自动获取任务 ID 和容器 ID，但如果手动操作需要：

```bash
# 获取容器 ID
TASK_ID=$(docker service ps dokploy-dev -q | head -n1)
CONTAINER_ID=$(docker inspect --format '{{.Status.ContainerStatus.ContainerID}}' $TASK_ID)

# 使用容器 ID
docker logs $CONTAINER_ID
docker exec -it $CONTAINER_ID bash
```

## ✅ 优势

1. **与生产一致**: 使用相同的编排方式
2. **更好的管理**: 服务自动重启、健康检查
3. **滚动更新**: 支持零停机更新
4. **服务发现**: 内置 DNS 和负载均衡
5. **易于扩展**: 可以轻松扩展副本数

## ⚠️ 注意事项

1. **学习曲线**: Docker Swarm 比 docker-compose 复杂
2. **调试难度**: 需要理解任务、容器概念
3. **热重载**: 代码修改后需要 `./dev.sh update`
4. **单节点模式**: 开发环境使用单节点 Swarm

## 🔄 回退方案

如果需要回退到 docker-compose:

1. 保留 `docker-compose.dev.yml` 文件（已在仓库中）
2. 使用 docker-compose 命令：
   ```bash
   docker-compose -f docker-compose.dev.yml up -d
   ```

## 📚 相关文档

- [SWARM_MIGRATION.md](./SWARM_MIGRATION.md) - Swarm 详细指南
- [QUICKSTART.dev.md](./QUICKSTART.dev.md) - 快速开始（已更新）
- [DEVELOPMENT.md](./DEVELOPMENT.md) - 完整开发文档（已更新）
- [DEV_SETUP_SUMMARY.md](./DEV_SETUP_SUMMARY.md) - 配置总结（需要更新）

## 🐛 已知问题

1. **热重载**: 卷挂载在 Swarm 中可能有延迟，需要手动更新服务
2. **日志访问**: 需要多个步骤获取容器 ID
3. **Windows 支持**: Docker Swarm 在 Windows 上支持有限

## 💡 最佳实践

1. 始终使用 `./dev.sh` 脚本，避免手动操作
2. 代码修改后使用 `./dev.sh update` 而不是 `restart`
3. 定期运行 `./dev.sh status` 检查服务状态
4. 开发时保持 Swarm 初始化状态，不要频繁 `swarm leave`

## 🚀 快速迁移步骤

对于现有开发者：

```bash
# 1. 停止旧的 docker-compose 环境
docker-compose -f docker-compose.dev.yml down

# 2. 初始化 Swarm
./dev.sh init

# 3. 构建镜像
./dev.sh build

# 4. 启动新环境
./dev.sh start

# 5. 查看状态
./dev.sh status

# 6. 开始开发！
```

## 📞 反馈

如有问题或建议，请：
1. 查看 [SWARM_MIGRATION.md](./SWARM_MIGRATION.md)
2. 查看 [DEVELOPMENT.md](./DEVELOPMENT.md)
3. 提交 Issue

---

**变更完成日期**: 2025-11-04  
**影响范围**: 开发环境  
**破坏性变更**: 是（需要重新初始化环境）

