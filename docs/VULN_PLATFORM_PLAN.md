# 漏洞挖掘自动化平台改造需求与规划（更新版）

## 1. 改造目标

将当前项目从“部署平台”重构为“GitHub 项目漏洞挖掘自动化平台”，核心是扫描任务编排、LLM Agent 挖掘、漏洞结果管理与展示。

## 2. 已确认需求（当前版本）

- 原 `DeploymentJob` 概念替换为 `ScanJob`。
- `ScanJob` 的展示与原 deployment 类似（任务列表、状态、日志、详情视图）。
- 扫描模式：
1. `delta-scan`
2. `full-scan`
- `delta-scan` 触发：
1. GitHub webhook
2. 定时任务
- `delta-scan` 扫描范围：
1. 默认只看当前 commit 改动
2. 可配置扩展为“当前 commit + 前 k 个 commit”的改动窗口
- 每个 `ScanJob` 下有一条 `VulnerabilityCandidate` 队列（候选漏洞集合），用于承载可能漏洞位置与后续验证流程。
- 当 `ScanJob` 生成 `VulnerabilityCandidate` 队列后，需要对每个 candidate 启动独立 Agent 做深度漏洞挖掘。
- `full-scan` 对全仓代码执行同样的 LLM Agent 挖掘流程。
- 引入可配置 LLM Agent（例如 Codex 或 Claude Code），支持参数：
1. `BASE_URL`
2. `model`
3. `thinking-level`
4. `token_quota`（单任务 token 上限）
- 改造过程中不以 Vulseek 原部署语义为目标能力。

## 2.1 已确认实现参数（本轮）

- 迁移策略：灰度迁移（旧部署能力与新扫描能力阶段性并存）。
- 语言范围（首期）：`C/C++`。
- `delta-scan` 的 `k`：先使用较小默认值（实现阶段先写死为常量，后续改为可配置）。
- 并发策略：先写死较小并发常量（后续支持配置化）。
- `token_quota`：按“单任务上限”生效。
- 上下文写回策略：candidate agent 只写临时区，由主 Agent 审核后合并入项目上下文目录。
- fuzzing 默认引擎：`libFuzzer`。
- 容器网络：允许联网（用于依赖安装、工具执行等）。

## 3. 核心流程（新）

### 3.1 Delta Scan

1. 触发接入（webhook/cron）。
2. 解析 commit 窗口：
- `k=0`：仅当前 commit
- `k>0`：包含前 k 个 commit
3. 生成改动集合（文件、函数、片段）。
4. 生成 `ScanJob` 与 `VulnerabilityCandidate` 队列初始项。
5. LLM Agent 对改动范围逐批挖掘，产出 `VulnerabilityCandidate`。
6. 候选点入队并进入验证/去重/归并。
7. 输出最终 findings 与任务报告。

### 3.2 Full Scan

1. 拉取仓库全量代码快照。
2. 生成 `ScanJob` 与全量 `VulnerabilityCandidate` 队列。
3. LLM Agent 分模块执行挖掘。
4. 去重、归并、状态迁移（新增/已存在/已修复/误报）。
5. 更新基线并展示结果。

### 3.3 Candidate 深挖流程（每个 `VulnerabilityCandidate`）

1. 为每个 candidate 启动独立主 Agent。
2. 主 Agent 必须优先完成：
- CodeQL 数据流分析：判断 candidate 是否可由 entry 的 untrusted input 可达。
- 约束分析：分析调用链上与漏洞触发相关的约束条件（分支条件、参数约束、状态约束等）。
3. 主 Agent 可自主调度以下 subagent（顺序可变）：
- `building subagent`：自动构建仿真驱动程序，处理 `cmake/autoconf/make/clang` 等构建配置，使驱动可运行。
- `debug subagent`：以基础输入运行程序，收集真实调用链、关键上下文、关键变量状态。
- `fuzzing subagent`：针对构建好的驱动执行 fuzzing，验证漏洞可触发性。
4. 编排约束：
- 步骤 1/2 需要靠前完成。
- 步骤 3/4/5（对应 subagent 工作）可由主 Agent 根据上下文自主安排顺序、可迭代往返。
5. 最终产物：
- candidate 验证结论（confirmed/suspected/rejected）
- 证据链（数据流路径、约束、PoC 输入、运行日志、fuzz 结果）
- 可选修复建议

## 4. 数据与队列模型（建议）

- `scan_jobs`：替代 `deployment jobs`，记录任务元信息。
- `vulnerability_candidates`：每个 `ScanJob` 的 `VulnerabilityCandidate` 队列（核心新增）。
- `scan_findings`：最终漏洞结果（可追踪到 `vulnerability_candidate` 与 commit），包含 `detail` 字段用于保存 Markdown 格式描述文档。
- `scan_baselines`：full-scan 基线快照。
- `llm_profiles`：LLM 提供方与参数配置（base_url/model/thinking/token）。
- `scan_policies`：仓库级策略（delta/full、k 值、触发策略、路径过滤）。

## 4.1 容器运行与复用策略（新增）

### 上下文目录（项目级）

- 每个项目维护一个统一的上下文目录（Project Context Directory）。
- 该目录在项目不同版本之间复用。
- 用途：
1. 保存历史运行过程中 LLM 总结的执行结果。
2. 保存可复用知识（如已验证调用链、已确认漏洞模式、已排除路径、经验规则等）。
- 所有 `ScanJob` / `VulnerabilityCandidate Agent` / `Subagent` 容器通过挂载方式访问该目录。

