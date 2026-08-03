# Pipeline Runner

> 从 Vulseek 中抽取 pipeline 执行机构，重构为独立的、与 Vulseek 后端解耦的 pipeline 执行引擎。

## 概述

Pipeline Runner 是一个独立的 HTTP server，负责执行 YAML 定义的 DAG/有环 pipeline。它不依赖 Vulseek 的数据库、tRPC、Next.js 或任何 Vulseek 内部包——只通过 HTTP/SSE 与上层交互。

```
Vulseek backend ──(HTTP/SSE)── pipeline-runner ──(ACP)── codex / claude code agent
                                       │
                                       ├── docker containers
                                       └── sandbox containers
```

---

## 1. 运行时概念

### Job

一次 pipeline 执行的完整生命周期。用户提交一份 pipeline 定义 + 上下文数据，创建为一个 Job。

| 属性 | 说明 |
|------|------|
| `jobId` | 全局唯一标识 |
| `pipeline` | YAML 定义的 pipeline 结构 |
| `context` | 用户传入的上下文（仓库路径、goal spec 等） |
| `status` | `pending` → `running` → `completed` / `failed` / `cancelled` |
| `progress` | 当前 stage 进度、task 完成数 |
| `metrics` | 聚合的 token 消耗、资源占用 |
| `result` | 最终输出（finding report 或 clean-scan 报告） |

操作：submit / get status（快照）/ stream events（SSE）/ cancel。

### Task

Job 中某个 stage 的一次执行实例。如果是 `fanOut` stage，一个 stage 可能有 N 个 Task（每个 fanOut item 一个）。

| 属性 | 说明 |
|------|------|
| `taskId` | 全局唯一标识 |
| `jobId` | 所属 Job |
| `stage` | 对应的 stage name |
| `item` | fanOut 的迭代项（非 fanOut 时为空） |
| `status` | `pending` → `running` → `completed` / `failed` / `cancelled` |
| `attempt` | 当前重试次数 |
| `input` | stage 收到的输入（由 edge input mapping 决定） |
| `output` | stage 产出（文件路径或结构化 JSON） |
| `metrics` | 当前 task 的 token 消耗 |
| `duration` | 运行时长 |

### Stage

Pipeline 中的一个节点，定义在 YAML 中。包含执行配置（prompt、model、mode、concurrency、timeout、retry）和契约（input/output schema）。

### Edge

连接两个 stage 的有向边。定义在 YAML 中。控制数据如何从上游流到下游：路由条件（route）、扇出（fanOut）、输入映射（input mapping）、文件传递（artifacts）。

---

## 2. 状态机

### Job 状态机

```
                    ┌─────────┐
                    │ pending │
                    └────┬────┘
                         │ submit
                         ▼
                    ┌─────────┐
              ┌─────│ running │─────┐
              │     └────┬────┘     │
              │          │          │
              │ cancel   │ finish   │ fatal error
              │          │          │
              ▼          ▼          ▼
         ┌──────────┐ ┌───────────┐ ┌───────┐
         │cancelled │ │ completed │ │ failed│
         └──────────┘ └───────────┘ └───────┘
```

| 状态 | 说明 | 可进入的状态 |
|------|------|-------------|
| `pending` | 已提交，等待执行 | `running`, `cancelled` |
| `running` | 至少一个 task 在执行 | `completed`, `failed`, `cancelled` |
| `completed` | 所有 stage 正常结束 | —（终态） |
| `failed` | 发生不可恢复的错误 | —（终态） |
| `cancelled` | 用户取消 | —（终态） |

**取消逻辑：**
- `pending` → 直接标记 `cancelled`，不执行任何 task
- `running` → 向所有活跃 task 发 cancel 信号 → 等待 task 终止 → 标记 `cancelled`
- 取消是不可逆的——不能 resume 回 `running`

### Task 状态机

