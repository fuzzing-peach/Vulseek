# Docker Swarm 迁移指南

本文档说明为什么开发环境使用 Docker Swarm，以及它与 docker-compose 的区别。

## 🎯 为什么使用 Docker Swarm？

### 优势

1. **与生产环境一致**: Vulseek 生产环境使用 Docker Swarm，开发环境保持一致
2. **更好的服务管理**: 内置的服务发现和负载均衡
3. **滚动更新**: 支持零停机更新
4. **健康检查**: 自动重启失败的服务
5. **扩展能力**: 可以轻松扩展服务副本数

### 与 docker-compose 的对比

| 特性 | docker-compose | Docker Swarm |
|------|---------------|--------------|
| 用途 | 开发环境 | 开发+生产环境 |
| 服务编排 | 简单 | 高级 |
| 扩展性 | 有限 | 强大 |
| 更新方式 | 重启容器 | 滚动更新 |
| 健康检查 | 基础 | 高级 |
| 服务发现 | DNS | DNS + VIP |
| 负载均衡 | 外部 | 内置 |
| 学习曲线 | 低 | 中 |

## 📖 Docker Swarm 基础

### 初始化 Swarm

```bash
# 自动初始化（使用脚本）
./dev.sh init

# 手动初始化
docker swarm init --advertise-addr <本机IP>

# 查看 Swarm 状态
docker info | grep Swarm
```

### 核心概念

#### 1. 服务 (Service)
- 服务是 Swarm 中的基本部署单元
- 一个服务可以有多个副本（任务）
- 服务定义了容器的期望状态

```bash
# 创建服务
docker service create --name web nginx

# 查看服务
docker service ls

# 查看服务详情
docker service ps web

# 查看服务日志
docker service logs web
```

#### 2. 任务 (Task)
- 任务是服务的实例
- 每个任务对应一个容器
- Swarm 确保任务数量符合期望

```bash
# 查看服务的任务
docker service ps <service-name>

# 获取任务 ID
TASK_ID=$(docker service ps <service-name> -q | head -n1)
```

#### 3. 网络 (Network)
- Swarm 使用 overlay 网络
- 支持跨主机通信
- 内置服务发现和负载均衡

```bash
# 创建 overlay 网络
docker network create --driver overlay my-network

# 查看网络
docker network ls

# 连接服务到网络
docker service update --network-add my-network web
```

## 🔧 开发环境配置

### 服务定义

开发环境包含以下服务：

```bash
# PostgreSQL
docker service create \
  --name vulseek-postgres-dev \
  --network vulseek-dev-network \
  --publish 25432:5432 \
  --env POSTGRES_USER=vulseek \
  --mount type=volume,source=postgres_data,target=/var/lib/postgresql/data \
  postgres:16

# Redis
docker service create \
  --name vulseek-redis-dev \
  --network vulseek-dev-network \
  --publish 26379:6379 \
  --mount type=volume,source=redis_data,target=/data \
  redis:7

# Vulseek 主应用
docker service create \
  --name vulseek-dev \
  --network vulseek-dev-network \
  --publish 23000:3000 \
  --mount type=bind,source=$(pwd)/apps,target=/app/apps \
  vulseek-dev:latest

# Traefik
docker service create \
  --name vulseek-traefik-dev \
  --network vulseek-dev-network \
  --publish 20080:80 \
  --publish 28080:8080 \
  --mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock \
  traefik:v3.5.0
```

### 卷挂载

Swarm 支持两种卷挂载方式：

```bash
# 1. bind mount（用于源代码）
--mount type=bind,source=/path/on/host,target=/path/in/container

# 2. volume（用于数据持久化）
--mount type=volume,source=volume-name,target=/path/in/container
```

### 端口映射

```bash
# host 模式（推荐用于开发）
--publish published=23000,target=3000,mode=host

# ingress 模式（默认，用于生产）
--publish 23000:3000
```

## 🚀 常用操作

### 启动服务

```bash
# 使用脚本（推荐）
./dev.sh start

# 手动启动
# 1. 初始化 Swarm
./dev.sh init

# 2. 构建镜像
./dev.sh build

# 3. 启动各个服务
# (脚本会自动按顺序启动)
```

### 更新服务

```bash
# 更新服务（重新部署）
./dev.sh update vulseek

# 或手动更新
docker service update --force vulseek-dev

# 更新镜像
docker service update --image vulseek-dev:latest vulseek-dev
```

### 查看日志

