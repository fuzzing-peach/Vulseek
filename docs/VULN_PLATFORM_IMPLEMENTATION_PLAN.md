# 漏洞挖掘平台实施方案（含测试）

## 1. 范围说明

本方案用于将当前项目改造为“GitHub 项目漏洞挖掘自动化平台”，核心对象为：
- `ScanJob`
- `VulnerabilityCandidate`
- 主 Agent 与 Subagent（building/debug/fuzzing）
- MCP 控制通道
- 容器化执行与上下文目录复用

本方案**不包含旧部署功能（Vulseek 原语义）的测试**。

## 1.1 实施约束（必须遵守）

- 实施采用“增量扩展”模式：
1. 先添加新功能和新组件。
2. 不覆盖现有组件与现有逻辑。
3. 不删除现有功能与现有模块。
- 新旧能力并存，通过新路由/新命名空间/特性开关进行灰度接入。

## 2. 总体实施阶段

建议分 6 个阶段实施，每阶段都可独立验收。

---

## Phase 1：核心模型与扫描任务主链路

### 目标

完成 `ScanJob` 和 `VulnerabilityCandidate` 的基础数据/队列/接口能力，打通 delta/full 的任务创建。

### 交付组件

1. 数据模型
- `scan_jobs`
- `vulnerability_candidates`
- `scan_findings`（基础字段，新增 `detail` 用于保存 Markdown 描述文档）

2. 任务触发
- `delta-scan`（支持当前 commit + 前 `k` 个 commit）
- `full-scan`（手动触发）

3. 任务队列
- `scans` 主队列
- 基础状态机：`queued/running/completed/failed`

4. 基础 API
- 创建 scanjob
- 查询 scanjob 列表/详情
- 查询 candidate 列表

### 测试

1. 单元测试
- commit 窗口解析逻辑（`k` 默认值、边界值）
- scanjob/candidate 状态迁移函数

2. 集成测试
- webhook -> scanjob 入库 -> candidate 生成
- full-scan API -> scanjob 入队

3. API 测试
- 创建/查询接口的鉴权、参数校验、幂等性

4. 数据一致性测试
- scanjob 与 candidate 关联完整性

---

## Phase 2：容器执行基座与上下文目录

### 目标

实现统一容器生命周期（新建、挂载、执行、回收删除），并接入项目级上下文目录。

### 交付组件

1. 容器生命周期管理器
- `create -> mount context -> run -> collect -> delete`

2. 上下文目录管理
- 每项目一个 context 目录
- 跨版本复用
- 临时区与主区分离

3. 执行器抽象
- ScanJob Executor
- Candidate Executor
- Subagent Executor（先留接口）

### 测试

1. 生命周期测试
- 容器正常结束后自动删除
- 异常退出后强制清理

2. 挂载测试
- 上下文目录可读写权限正确
- 临时区与主区隔离正确

3. 资源限制测试
- 超时、内存限制、并发上限

4. 稳定性测试
- 连续运行 N 次任务无残留容器/残留挂载

---

## Phase 3：MCP 控制面

### 目标

实现 Agent 调 Vulseek 的标准控制通道（MCP），用于 spawn subagent 与状态上报。

### 交付组件

1. `vulseek-control` MCP Server
- `spawn_subagent`
- `update_candidate_status`
- `append_artifact`
- `list_candidate_tasks`
- `cancel_candidate_task`

2. MCP -> 内部 API -> Queue 转发链路

3. 审计能力
- 工具调用日志
- 请求来源与幂等键记录

### 测试

1. MCP 契约测试
- tool schema、参数校验、错误码

2. 安全测试
- 鉴权失效、越权调用、重复调用幂等

3. 链路测试
- MCP 调用后任务成功入队并可消费

---

## Phase 4：Candidate 主 Agent（前置分析）

### 目标

实现每个 `VulnerabilityCandidate` 的独立主 Agent，优先完成 CodeQL + 约束分析。

### 交付组件

1. Candidate 主 Agent Runner
- 每 candidate 一容器
- 不复用

2. 前置分析能力
- CodeQL 数据流可达性分析
- 约束条件抽取（触发路径相关）

3. 结果写回机制
- 仅写临时区
- 主 Agent 审核后合并到项目上下文目录

### 测试

1. 功能测试
- candidate 触发后确实执行 CodeQL 与约束分析

2. 准确性测试
- 已知样例下可达性判断正确率

3. 写回流程测试
- 临时区写入成功
- 审核合并成功/拒绝分支正确

4. 回归测试
- 不同项目/版本隔离性

---

## Phase 5：Subagent 深挖（building/debug/fuzzing）

### 目标

实现 subagent 任务编排，支持动态顺序，默认 fuzz 引擎为 `libFuzzer`。

### 交付组件

1. `CandidateSubagentTask` 队列

2. Building Subagent
- 支持 `cmake/autoconf/make/clang`
- 自动构建驱动程序

3. Debug Subagent
- 基础输入执行
- 采集调用链、上下文、关键变量

4. Fuzzing Subagent
- `libFuzzer` 默认接入
- 崩溃样本与日志归档

5. 主 Agent 编排器
- 1/2 前置后，3/4/5 动态顺序调度

### 测试

1. Building 测试
- 多构建系统样例可成功产出可执行驱动

2. Debug 测试
- 调用链与关键变量采集结果完整性

3. Fuzzing 测试
- 基础 fuzz 可运行
- crash 样本可保存

4. 编排测试
- 动态顺序可执行
- 失败重试与超时中断正确

---

## Phase 6：端到端验收与灰度上线

### 目标

完成整链路验收并灰度上线，启用小并发常量和单任务 token_quota 控制。

### 交付组件

1. E2E 工作流
- webhook delta-scan -> candidate -> 主Agent -> subagent -> findings
- full-scan 同链路

2. 运行参数
- 小并发常量（后续可配置）
- 单任务 token_quota

3. 可观测性
- scanjob/candidate/subagent 全链路日志
- 队列积压与失败告警

### 测试

1. E2E 测试
- 从触发到 findings 出具全流程自动化测试

2. 压力测试
- 小并发下持续运行稳定性

3. 故障注入测试
- 队列中断、容器异常退出、工具超时恢复

4. 灰度验证
- 新链路按项目白名单启用
- 可快速回滚到“仅任务创建不执行”模式

---

## 3. 测试策略总览

### 测试分层

1. 单元测试：算法与状态机
2. 集成测试：API/队列/容器/数据库
3. 端到端测试：真实扫描链路
4. 稳定性测试：长时间运行与故障恢复

### 测试基线

- 所有新模块最低覆盖率建议：`>=70%`（单元+集成）
- 关键链路必须有 E2E 用例：
1. delta-scan（k=默认值）
2. full-scan
3. Candidate 深挖 + subagent 编排

### 验收标准（最小）

1. 能稳定创建并执行 `ScanJob`
2. 能生成并消费 `VulnerabilityCandidate`
3. 能通过 MCP 触发 subagent
4. 能产出可追溯 findings 与证据链
5. 任务结束后容器可回收删除，无明显资源泄漏
