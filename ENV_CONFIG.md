# 环境配置指南

本文档说明如何配置和管理 Dokploy 开发环境的环境变量。

## 📁 环境文件

### 文件位置

- **开发环境配置**: `env.development`
- **示例配置**: `env.development.example`

### 文件说明

| 文件 | 说明 | 是否提交 |
|------|------|---------|
| `env.development` | 实际使用的开发环境配置 | ❌ 否（在 .gitignore 中）|
| `env.development.example` | 配置模板和示例 | ✅ 是 |
| `.env.production` | 生产环境配置 | ✅ 是（不含敏感信息）|

## 🚀 快速开始

### 1. 创建环境文件

```bash
# 方式1: 使用脚本自动创建（推荐）
./dev.sh env

# 方式2: 手动复制示例文件
cp env.development.example env.development
```

### 2. 编辑配置

```bash
# 使用默认编辑器（vi/vim）
./dev.sh env

# 或使用指定编辑器
EDITOR=nano ./dev.sh env
EDITOR=code ./dev.sh env  # VS Code
```

### 3. 查看配置

```bash
# 查看当前配置（敏感信息会被隐藏）
./dev.sh env:show
```

### 4. 应用配置

```bash
# 启动服务（首次启动会自动挂载环境文件）
./dev.sh start

# 修改配置后，重新部署服务使更改生效
./dev.sh update dokploy
```

## 📝 配置项说明

### 应用配置

```bash
# 运行环境
NODE_ENV=development

# 应用端口（容器内）
PORT=3000
```

### 数据库配置

```bash
# PostgreSQL 连接字符串
# 注意：使用服务名 dokploy-postgres-dev，不是 localhost
DATABASE_URL=postgresql://dokploy:dokploy_dev_password@dokploy-postgres-dev:5432/dokploy
```

**重要**: 
- 容器内访问使用服务名：`dokploy-postgres-dev`
- 宿主机访问使用 localhost：`localhost:25432`

### Redis 配置

```bash
# Redis 连接字符串
# 使用服务名 dokploy-redis-dev
REDIS_URL=redis://dokploy-redis-dev:6379
```

### 认证配置

```bash
# JWT 密钥（用于 Token 生成）
JWT_SECRET=dev-secret-key-please-change-in-production

# Session 密钥
SESSION_SECRET=dev-session-secret-please-change

# 管理员初始密码
ADMIN_PASSWORD=admin123
```

**安全提示**:
- ⚠️ 这些是开发环境的默认值
- ⚠️ 生产环境务必使用强密码
- ⚠️ 不要将包含真实密码的配置提交到代码库

### 应用 URL

```bash
# 从宿主机访问的地址
APP_URL=http://localhost:23000
API_URL=http://localhost:23000/api

# 容器内访问的地址
INTERNAL_API_URL=http://localhost:3000/api
```

### 日志配置

```bash
# 日志级别: debug, info, warn, error
LOG_LEVEL=debug

# 启用详细日志
VERBOSE_LOGGING=true
```

开发环境建议使用 `debug` 级别以便排查问题。

### 开发工具配置

```bash
# 启用文件监听（热重载必需）
CHOKIDAR_USEPOLLING=true
WATCHPACK_POLLING=true

# 禁用 Next.js 遥测
NEXT_TELEMETRY_DISABLED=1
```

**说明**: 
- `CHOKIDAR_USEPOLLING` 和 `WATCHPACK_POLLING` 对于 Docker 环境的热重载至关重要
- 如果代码修改不生效，检查这两个配置是否启用

### 代理配置（可选）

```bash
# 如果需要通过代理访问网络
HTTP_PROXY=http://proxy.example.com:8080
HTTPS_PROXY=http://proxy.example.com:8080
NO_PROXY=localhost,127.0.0.1
```

### 第三方服务（可选）

#### GitHub OAuth

