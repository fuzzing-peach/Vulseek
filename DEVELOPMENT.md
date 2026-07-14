# Vulseek 开发环境指南

本文档说明如何使用 Docker Swarm 进行 Vulseek 的开发和调试。

## 🚀 快速开始

### 使用便捷脚本（推荐）

我们提供了 `dev.sh` 脚本来简化开发环境管理（基于 Docker Swarm）：

```bash
# 首次使用，添加执行权限
chmod +x dev.sh

# 初始化 Docker Swarm（首次使用）
./dev.sh init

# 构建开发镜像
./dev.sh build

# 启动开发环境（包含 PostgreSQL、Redis、Traefik）
./dev.sh start

# 查看服务状态和访问地址
./dev.sh status

# 查看日志
./dev.sh logs vulseek

# 进入容器
./dev.sh shell

# 更新服务（代码修改后）
./dev.sh update vulseek

# 停止开发环境
./dev.sh stop

# 查看所有可用命令
./dev.sh help
```

### 架构说明

开发环境使用 **Docker Swarm** 进行服务编排，具有以下优势：

- ✅ 与生产环境一致的编排方式
- ✅ 更好的服务管理和扩展能力
- ✅ 内置的负载均衡和服务发现
- ✅ 滚动更新和健康检查

**注意**: 
- 需要先初始化 Docker Swarm: `./dev.sh init`
- 代码修改后需要重新部署: `./dev.sh update vulseek`
- 或使用 `./dev.sh restart vulseek` 重启服务

## 📝 开发特性

### ✅ 已启用的功能

- **热重载（Hot Reload）**: 修改代码后自动重启
- **源代码挂载**: 在宿主机修改代码，容器内立即生效
- **调试端口**: 暴露 9229 端口用于 Node.js 调试
- **开发依赖**: 包含所有开发工具和依赖
- **Docker 访问**: 可以在容器内管理 Docker（通过 socket 挂载）
- **编辑器支持**: 内置 vim 和 nano
- **网络工具**: 包含调试用的网络和进程工具

### 🔧 服务架构

开发环境包含以下服务（与生产环境一致）：

| 服务 | 宿主机端口 | 容器端口 | 用途 |
|------|----------|---------|------|
| vulseek-dev | 23000 | 3000 | 主应用（Next.js + API） |
| vulseek-dev | 29229 | 9229 | Node.js 调试端口 |
| vulseek-dev | 25555 | 5555 | 数据库管理工具 (Drizzle Studio) |
| postgres | 25432 | 5432 | PostgreSQL 16 数据库 |
| redis | 26379 | 6379 | Redis 7 缓存服务 |
| traefik | 20080 | 80 | HTTP 反向代理 |
| traefik | 28080 | 8080 | Traefik Dashboard |

### 🌐 访问地址

- **主应用**: http://localhost:23000
- **Traefik 面板**: http://localhost:28080
- **PostgreSQL**: `localhost:25432` (用户: `vulseek`, 密码: `vulseek_dev_password`)
- **Redis**: `localhost:26379`

## 🐛 调试

### VS Code 调试配置

在 `.vscode/launch.json` 中添加：

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "attach",
      "name": "Docker: Attach to Node",
      "port": 29229,
      "address": "localhost",
      "localRoot": "${workspaceFolder}",
      "remoteRoot": "/app",
      "protocol": "inspector"
    }
  ]
}
```

### 启动调试模式

进入开发服务容器后运行：

```bash
# 进入容器
./dev.sh shell vulseek

# 使用调试模式启动（容器内的端口仍为 9229，映射到宿主机 29229）
node --inspect=0.0.0.0:9229 dist/index.js
```

## 💡 常用命令

### 使用 dev.sh 脚本

```bash
# 初始化命令
./dev.sh init           # 初始化 Docker Swarm（首次使用）
./dev.sh build          # 构建开发镜像

# 基础命令
./dev.sh start          # 启动开发环境
./dev.sh stop           # 停止开发环境
./dev.sh restart vulseek # 重启特定服务
./dev.sh update vulseek  # 更新服务（重新部署）
./dev.sh clean          # 清理服务和卷