```bash
# 使用脚本
./dev.sh logs vulseek

# 手动查看
# 1. 获取任务 ID
TASK_ID=$(docker service ps vulseek-dev -q | head -n1)

# 2. 获取容器 ID
CONTAINER_ID=$(docker inspect --format '{{.Status.ContainerStatus.ContainerID}}' $TASK_ID)

# 3. 查看日志
docker logs -f $CONTAINER_ID
```

### 进入容器

```bash
# 使用脚本
./dev.sh shell

# 手动进入
# 1. 获取容器 ID（同上）
TASK_ID=$(docker service ps vulseek-dev -q | head -n1)
CONTAINER_ID=$(docker inspect --format '{{.Status.ContainerStatus.ContainerID}}' $TASK_ID)

# 2. 进入容器
docker exec -it $CONTAINER_ID bash
```

### 扩展服务

```bash
# 扩展到 N 个副本
docker service scale vulseek-dev=3

# 查看扩展后的服务
docker service ps vulseek-dev
```

### 停止服务

```bash
# 使用脚本
./dev.sh stop

# 手动删除服务
docker service rm vulseek-dev
docker service rm vulseek-postgres-dev
docker service rm vulseek-redis-dev
docker service rm vulseek-traefik-dev
```

## 🔄 开发工作流

### 1. 首次启动

```bash
# 1. 初始化 Swarm
./dev.sh init

# 2. 构建镜像
./dev.sh build

# 3. 启动服务
./dev.sh start

# 4. 查看状态
./dev.sh status
```

### 2. 代码修改

```bash
# 修改代码后，更新服务
./dev.sh update vulseek

# 或者重新构建镜像后更新
./dev.sh build
./dev.sh update vulseek
```

### 3. 调试

```bash
# 查看日志
./dev.sh logs vulseek

# 进入容器
./dev.sh shell

# 在容器内调试
pnpm vulseek:dev
```

### 4. 数据库操作

```bash
# 连接数据库
./dev.sh db

# 运行迁移
./dev.sh db:migrate

# 查看数据库状态
./dev.sh shell postgres
```

## 🐛 故障排查

### 服务无法启动

```bash
# 1. 查看服务状态
docker service ps vulseek-dev

# 2. 查看服务日志
./dev.sh logs vulseek

# 3. 检查 Swarm 状态
docker info | grep Swarm

# 4. 重新初始化
./dev.sh stop
./dev.sh init
./dev.sh start
```

### 网络问题

```bash
# 查看网络
docker network ls

# 查看网络详情
docker network inspect vulseek-dev-network

# 重新创建网络
docker network rm vulseek-dev-network
docker network create --driver overlay --attachable vulseek-dev-network
```

### 卷问题

```bash
# 查看卷
docker volume ls

# 查看卷详情
docker volume inspect postgres_data

# 删除卷（⚠️ 会丢失数据）
docker volume rm postgres_data
```

### 服务更新失败

```bash
# 查看更新状态
docker service inspect vulseek-dev --pretty

# 回滚更新
docker service rollback vulseek-dev

# 强制重启
docker service update --force vulseek-dev
```

## 📚 高级主题

### 约束条件

```bash
# 只在 manager 节点运行
--constraint 'node.role==manager'

# 只在特定主机运行
--constraint 'node.hostname==my-host'
```

### 健康检查

```bash
# 定义健康检查
--health-cmd "curl -f http://localhost:3000/health || exit 1" \
--health-interval 10s \
--health-timeout 5s \
--health-retries 3
```

### 资源限制

```bash
# 限制 CPU 和内存
--reserve-cpu 0.5 \
--reserve-memory 512M \
--limit-cpu 2 \
--limit-memory 2G
```

### 更新策略

```bash
# 配置更新策略
--update-parallelism 1 \
--update-delay 10s \
--update-failure-action rollback \
--update-order stop-first
```

## 🔐 安全注意事项

1. **开发环境仅使用**: Swarm 配置为单节点模式，适合开发
2. **端口映射**: 使用 host 模式，仅监听 localhost
3. **密码安全**: 使用环境变量，不要硬编码
4. **Docker Socket**: 仅在必要时挂载

## 📖 参考资源

- [Docker Swarm 官方文档](https://docs.docker.com/engine/swarm/)
- [Docker Service 命令参考](https://docs.docker.com/engine/reference/commandline/service/)
- [Vulseek 生产安装脚本](./install.sh)

## 💡 提示

- 使用 `./dev.sh help` 查看所有可用命令
- Swarm 会自动重启失败的服务
- 代码修改后使用 `./dev.sh update` 而不是 `restart`
- 查看日志时注意任务/容器 ID 的变化

---

**问题反馈**: 如有问题，请查看 [DEVELOPMENT.md](./DEVELOPMENT.md) 或提交 Issue。