### A. ScanJob 容器

- 每个 `ScanJob` 在独立容器中运行。
- `ScanJob` 容器不复用，每次任务均新建容器。
- 通过挂载共享上下文目录访问项目资产。
- 任务结束后回收并删除容器。

### B. VulnerabilityCandidate Agent 容器

- 每个 candidate 的自主编排 Agent 在独立容器中运行。
- candidate 容器不复用（一次 candidate 一容器，保证隔离）。
- candidate 容器可共享上下文资产（只读或受控读写）：
1. CodeQL 数据库
2. 已收集 entry 集合
3. 已收集漏洞/bug 集合
4. 已确认无漏洞的 candidate 集合

### C. Subagent 容器（building/debug/fuzzing）

- 每个 spawn 出来的 subagent 使用独立容器执行。
- subagent 容器不复用，每次执行都启动新容器。
- 通过挂载共享上下文目录访问项目资产。
- 任务结束后回收并删除容器。

## 5. LLM Agent 执行层设计（建议）

### 5.1 Agent 抽象

- 统一 Agent 接口：`analyze(vulnerability_candidate) -> candidates/findings`
- Provider 插件化：`codex`、`claude-code`、后续可扩展

### 5.2 Agent 配置

- 全局默认 + 仓库覆盖 + 任务覆盖三层配置
- 参数最小集合：
1. provider
2. base_url
3. model
4. thinking_level
5. token_quota（兼容 token-quote）

### 5.3 执行策略

- 单点重试、超时控制、并发上限
- 大仓分片（按目录/语言/改动块）
- 成本控制（token budget、优先级队列）

### 5.4 多 Agent 编排模型（新增）

- 主 Agent：负责 candidate 的全流程决策与任务分派。
- Subagent 类型：
1. `codeql-analysis`（可并入主 Agent 前置阶段）
2. `constraint-analysis`（可并入主 Agent 前置阶段）
3. `building`
4. `debug`
5. `fuzzing`
- 建议状态机：
1. `queued`
2. `pre_analysis_running`
3. `subagents_running`
4. `evidence_aggregating`
5. `completed`
6. `failed`
- Subagent 输出统一落盘到 candidate 证据仓（artifacts），便于审计与复现。

### 5.5 容器编排约束（新增）

- `ScanJob` 层：容器级隔离，不复用。
- `VulnerabilityCandidate` 层：强隔离，不复用容器。
- `Subagent` 层：容器级隔离，不复用。
- 上下文共享采用“共享资产仓”模式，建议分层：
1. 项目层共享（CodeQL DB、历史漏洞库）
2. 版本层共享（版本特定索引、调用链缓存）
3. Candidate 层私有（临时推理状态、中间工件）
- 所有层级容器均采用“新建 -> 挂载上下文目录 -> 执行 -> 回收删除”的生命周期。
- 项目级上下文目录是跨版本知识复用的唯一长期载体。

### 5.6 Agent 与平台控制通道（新增）

- 推荐通道：`MCP`。
- 设计原则：自主编排 Agent 不直接操作 Docker/队列，仅调用 Vulseek 暴露的控制工具。
- 建议新增 `vulseek-control MCP server`，对外提供工具：
1. `spawn_subagent`
2. `update_candidate_status`
3. `append_artifact`
4. `list_candidate_tasks`
5. `cancel_candidate_task`
- MCP server 在后端转发到 Vulseek 内部控制面（API + Queue + Worker）。
- 推荐链路：
1. Agent -> MCP tool call
2. MCP server -> Vulseek 内部 API
3. 内部 API -> 任务队列（BullMQ）
4. Worker -> 启动/监控/回收容器
- 安全建议：
1. MCP 工具级鉴权（短时 token、最小权限）
2. 全量工具调用审计日志
3. 幂等键（避免重复 spawn）

## 6. 迁移策略（DeploymentJob -> ScanJob）

1. 保留现有队列与任务展示框架，替换语义与字段。
2. 保留 BullMQ 机制，队列名称可从 `deployments` 迁移为 `scans`（或双写过渡）。
3. 旧部署 API 逐步下线或兼容映射为扫描 API。
4. UI 复用现有任务页结构，替换状态文案、日志内容与详情字段。

## 7. MVP（建议）

1. 先完成 `delta-scan(push webhook)` 主链路。
2. 完成 `ScanJob + vulnerability_candidates + findings` 三表与基础 UI。
3. 先接 1 个 LLM Provider（可配置）。
4. 增加 `k` 配置并实现 commit 窗口扫描。
5. 再补 `full-scan` 与定时任务。
6. 第三阶段加入 `building/debug/fuzzing` subagent 链路与证据归档。

## 8. 待澄清问题（请确认）

1. `vulnerability_candidates` 是否需要“人工复核”状态（如 `pending_review`）？
2. webhook 事件范围是否首期只支持 `push`，还是同时支持 `pull_request`？
3. 是否要求每个 confirmed 漏洞都必须包含可复现输入（PoC）？
4. 是否需要输出“修复建议补丁”（diff）作为标准产物？

## 9. 下一步

你确认第 8 节后，我会给出第三版：
- 具体数据库 schema 草案（字段级）
- 队列任务结构（`ScanJobPayload` / `VulnerabilityCandidatePayload`）
- 子任务结构（`CandidateSubagentTaskPayload`）
- API 草案（创建任务、查询队列、触发 full/delta）
- 代码改造清单（精确到当前仓库文件级）