```
                    ┌─────────┐
                    │ pending │
                    └────┬────┘
                         │ dispatch (入队)
                         ▼
                    ┌─────────┐
              ┌─────│ running │◄──────── retry ────────┐
              │     └────┬────┘                        │
              │          │                             │
              │ cancel   ├─── complete ───► ┌───────────┐
              │          │                  │ completed │
              │          │                  └───────────┘
              │          │
              │          ├─── error ──────► ┌───────┐
              ▼          │   + retryable    │retrying│
         ┌──────────┐    │                  └───┬───┘
         │cancelled │    │                      │ backoff 后重入 queue
         └──────────┘    │
                         ├─── fatal ──────► ┌───────┐
                         │                  │ failed │
                         │                  └───────┘
                         │
                         ├─── timeout ────► (同 error 分支)
                         │
                         └─── exhausted ──► ┌───────────┐
                                            │ exhausted │
                                            └───────────┘
```

| 状态 | 说明 | 可进入的状态 |
|------|------|-------------|
| `pending` | 上游 task 完成，下游 task 已创建但未入队 | `running`, `cancelled` |
| `running` | agent/executor 正在执行 | `completed`, `retrying`, `failed`, `exhausted`, `cancelled` |
| `completed` | 正常产出 output | —（终态） |
| `retrying` | 发生可重试错误，等待 backoff | `running`, `failed`（重试次数耗尽） |
| `failed` | 不可恢复错误或重试耗尽 | —（终态） |
| `exhausted` | persistent agent 主动声明此面耗尽 | —（终态） |
| `cancelled` | job 取消导致 task 被终止 | —（终态） |

**重试决策：**

```
task 报错
  │
  ├── error 类型在 retry.on 列表中？
  │   ├── 是 → attempt < maxAttempts？
  │   │   ├── 是 → backoff → 重新 dispatch → running
  │   │   └── 否 → failed
  │   └── 否 → failed
```

**exhausted vs failed：**

`exhausted` 是 persistent agent 的**正常终态**——agent 在 session 中收敛到结论"这个方向没有漏洞"。不是错误，不触发重试。`failed` 是异常终止（agent 崩溃、API 不可达、timeout）。

**并发和排队：**

fanOut 产生的 N 个 task 共享 stage 的 `concurrency` 槽位。第 N+1 个 task 在 queue 中 `pending` 等待，前面有 task 完成后自动入队。

---

## 3. 事件循环

pipeline-runner 核心采用 **event loop 模式**执行 pipeline：task 完成时触发 router 匹配 edge、创建下游 task、入队执行，形成闭环。persistent stage 的 back edge 重入通过 wake-up 协议复用已有容器，不创建新 task。

每个 stage 独立配置并发上限，全局 worker pool 统一消费 BullMQ 队列。Job 级别的超时和 cancel 作为事件注入 event loop，优雅终止所有活跃 task。

---

## 4. YAML 定义 Pipeline

### 顶层结构

```yaml
pipeline-name:
  name: human-readable-name
  root: stage-name              # 入口 stage
  stages:                       # 所有 stage 列表
    - stage-a
    - stage-b
  edges:                        # 所有 edge 列表
    - edge-a
    - edge-b
  groups: []                    # 可选，UI 分组
```

### Stage 定义

```yaml
stage-name:
  name: Human Readable Name
  group: group-name             # UI 分组
  disableable: true             # 是否可通过 runtime setting 关闭
  description: "..."

  mode: prompt | persistent | job-daemon

  modelProfile: profile-name    # 引用全局 model profile

  timeout: 3600                 # 超时秒数（persistent/job-daemon 必填）
  retry:
    maxAttempts: 3
    backoff: exponential | fixed
    on: [timeout, agent_error]  # 什么错误可重试

  runtimeConfig:
    concurrency: 4                # 并发数（fanOut 时有效）
    promptFile: stage-name.prompt.md
    cwd: /workspace/repo

  inputSchema:                  # Zod/JSON Schema
    $ref: "#/schemas/StageInput"

  outputSchema:
    $ref: "#/schemas/StageOutput"
```

### Edge 定义

```yaml
- name: stage-a-to-stage-b
  from: stage-a
  to: stage-b
  mode: map | fanOut

  # fanOut 时：遍历哪个数组
  foreach: "$.items[*]"

  # 路由：基于上游 output 的某个字段决定是否走这条边
  route:
    key: candidate              # output.routeKey === "candidate" 时走这条边
    default: true               # 是否是默认路由

  # 输入映射：告诉下游 stage "你的输入值是什么"
  input:
    repositoryPath: "$input.repositoryPath"   # 从上游 input 透传
    modulePath: "$.module"                    # 从上游 output 取值
    candidatePath: "$item"                    # fanOut 当前迭代项

  # 文件传递：把上游产出的文件拷贝到下游 task 目录
  artifacts:
    - from: "$output.analysisPath"            # 上游文件路径
      to: inputs/analysis.json                # 拷贝目标路径
      inputField: analysisPath                # 对应 input 中的字段名
```