# 日志与调试
./dev.sh logs vulseek   # 查看主应用日志
./dev.sh logs postgres  # 查看数据库日志
./dev.sh logs redis     # 查看 Redis 日志
./dev.sh shell          # 进入主容器
./dev.sh shell postgres # 进入 PostgreSQL 容器
./dev.sh status         # 查看服务状态

# 数据库操作
./dev.sh db             # 进入 PostgreSQL 命令行
./dev.sh db:migrate     # 运行数据库迁移
./dev.sh db:seed        # 填充测试数据
./dev.sh db:studio      # 启动数据库管理界面
./dev.sh redis          # 进入 Redis 命令行

# 开发工具
./dev.sh install        # 安装依赖
./dev.sh test           # 运行测试
./dev.sh lint           # 代码检查
./dev.sh format         # 格式化代码
```

### 手动命令（Docker Swarm）

```bash
# 查看所有服务
docker service ls

# 查看特定服务详情
docker service ps vulseek-dev

# 查看服务日志（需要先获取容器 ID）
TASK_ID=$(docker service ps vulseek-dev -q | head -n1)
CONTAINER_ID=$(docker inspect --format '{{.Status.ContainerStatus.ContainerID}}' $TASK_ID)
docker logs -f $CONTAINER_ID

# 进入容器
docker exec -it $CONTAINER_ID bash

# 更新服务（重新部署）
docker service update --force vulseek-dev

# 扩展服务
docker service scale vulseek-dev=2

# 删除服务
docker service rm vulseek-dev
```

## 📁 目录结构说明

```
/app/
├── apps/           # 应用代码（已挂载）
├── packages/       # 共享包（已挂载）
├── node_modules/   # 依赖（Docker 卷）
├── .next/          # Next.js 构建产物
└── data/           # 持久化数据（Docker 卷）
```

## ⚙️ 环境变量

开发环境从 `env.development` 读取环境变量。首次运行 `./dev.sh env` 时会根据 `env.development.example` 创建该文件。

```bash
# 创建或编辑开发环境变量
./dev.sh env
```

## 🔍 故障排查

### 问题：代码修改不触发热重载

**解决方案**:
```bash
# 确保环境变量已设置
CHOKIDAR_USEPOLLING=true
WATCHPACK_POLLING=true
```

### 问题：端口已被占用

**解决方案**: 使用开发环境端口变量覆盖默认值：
```bash
VULSEEK_DEV_PORT=23001 POSTGRES_DEV_PORT=25433 ./dev.sh start
```

### 问题：node_modules 权限问题

**解决方案**:
```bash
# 删除开发环境依赖卷并重新构建
./dev.sh stop
docker volume rm vulseek_dev_root_node_modules vulseek_dev_app_node_modules vulseek_dev_server_node_modules
./dev.sh build
./dev.sh start
```

### 问题：Docker socket 权限被拒绝

**解决方案**: 确保当前用户可以访问 `/var/run/docker.sock`，并确认 `dev.sh` 创建的服务已挂载该 socket。

## 🎯 生产环境 vs 开发环境

| 特性 | 生产环境 (Dockerfile) | 开发环境 (Dockerfile.dev) |
|------|---------------------|--------------------------|
| 构建优化 | ✅ 多阶段构建 | ❌ 单阶段 |
| 依赖安装 | 仅生产依赖 | 所有依赖 |
| 代码挂载 | ❌ 复制到镜像 | ✅ 卷挂载 |
| 热重载 | ❌ | ✅ |
| 调试端口 | ❌ | ✅ |
| 镜像大小 | 较小 | 较大 |
| 启动速度 | 快 | 中等 |

## 📚 扩展阅读

- [Next.js Development](https://nextjs.org/docs/advanced-features/debugging)
- [Node.js Debugging Guide](https://nodejs.org/en/docs/guides/debugging-getting-started/)
- [Docker Development Best Practices](https://docs.docker.com/develop/dev-best-practices/)
- [pnpm Workspace](https://pnpm.io/workspaces)

## 🤝 贡献

如果你在开发过程中遇到问题或有改进建议，欢迎提交 Issue 或 Pull Request。
