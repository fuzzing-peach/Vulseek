# Vulseek 开发环境快速开始 🚀

> 5 分钟内启动完整的 Vulseek 开发环境（基于 Docker Swarm）

## 📋 前置要求

- Docker（支持 Swarm 模式）
- 至少 4GB 可用内存
- 端口 23000、25432、26379、20080、28080、29229、25555 未被占用
- Linux 系统或 macOS（Docker Swarm 在 Windows 上支持有限）

## ⚡ 快速启动

### 1. 给脚本添加执行权限

```bash
chmod +x dev.sh
```

### 2. 初始化 Docker Swarm

```bash
./dev.sh init
```

这将：
- ✅ 初始化 Docker Swarm
- ✅ 创建 overlay 网络
- ✅ 创建所需的数据卷

### 3. 配置环境变量

```bash
# 创建并编辑环境配置文件
./dev.sh env
```

这将：
- ✅ 自动从 `env.development.example` 创建 `env.development`
- ✅ 打开编辑器让你修改配置
- ✅ 根据需要调整数据库、Redis、密钥等配置

**提示**: 如果你使用代理，记得配置 `HTTP_PROXY` 和 `HTTPS_PROXY`

### 4. 启动开发环境

```bash
./dev.sh start
```

这将自动：
- ✅ 检查并挂载环境配置文件
- ✅ 构建开发镜像（首次启动）
- ✅ 启动 PostgreSQL 16 数据库服务
- ✅ 启动 Redis 7 缓存服务
- ✅ 启动 Vulseek 主应用（开发模式，支持热重载）
- ✅ 启动 Traefik 反向代理服务

### 4. 等待服务启动

首次启动需要构建镜像，大约需要 2-5 分钟。可以查看日志：

```bash
./dev.sh logs vulseek
```

### 4. 访问应用

```bash
./dev.sh status
```

- 🌐 主应用: http://localhost:23000
- 📊 Traefik 面板: http://localhost:28080

## 🔧 常用命令

```bash
# 初始化和配置
./dev.sh init             # 初始化 Swarm（首次使用）
./dev.sh env              # 编辑环境配置
./dev.sh env:show         # 查看环境配置

# 构建和启动
./dev.sh build            # 构建开发镜像
./dev.sh start            # 启动所有服务
./dev.sh stop             # 停止环境

# 查看状态
./dev.sh status           # 查看服务状态
./dev.sh logs vulseek     # 查看主应用日志
./dev.sh logs postgres    # 查看数据库日志

# 进入容器
./dev.sh shell            # 进入主容器
./dev.sh shell postgres   # 进入数据库容器

# 数据库操作
./dev.sh db               # 进入数据库命令行
./dev.sh db:migrate       # 运行数据库迁移
./dev.sh redis            # 进入 Redis 命令行

# 更新和重启
./dev.sh update vulseek   # 更新服务（配置修改后）
./dev.sh restart vulseek  # 重启服务

# 清理
./dev.sh clean            # 完全清理（包括数据）
```

## 📖 开发工作流

### 修改代码

1. 在宿主机上直接修改 `apps/` 和 `packages/` 目录下的代码
2. 容器会自动检测变化并重新加载（热重载）
3. 刷新浏览器查看效果

### 调试

1. 在 VS Code 中设置断点
2. 使用 F5 启动调试（需要配置 `.vscode/launch.json`）
3. 调试端口：`localhost:29229`

### 数据库操作

```bash
# 查看数据库
./dev.sh db

# 运行迁移
./dev.sh db:migrate

# 启动数据库管理界面
./dev.sh db:studio
```

### 查看 Redis

```bash
./dev.sh redis
```

## 🐛 故障排查

### 端口被占用

如果提示端口被占用，检查：

```bash
# Linux/Mac
lsof -i :23000
lsof -i :25432
lsof -i :26379

# 或通过 VULSEEK_DEV_PORT、POSTGRES_DEV_PORT、REDIS_DEV_PORT 覆盖默认端口
```

### 服务启动失败

```bash
# 查看服务状态
./dev.sh status

# 查看具体服务日志
./dev.sh logs vulseek
./dev.sh logs postgres

# 重新构建并启动
./dev.sh stop
./dev.sh build
./dev.sh start
```

### Swarm 未初始化

```bash
# 初始化 Swarm
./dev.sh init
```

### 代码修改不生效

```bash
# 方式1：更新服务（推荐）
./dev.sh update vulseek

# 方式2：重启服务
./dev.sh restart vulseek

# 方式3：进入容器查看
./dev.sh shell
```

## 📚 更多信息

- 完整开发文档: [DEVELOPMENT.md](./DEVELOPMENT.md)
- 环境配置: [env.development.example](./env.development.example)
- 生产部署: [README.md](./README.md)

## 🎯 下一步

1. **初始化 Swarm**: `./dev.sh init`（首次使用）
2. **配置环境**: `./dev.sh env`（创建并编辑环境文件）
3. **构建镜像**: `./dev.sh build`（首次或代码更新后）
4. **启动服务**: `./dev.sh start`（自动挂载环境文件）
5. **运行数据库迁移**: `./dev.sh db:migrate`
6. **开始开发**: 修改代码，使用 `./dev.sh update vulseek` 重新部署！

### 环境配置说明

- 配置文件位置: `env.development`
- 配置模板: `env.development.example`
- 详细文档: [ENV_CONFIG.md](./ENV_CONFIG.md)

## 💡 提示

- 使用 `./dev.sh help` 查看所有可用命令
- 开发环境使用 Docker Swarm 进行服务编排
- 开发环境数据会持久化在 Docker 卷中
- 使用 `./dev.sh clean` 可以完全重置环境
- 代码修改后使用 `./dev.sh update vulseek` 快速重新部署

---

**祝开发愉快！** 🎉

如有问题，请查看 [DEVELOPMENT.md](./DEVELOPMENT.md) 或提交 Issue。
