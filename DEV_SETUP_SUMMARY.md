# Vulseek 开发环境配置总结 📝

## 🎉 已完成的工作

本次修改为 Vulseek 项目创建了一套完整的 Docker 开发环境，让你可以方便地进行代码修改、调试和开发。

## 📦 新增文件

### 1. `Dockerfile.dev`
开发环境专用的 Dockerfile，特点：
- ✅ 基于 Node.js 20.16.0
- ✅ 安装所有开发依赖和调试工具
- ✅ 包含 vim、nano 等编辑器
- ✅ 支持 Docker-in-Docker（可以管理容器）
- ✅ 安装 Nixpacks、Railpack、Buildpacks 等构建工具
- ✅ 暴露调试端口 9229

### 2. `docker-compose.dev.yml`
开发环境编排文件，包含完整的服务栈：

#### 服务列表：
- **postgres** - PostgreSQL 16 数据库
  - 宿主机端口：25432 → 容器端口：5432
  - 用户：vulseek / vulseek_dev_password
  
- **redis** - Redis 7 缓存服务
  - 宿主机端口：26379 → 容器端口：6379
  
- **vulseek-dev** - 主应用（开发模式）
  - 宿主机端口：23000 → 容器端口：3000（主应用）
  - 宿主机端口：29229 → 容器端口：9229（调试）
  - 宿主机端口：25555 → 容器端口：5555（数据库管理）
  - 挂载源代码实现热重载
  - 访问 Docker socket
  
- **traefik** - Traefik v3.5.0 反向代理
  - 宿主机端口：20080 → 容器端口：80（HTTP）
  - 宿主机端口：28080 → 容器端口：8080（Dashboard）

#### 特性：
- ✅ 源代码卷挂载（支持热重载）
- ✅ 健康检查（数据库和缓存）
- ✅ 依赖管理（vulseek-dev 依赖于数据库服务）
- ✅ 数据持久化（使用 Docker 卷）
- ✅ 与生产环境架构一致

### 3. `dev.sh`
强大的开发环境管理脚本，提供丰富的命令：

#### 基础命令：
```bash
./dev.sh start          # 启动开发环境
./dev.sh stop           # 停止开发环境
./dev.sh restart        # 重启开发环境
./dev.sh build          # 重新构建镜像
./dev.sh clean          # 清理容器和卷
```

#### 日志与调试：
```bash
./dev.sh logs           # 查看所有服务日志
./dev.sh logs vulseek-dev  # 查看特定服务日志
./dev.sh shell          # 进入主容器
./dev.sh shell postgres # 进入数据库容器
./dev.sh status         # 查看服务状态和访问地址
```

#### 数据库操作：
```bash
./dev.sh db             # 进入 PostgreSQL 命令行
./dev.sh db:migrate     # 运行数据库迁移
./dev.sh db:seed        # 填充测试数据
./dev.sh db:studio      # 启动数据库管理界面
./dev.sh redis          # 进入 Redis 命令行
```

#### 开发工具：
```bash
./dev.sh install        # 安装依赖
./dev.sh test           # 运行测试
./dev.sh lint           # 代码检查
./dev.sh format         # 格式化代码
```

### 4. `DEVELOPMENT.md`
完整的开发环境文档，包含：
- 快速开始指南
- 服务架构说明
- VS Code 调试配置
- 常用命令参考
- 故障排查指南
- 环境变量配置
- 开发最佳实践

### 5. `QUICKSTART.dev.md`
5 分钟快速启动指南，适合新手：
- 最简化的启动步骤
- 常用命令速查
- 快速故障排查
- 开发工作流说明

### 6. `env.development.example`
开发环境配置模板，包含：
- 数据库连接配置
- Redis 配置
- JWT 和 Session 密钥
- 日志级别设置
- 构建工具版本
- 可选的第三方服务配置（SMTP、OAuth、S3）

## 🎯 主要特性

### 1. 与生产环境一致
开发环境使用与生产环境相同的服务栈：
- PostgreSQL 16
- Redis 7
- Traefik v3.5.0
- 相同的构建工具版本

### 2. 热重载支持
- 源代码挂载到容器
- 修改后自动重启
- 无需重新构建镜像

### 3. 完整的调试支持
- Node.js 调试端口（9229）
- VS Code 调试配置示例
- 详细的日志输出

### 4. 便捷的管理工具
- `dev.sh` 脚本简化所有操作
- 彩色输出，友好的用户界面
- 支持参数化命令

### 5. 数据持久化
- 使用 Docker 卷存储数据
- 容器重启数据不丢失
- 可以完全清理重新开始

## 📖 使用方法

### 快速开始（推荐新手）

```bash
# 1. 添加执行权限
chmod +x dev.sh

# 2. 启动环境
./dev.sh start

# 3. 查看状态
./dev.sh status

# 4. 访问应用
# 打开浏览器访问 http://localhost:23000
```

### 开发工作流

```bash
# 修改代码（在宿主机）
vim apps/vulseek/src/index.ts

# 查看日志（自动重载）
./dev.sh logs

# 进入容器调试
./dev.sh shell

# 运行测试
./dev.sh test

# 提交前格式化
./dev.sh format
```

### 数据库操作

```bash
# 运行迁移
./dev.sh db:migrate

# 进入数据库
./dev.sh db

# 在 psql 中执行命令
vulseek=# \dt          -- 列出所有表
vulseek=# \d users     -- 查看 users 表结构
vulseek=# SELECT * FROM users LIMIT 10;
```