```bash
GITHUB_CLIENT_ID=your-github-client-id
GITHUB_CLIENT_SECRET=your-github-client-secret
GITHUB_CALLBACK_URL=http://localhost:23000/api/auth/github/callback
```

#### SMTP 邮件

```bash
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASSWORD=your-password
SMTP_FROM=noreply@dokploy.dev
```

#### S3 存储

```bash
S3_ENDPOINT=https://s3.amazonaws.com
S3_BUCKET=dokploy-dev
S3_ACCESS_KEY=your-access-key
S3_SECRET_KEY=your-secret-key
S3_REGION=us-east-1
```

## 🔧 高级用法

### 使用不同的环境文件

修改 `dev.sh` 中的 `ENV_FILE` 变量：

```bash
# 编辑 dev.sh
ENV_FILE="env.local"  # 使用 env.local 而不是 env.development
```

### 在容器内查看环境变量

```bash
# 进入容器
./dev.sh shell

# 查看所有环境变量
env

# 查看特定变量
echo $DATABASE_URL
echo $REDIS_URL
```

### 临时覆盖环境变量

如果需要临时测试不同的配置：

```bash
# 进入容器
./dev.sh shell

# 临时设置环境变量
export LOG_LEVEL=trace
export VERBOSE_LOGGING=true

# 重启应用
pnpm dokploy:dev
```

## 🐛 故障排查

### 配置不生效

```bash
# 1. 检查环境文件是否存在
ls -la env.development

# 2. 查看配置内容（敏感信息会被隐藏）
./dev.sh env:show

# 3. 重新部署服务
./dev.sh update dokploy

# 4. 查看日志确认配置是否加载
./dev.sh logs dokploy
```

### 数据库连接失败

检查数据库连接字符串：

```bash
# ❌ 错误：使用 localhost
DATABASE_URL=postgresql://dokploy:dokploy_dev_password@localhost:5432/dokploy

# ✅ 正确：使用服务名
DATABASE_URL=postgresql://dokploy:dokploy_dev_password@dokploy-postgres-dev:5432/dokploy
```

### 热重载不工作

确保以下配置已启用：

```bash
CHOKIDAR_USEPOLLING=true
WATCHPACK_POLLING=true
```

然后重新部署：

```bash
./dev.sh update dokploy
```

## 📚 环境文件管理命令

| 命令 | 说明 |
|------|------|
| `./dev.sh env` | 编辑环境配置文件 |
| `./dev.sh env:show` | 查看当前配置（隐藏敏感信息） |
| `./dev.sh update dokploy` | 应用配置更改 |

## 🔒 安全最佳实践

### 1. 不要提交敏感信息

```bash
# .gitignore 已配置忽略
env.development
.env
.env.local
```

### 2. 使用强密码

```bash
# ❌ 弱密码
ADMIN_PASSWORD=admin123
JWT_SECRET=secret

# ✅ 强密码
ADMIN_PASSWORD=Xy9#mK$pL2@nQ5vR
JWT_SECRET=$(openssl rand -hex 32)
```

### 3. 定期轮换密钥

生产环境建议定期更换 JWT_SECRET 和 SESSION_SECRET。

### 4. 区分开发和生产配置

- 开发环境：`env.development`
- 生产环境：使用环境变量或密钥管理服务

## 💡 提示

1. **首次使用**: 运行 `./dev.sh env` 自动创建配置文件
2. **修改配置**: 编辑后运行 `./dev.sh update dokploy` 使更改生效
3. **查看配置**: 使用 `./dev.sh env:show` 安全查看（敏感信息隐藏）
4. **备份配置**: 定期备份你的 `env.development` 文件
5. **团队协作**: 通过 `env.development.example` 共享配置模板

## 🔗 相关文档

- [快速开始](./QUICKSTART.dev.md)
- [开发环境指南](./DEVELOPMENT.md)
- [端口映射](./PORTS.md)

---

**更新日期**: 2025-11-04  
**相关脚本**: `dev.sh`