### Edge 模式

| 模式 | 说明 |
|------|------|
| `map` | 1:1，一个上游 task 完成 → 触发一个下游 task |
| `fanOut` | 1:N，上游输出一个数组 → 每个元素触发一个下游 task，受 `concurrency` 限制 |
| `fanIn` | 暂不实现 |

### 路由

Edge 的 `route.key` 匹配上游 output 中的 `routeKey` 字段。一个 stage 可以有多条出边，每个 task 结束时根据 output 的 routeKey 选择匹配的边。没有匹配时走 `default: true` 的边。没有任何边匹配时 task 结果丢弃（dead end）。

### 环

允许通过 edge 形成环（如 `goal-hunt` → `goal-surface`）。环的终止不靠路由框架保证，而是靠 stage 内部的逻辑——agent 在 persistent session 中自己判断何时声明耗尽。框架层面的兜底是 Job 级别的 `timeout`。

### Schema Contracts

共享 schema 定义在 `schemas/` 目录下，通过 `$ref: "#/schemas/SchemaName"` 引用。支持 `$file()` 从文件内容读取字段值。

---

## 5. Stage Mode

| mode | 容器行为 | agent 行为 | 适用场景 |
|------|---------|-----------|---------|
| `prompt` | 单次执行，执行完销毁 | 单轮 prompt → 产出 output → 结束 | `goal-craft`, `goal-judge`, `goal-dedup` |
| `persistent` | 容器持续存活，跨多轮 | 多轮迭代，上下文完整保留。Agent 自主决定继续/换方法/声明完成 | `goal-surface`, `goal-hunt` |
| `job-daemon` | 容器持续存活，被动唤醒 | 等待外部事件触发（如新文件到达、定时唤醒），适合长时间看守型任务 | 暂预留，未在 TOB pipeline 中使用 |

---

## 6. Executor

| executor | agent 运行位置 | 文件隔离 | 适用场景 |
|----------|---------------|:---:|------|
| 本地 | 当前进程 | ✗ | 开发调试 |
| docker | 独立容器 | ✓ | 生产环境，单机 |
| sandbox | 独立沙箱容器 | ✓（更严格） | 安全隔离要求高的场景 |

executor 是可插拔的。由 stage 的 `runtimeConfig` 中的配置决定用哪个 executor。

---

## 7. Agent CLI