## 🔧 配置说明

### 端口映射

| 宿主机端口 | 容器端口 | 服务 |
|----------|---------|------|
| 23000 | 3000 | Vulseek 主应用 |
| 29229 | 9229 | Node.js 调试 |
| 25555 | 5555 | 数据库管理工具 |
| 25432 | 5432 | PostgreSQL |
| 26379 | 6379 | Redis |
| 20080 | 80 | Traefik HTTP |
| 28080 | 8080 | Traefik Dashboard |

### 环境变量

关键环境变量（在 `docker-compose.dev.yml` 中配置）：

```yaml
# 开发模式
NODE_ENV=development

# 数据库
DATABASE_URL=postgresql://vulseek:vulseek_dev_password@postgres:5432/vulseek

# Redis
REDIS_URL=redis://redis:6379

# 热重载
CHOKIDAR_USEPOLLING=true
WATCHPACK_POLLING=true
```

### 卷挂载

```yaml
# 源代码（热重载）
- ./apps:/app/apps
- ./packages:/app/packages

# node_modules（Docker 卷，避免冲突）
- node_modules:/app/node_modules

# Docker socket（容器管理）
- /var/run/docker.sock:/var/run/docker.sock

# 持久化数据
- postgres_data:/var/lib/postgresql/data
- redis_data:/data
```

## 🆚 对比原 Dockerfile

| 特性 | 原 Dockerfile | Dockerfile.dev |
|------|--------------|----------------|
| 用途 | 生产部署 | 开发调试 |
| 构建方式 | 多阶段构建 | 单阶段 |
| 依赖 | 仅生产依赖 | 所有依赖 |
| 代码 | 复制到镜像 | 卷挂载 |
| 热重载 | ❌ | ✅ |
| 调试端口 | ❌ | ✅ |
| 数据库 | 外部服务 | Docker Compose |
| Redis | 外部服务 | Docker Compose |
| Traefik | 外部容器 | Docker Compose |
| 启动方式 | `pnpm start` | `pnpm vulseek:dev` |

## 🐛 常见问题

### 1. 端口冲突

**问题**: 启动时提示端口被占用

**解决**: 
```bash
# 检查占用端口的进程
lsof -i :23000
lsof -i :25432
lsof -i :26379

# 或修改 docker-compose.dev.yml 中的端口映射
ports:
  - "23001:3000"  # 改为其他端口
```

### 2. 权限问题

**问题**: Docker socket 权限被拒绝

**解决**: 已在 `docker-compose.dev.yml` 中设置 `privileged: true`

### 3. 热重载不工作

**问题**: 修改代码后不自动重载

**解决**: 
```bash
# 检查环境变量
./dev.sh shell
echo $CHOKIDAR_USEPOLLING
echo $WATCHPACK_POLLING

# 手动重启
./dev.sh restart
```

### 4. 数据库连接失败

**问题**: 应用无法连接数据库

**解决**: 
```bash
# 检查数据库是否启动
./dev.sh status

# 查看数据库日志
./dev.sh logs postgres

# 测试连接
./dev.sh db
```

## 📚 相关文档

- **快速开始**: [QUICKSTART.dev.md](./QUICKSTART.dev.md) - 5分钟上手指南
- **详细文档**: [DEVELOPMENT.md](./DEVELOPMENT.md) - 完整开发文档
- **配置示例**: [env.development.example](./env.development.example) - 环境变量配置
- **生产部署**: [README.md](./README.md) - 生产环境安装

## 🎓 最佳实践

### 1. 代码修改
- ✅ 在宿主机使用你喜欢的编辑器修改代码
- ✅ 容器会自动检测并重载
- ✅ 使用 `./dev.sh logs` 查看实时日志

### 2. 调试
- ✅ 使用 VS Code 的调试功能（参考 DEVELOPMENT.md）
- ✅ 或使用 `console.log` + `./dev.sh logs`
- ✅ 进入容器使用 vim/nano 快速修改

### 3. 数据库
- ✅ 使用 `./dev.sh db:migrate` 运行迁移
- ✅ 使用 `./dev.sh db:studio` 可视化管理
- ✅ 定期备份重要数据

### 4. 依赖管理
- ✅ 优先在宿主机运行 `pnpm install`
- ✅ 或在容器内运行 `./dev.sh install`
- ✅ 添加新依赖后重启容器

### 5. 清理
- ✅ 定期运行 `./dev.sh clean` 清理无用数据
- ✅ 重大更新后重新构建镜像 `./dev.sh build`

## 🚀 下一步

1. **首次启动**:
   ```bash
   chmod +x dev.sh
   ./dev.sh start
   ```

2. **配置环境**:
   ```bash
   cp env.development.example .env.development
   # 根据需要修改配置
   ```

3. **初始化数据库**:
   ```bash
   ./dev.sh db:migrate
   ./dev.sh db:seed  # 如果有种子数据
   ```

4. **开始开发**:
   ```bash
   # 修改代码
   # 查看日志
   ./dev.sh logs
   # 访问 http://localhost:3000
   ```

## 🤝 贡献

如果你发现问题或有改进建议：
1. 查看 [DEVELOPMENT.md](./DEVELOPMENT.md)
2. 提交 Issue
3. 发起 Pull Request

---

**祝你开发愉快！** 🎉

如有任何问题，请查阅相关文档或联系团队成员。