通过 **[ACP (Agent Communication Protocol)](https://agentclientprotocol.com/)** 对接 agent CLI：

| CLI | 通过 ACP 对接 | session/fork 支持 | auth |
|-----|:---:|:---:|------|
| Codex | ✓ | ✓ | `host_home`（本地认证）/ `api_key` |
| Claude Code | ✓ | ✓ | `api_key` / `host_home` |

ACP 层抽象了 agent 的 session 管理、fork、tool call 协议。pipeline-runner 不直接调 CLI 命令，通过 ACP SDK 与 agent 通信。

---

## 8. Model Profile

```yaml
modelProfiles:
  default:
    provider: anthropic
    name: claude-sonnet-5
    baseUrl: https://api.anthropic.com
    key: ${ANTHROPIC_API_KEY}         # 环境变量注入
    thinkingLevel: medium
    pricingProvider: anthropic         # 用于 token 成本计算

  judge-a:
    provider: anthropic
    name: claude-opus-4-8
    baseUrl: https://api.anthropic.com
    key: ${ANTHROPIC_API_KEY}
    thinkingLevel: high
    pricingProvider: anthropic

  judge-b:
    provider: openai
    name: gpt-5.1
    baseUrl: https://api.openai.com
    key: ${OPENAI_API_KEY}
    thinkingLevel: xhigh
    pricingProvider: openai
```

每个 stage 通过 `modelProfile: profile-name` 引用。未指定时用 `default`。

---

## 9. 状态持久化

Job 和 Task 是带类型的结构化对象，通过统一持久化接口做增删改查，后端可配置：

```typescript
interface JobStore {
  create(job: Job): Promise<void>;
  get(jobId: string): Promise<Job>;
  update(jobId: string, patch: Partial<Job>): Promise<void>;
  delete(jobId: string): Promise<void>;
}

interface TaskStore {
  create(task: Task): Promise<void>;
  get(taskId: string): Promise<Task>;
  listByJob(jobId: string): Promise<Task[]>;
  update(taskId: string, patch: Partial<Task>): Promise<void>;
  delete(taskId: string): Promise<void>;
}
```

所有后端实现同一接口，event loop 和 router 不感知具体存储。

| 后端 | 适用场景 |
|------|---------|
| PostgreSQL | 生产环境，多 worker 共享状态，支持查询和恢复 |
| 文件（JSON） | 单机开发调试，零依赖启动 |

与 Vulseek 解耦——runner 维护自己的 schema。

### 非结构化产物

Agent 产出的 JSON、报告、日志通过文件系统存储，每个 task 独立目录：

```
/task/
  inputs/           # edge artifacts 拷贝进来的文件
  outputs/          # agent 产出的 JSON
  reports/          # markdown 报告
  workspace/        # agent 的工作目录
```

---

## 10. Queue

内部通过统一队列接口调度 task 执行，后端可配置：

```yaml
# queue.yaml
queue:
  backend: bullmq

  bullmq:
    redis:
      host: ${REDIS_HOST}
      port: 6379
      password: ${REDIS_PASSWORD}

  # 开发环境
  # backend: memory
```

### 统一接口

所有后端实现同一个 `TaskQueue` 接口，event loop 不感知具体后端：

```typescript
interface TaskQueue {
  /** 将 task 加入队列，等待 worker 消费 */
  enqueue(task: TaskHandle): Promise<void>;

  /** 注册消费者：队列有 task 时回调 executor */
  consume(handler: (task: TaskHandle) => Promise<void>): Promise<void>;

  /** 暂停队列（cancel 时不再接受新 task） */
  pause(): Promise<void>;

  /** 等待所有活跃 task 完成 */
  drain(): Promise<void>;
}
```

### 后端对照

| 后端 | 依赖 | 持久化 | 适用场景 |
|------|------|:---:|------|
| `bullmq` | Redis | ✓ | 生产，多 worker 共享 |
| `memory` | 无 | ✗ | 开发调试，单进程 |

---

### MCP Server

pipeline-runner 对外暴露为一个 MCP server，提供以下 tools：

| tool | 说明 |
|------|------|
| `submit_pipeline` | 提交一份 pipeline 定义 + context，返回 runId |
| `get_run_status` | 获取某个 run 的当前状态快照 |
| `cancel_run` | 取消某个 run |

这样外部系统可以通过 MCP 协议（而不仅仅是 HTTP）来驱动 pipeline-runner。

---

## 11. CLI + TUI

pipeline-runner 支持命令行启动和 TUI 监控。

### CLI

```bash
# 直接运行一个 pipeline（单次执行，开发调试用）
pipeline-runner run --pipeline ./pipeline.yaml --context ./context.json

# 启动 HTTP server 模式
pipeline-runner serve --config ./config/

# 查看当前运行的 job 列表
pipeline-runner list
```

### TUI

`pipeline-runner serve` 启动时附带一个 TUI 面板，展示实时运行状态：

```
┌── Pipeline Runner ───────────────────────────────────────────┐
│  Server: :4200    Jobs: 2 running   Uptime: 3h 12m          │
│──────────────────────────────────────────────────────────────│
│  Job: run_abc123 (tob-goal)          status: running          │
│  │  goal-craft          completed    45s                     │
│  │  goal-surface        running      3m 12s                  │
│  │  goal-hunt           running      4 / 8 tasks             │
│  │    ├ surf-A          running      2m 05s                  │
│  │    ├ surf-B          running      1m 48s                  │
│  │    ├ surf-C          completed    45s                     │
│  │    └ surf-D          pending                              │
│  │  goal-judge          pending                              │
│  │  goal-dedup          pending                              │
│  │  goal-report         pending                              │
│  │───────────────────────────────────────────────────────────│
│  │  Tokens: 156k in / 38k out    CPU: 2.1    Mem: 3.2GiB    │
│──────────────────────────────────────────────────────────────│
│  Queue lengths: scans=8  verifications=0  reports=0          │
│  Workers idle: 2 / 12                                         │
└──────────────────────────────────────────────────────────────┘
```

TUI 通过 runner 内部的事件流渲染，和 SSE 是同一数据源。

---

## 12. Observability

### HTTP + SSE

```
POST   /pipelines                    提交 pipeline → runId
GET    /pipelines/:runId             当前状态快照（全量）
GET    /pipelines/:runId/events      SSE 事件流（增量）
POST   /pipelines/:runId/cancel      取消
```

### 事件类型

| 事件 | 粒度 | 说明 |
|------|------|------|
| `pipeline-start` | Job | pipeline 开始执行 |
| `pipeline-complete` | Job | pipeline 成功结束 |
| `pipeline-error` | Job | pipeline 失败 |
| `pipeline-cancelled` | Job | pipeline 被取消 |
| `stage-start` | Task | 一个 task 开始执行 |
| `stage-complete` | Task | 一个 task 完成 |
| `stage-error` | Task | 一个 task 失败 |
| `stage-retry` | Task | 一个 task 重试 |
| `route` | Edge | 路由决策（哪个 task 通过哪条边到了哪里） |
| `metric-snapshot` | — | 定时推送（每 10s）token/资源指标 |

### 指标

| 指标 | 来源 | 条件 |
|------|------|------|
| token (input/output/total) | ACP SDK session stats | 所有 executor |
| token (per-stage) | stage start/end diff | 所有 executor |
| CPU / memory / disk | docker stats / cgroup | docker/sandbox executor |

资源指标是 executor-dependent 的——本地运行时可能为 null。

### 断线重连

SSE 支持 `?since=<timestamp>` 参数，客户端重连后可以补拉丢失的事件。

---

## 13. 配置

pipeline-runner 的配置按模块拆分为独立文件，统一放在 `config/` 目录。启动时合并所有文件。只写当前生效的值，不写注释或备选方案。

### persistence.yaml

```yaml
persistence:
  backend: postgres
  postgres:
    url: ${DATABASE_URL}
```

### executor.yaml

```yaml
executor:
  default: docker
  docker:
    socketPath: /var/run/docker.sock
```

### queue.yaml

```yaml
queue:
  backend: bullmq
  bullmq:
    redis:
      host: ${REDIS_HOST}
      port: 6379
      password: ${REDIS_PASSWORD}
```

### model-profiles.yaml

```yaml
modelProfiles:
  default:
    provider: anthropic
    name: claude-sonnet-5
    baseUrl: https://api.anthropic.com
    key: ${ANTHROPIC_API_KEY}
    thinkingLevel: medium
    pricingProvider: anthropic
```

### server.yaml

```yaml
server:
  host: "0.0.0.0"
  port: 4200
```

---

## 14. 文件结构（建议）

```
pipeline-runner/
  src/
    server.ts              # HTTP server 入口
    bus/
      observability.ts      # ObservabilityBus + SSE sink
    pipeline/
      loader.ts             # YAML loader + Zod 校验
      runner.ts             # DAG executor
      state-machine.ts      # Job/Task 状态机
    executor/
      local.ts              # 本地运行
      docker.ts             # Docker 容器运行
      sandbox.ts            # Sandbox 容器运行
    agent/
      acp-client.ts         # ACP SDK 封装
      model-profile.ts      # Model profile 解析
    persistence/
      pg.ts                 # PostgreSQL 连接 + Drizzle schema
      files.ts              # Task 目录管理
    queue/
      bullmq.ts             # BullMQ worker 管理
      mcp-server.ts         # MCP server tools
    api/
      routes.ts             # HTTP + SSE 路由
    schemas/                # Zod schemas
    types/                  # TypeScript types
```

---

## 15. 与 Vulseek 交互

```
Vulseek frontend ←─(tRPC/WS)── Vulseek backend ──(HTTP/SSE)── pipeline-runner
```

1. Vulseek 后端组装 pipeline YAML + context
2. POST 到 pipeline-runner，拿到 `runId`
3. 存 `runId` 到 Vulseek 的 `scan_jobs` 表
4. 订阅 SSE 流，转发给 Vulseek 前端
5. Run 结束后，拉取最终产物写入 Vulseek DB
