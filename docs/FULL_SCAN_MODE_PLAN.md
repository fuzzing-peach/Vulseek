# Full Scan 模式规划

## 1. 目标

新增一个与 `Delta Scan` 并列的扫描模式：`Full Scan`。

它的目标是：

- 对代码仓库的最新版本做全量漏洞扫描
- 不依赖最近代码提交或差异范围
- 面向整个仓库寻找潜在漏洞点，并产出 `VulnerabilityCandidate`
- 在现有平台中复用 `ScanJob -> Analysis -> Verify` 三阶段流水线

该模式的核心定位是：

- `Delta Scan` 负责“变更驱动”的快速增量排查
- `Full Scan` 负责“全仓库驱动”的系统性深度扫描

## 2. 基本流程

### 2.1 Scan 阶段

`Full Scan` 的 `scan` 阶段运行在最新代码版本上，面向整个仓库工作。

主要职责：

1. 拉取仓库最新版本并 checkout 到目标分支/标签对应的最新代码
2. 先由一个主 agent 做轻量仓库分析，建立模块划分方案
3. 按模块启动多个 scan subagent，对各自模块做安全敏感度筛查
4. 由主 agent 回收所有 subagent 结果，做轻量整理、跨模块关联和去重
5. 由主 agent 统一通过 `VULSEEK_EVENT` 上报 `VulnerabilityCandidate`
6. 输出 full scan 报告、模块划分方案、subagent 扫描结果与原始日志

输出：

- `ScanJob`
- `VulnerabilityCandidate[]`
- module assignment plan
- `03_codex_report.md`
- scanning JSON-RPC / text / stderr 原始日志

### 2.2 Analysis 阶段

对 `scan` 产出的每个 `VulnerabilityCandidate` 启动独立 analysis agent。

主要职责：

1. 理解 candidate 所属的组件、场景、攻击面、入口
2. 用 CodeQL / semgrep / grep / 手工路径追踪分析可达性
3. 找出从 untrusted input 到 candidate 的数据流和控制流路径
4. 收集约束条件、状态条件、协议阶段条件、生命周期条件
5. 判断 candidate 属于：
   - `real_vulnerability`
   - `likely_vulnerability`
   - `plausible_but_unproven`
   - `false_positive`
6. 写入 analysis 报告并通过 `analysis_result` 事件回传

输出：

- `analysis_results`
- candidate analysis 报告
- analysis JSON-RPC / text / stderr 原始日志

### 2.3 Verify 阶段

对 analysis 认为值得继续验证的 candidate 自动启动 verifier。

建议默认只对以下 analysis 结果进入 verify：

- `real_vulnerability`
- `likely_vulnerability`

主要职责：

1. 复核 analysis 结论是否成立
2. 判断是否属于 API misuse / false positive
3. 检查是否已有历史 PR / issue / CVE / 已修复但未合并分支
4. 评估漏洞是否为 0day
5. 评估攻击面、触发条件、CVSS 维度、维护者可能态度
6. 生成验证产物：
   - `01_verify_report.md`
   - `02_issue_draft.md`
   - `03_poc/...`
   - `04_repro/Dockerfile`
   - `04_repro/run.sh`
7. 通过 `verification_result` 回传结构化结论

输出：

- `verification_results`
- verify 报告、PoC、repro 环境

## 3. 与 Delta Scan 的主要差异

### Delta Scan

- 输入是最新 commit 及其前 `k` 个 commit
- 关注代码改动带来的新风险
- 倾向于高召回地提取变更相关 candidate

### Full Scan

- 输入是仓库最新完整代码树
- 关注全仓所有可能漏洞点
- 不依赖 commit 差异
- 更强调分层遍历、规则化扫描、全局模式发现和高价值路径收敛

## 4. Full Scan 的 Scan 策略

`Full Scan` 的 scan 阶段采用“主 agent + scan subagent”的两层结构，而不是单 agent 直接逐文件扫完整仓库。

### 4.1 主 Agent：轻量仓库分析与任务划分

在启动任何 scan subagent 之前，先由一个主 agent 做一轮轻量的仓库分析。

这一步只做少量工作，不做深度漏洞判断，目标是产出模块划分方案和公共上下文。

主 agent 需要：

1. 读取仓库目录结构
2. 识别构建系统和模块定义
3. 根据目录命名、文件组织和构建系统边界切分模块
4. 识别哪些模块属于核心运行时代码，哪些模块应降权或跳过
5. 为每个模块生成一份 scan subagent 的任务单元说明
6. 生成一份“最小公共上下文”给所有 subagent 共享

模块切分依据包括但不限于：

- 顶层目录和子目录结构
- CMake 子目录、target、library、module 定义
- Go package
- Java module / package
- 公共头文件与私有实现文件的边界
- 构建脚本里显式声明的功能组件

一个模块就是一个 scan subagent 的任务单元。

但 subagent 不只是拿到自己的文件列表，它还要同时拿到最小公共上下文，至少包括：

- 仓库整体职责概览
- 主要构建系统和模块边界
- 识别出的核心源码目录
- 可降权目录和应跳过目录
- 可能的公共攻击面类型
- 项目中的公共 API / 关键入口 / 共享基础设施位置

建议主 agent 产物：

- `01_repository_layout.md`
- `02_module_plan.json`
- `02_module_plan.md`
- `02_shared_context.md`

### 4.2 Scan Subagent：按模块做安全敏感度筛查

每个 scan subagent 负责一个模块。

其目标不是判断是否存在真实漏洞，而是尽可能完整地识别“值得后续 analysis 深挖的安全相关候选位置”。

scan subagent 的输出是候选草案，而不是最终 `VulnerabilityCandidate` 入库事件。

scan subagent 分三个阶段工作。

#### 第一阶段：理解模块职责

subagent 先快速通读模块代码，建立粗粒度的功能认知：

- 这个模块在整个项目中承担什么角色
- 实现了什么功能
- 对外暴露了哪些接口

这一阶段的产出是：

- 一到两句话的模块职责描述
- 模块内主要对外接口或入口点列表

其作用是给后续的逐函数安全敏感度判断提供上下文。

#### 第二阶段：逐函数扫描

subagent 遍历模块中的每个函数，快速判断其是否安全敏感。

判断依据包括：

- 是否接收外部可控输入
- 是否做影响安全的决策
- 是否调用潜在危险操作
- 是否执行输入校验、边界检查、状态检查、权限判断、资源管理、生命周期管理或并发同步

对于被判定为安全敏感的函数，记录：

- 位置
- 安全敏感类型
- 标记理由

对于明显不涉及安全的函数，直接跳过。

这一阶段不需要深度理解完整逻辑，只需要基于以下信息做快速判断：

- 函数签名
- 关键代码行
- 简单调用关系

#### 第三阶段：模块级观察

在逐函数扫描之后，subagent 从模块整体视角再做一轮补充观察，捕捉函数粒度不容易发现的信号。

重点关注两类问题：

1. 根据模块职责推断，应当存在但实际缺失的安全逻辑
2. 模块内多个同类函数在安全处理上的不一致性

这类模块级信号同样作为候选点记录。

### 4.3 主 Agent：结果汇总、轻量整理与统一上报

所有 scan subagent 完成之后，由主 agent 汇总它们的结果。

主 agent 负责做轻量整理，而不是重新做深度分析。

主要工作：

1. 合并多个 subagent 重复标记的同一个公共函数
2. 对同一候选点的多条理由做合并
3. 基于模块职责、暴露程度和安全关键性做全局排序
4. 剔除明显噪声
5. 做简单的跨模块关联
6. 做跨模块去重
7. 统一生成 full scan 主报告
8. 统一通过 `VULSEEK_EVENT` 提交 `candidate` 或 `candidate_batch`

也就是说：

- scan subagent 不直接对 Vulseek 发 candidate 入库事件
- 只有主 agent 做最终 candidate 收敛和事件提交

主 agent 在排序时需要综合考虑以下因素，并按综合优先级降序排列：

1. 暴露程度
   - 候选点离外部输入有多近
   - 越接近网络输入、文件输入、IPC、配置输入、公共 API 入口的候选，优先级越高
2. 安全决策关键性
   - 做认证、签名验证、权限判断、状态机门控、边界检查、资源生命周期决策的函数，优先级高于日志记录、格式转换、普通数据搬运等辅助函数
3. 可疑缺失信号
   - subagent 在第三阶段标记的“按模块职责本应存在但实际缺失的检查 / 校验 / 防护逻辑”，优先级高于单纯“存在危险函数调用”的信号
4. 跨模块不一致
   - 如果候选体现出跨模块或跨实现之间的安全处理不一致，优先级应进一步提升

可以理解为：

- “高暴露 + 高安全关键性 + 明显缺失信号 + 跨模块不一致”的候选，应排在最前面
- “低暴露 + 辅助函数 + 仅危险调用 + 无全局不一致”的候选，应明显降权

### 4.4 Candidate 的语义

对于 full scan 的 scan 阶段，candidate 的含义是：

- 某个函数、路径、模块缺失逻辑、或不一致处理模式
- 它与安全相关，值得后续 analysis 深挖
- 但在 scan 阶段不要求确认真实漏洞存在

这和 delta-scan 一致，都是高召回、低确认度的候选提取阶段。

## 5. 数据与状态模型

`Full Scan` 继续复用现有模型，不新增平行概念。

### 5.1 ScanJob

关键字段：

- `scanType = full`
- `status = queued | scanning | analyzing | verifying | completed | failed`
- `commitSha`
- `targetRef`
- `targetTag`

### 5.2 VulnerabilityCandidate

继续作为 full scan 的核心产物。

至少包含：

- `title`
- `description`
- `filePath`
- `line`
- `confidence`
- `currentStage`
- `status`

### 5.3 Analysis Result / Verification Result

继续复用现有：

- `analysis_results`
- `verification_results`

## 6. 上下文目录与产物布局

`Full Scan` 的上下文布局沿用当前项目 profile 目录规范：

```text
projects/<Project>/profiles/<Profile>/
  jobs/<scanJobId>/
    scanning/
      00_repository_state.*
      03_codex_report.md
      app-server-messages.jsonl
      app-server-text.log
      app-server-stderr.log
    candidates/<candidateId>/
      analysis/
      verify/
  cache/
    cve/
    pr/
    ...
```

## 7. 前端需求

### 7.1 入口

在现有 project/profile 页面中，`Full Scan` 按钮继续与 `Delta Scan` 并列。

### 7.2 Jobs 视图

`Full Scan` 的 `ScanJob` 继续在现有 Jobs 列表中展示：

- 类型：`Full Scan`
- 状态
- trigger source
- 创建时间

### 7.3 Job Detail

沿用现有 job detail 页面：

- Overview
- Status
- Candidates
- Scanning
- Files

### 7.4 Candidate Detail

沿用现有 candidate detail 页面：

- Overview
- Files

## 8. 任务编排建议

### 8.1 Scan 阶段并发

`Full Scan` 的 scan 阶段建议采用分层并发：

1. 主 agent 串行做轻量仓库分析与模块划分
2. scan subagent 按模块并发执行
3. 主 agent 串行做统一汇总与 candidate 提交

初期建议：

- 主 agent 永远单实例
- scan subagent 并发先写死为一个较小常量，例如 `2` 或 `3`
- 不在 scan subagent 内再继续无限细分多层并发

原因：

- scan 阶段现在的核心不是深度推理，而是稳定地做全仓模块化筛查
- 先把“模块划分 -> subagent 输出 -> 主 agent 汇总”的主链路跑通更重要
- 并发太高会放大上下文管理、日志汇总、结果去重和容器资源竞争的问题

### 8.2 主 Agent 与 Subagent 的上下文关系

主 agent 负责生成统一公共上下文。

每个 scan subagent 的输入应该包含：

- 自己负责的模块边界
- 模块文件列表
- 共享上下文
- 输出格式约束
- 不要判断真实漏洞、只做安全敏感度筛查的明确要求

这样可以避免：

- subagent 只盯着本地文件，完全失去仓库全局视角
- 不同 subagent 对同类代码给出完全不一致的候选标准
- subagent 误做 analysis / verify 阶段才该做的工作

### 8.3 Scan 阶段输出责任边界

责任边界应明确为：

- 主 agent：
  - 模块划分
  - 公共上下文整理
  - subagent 调度
  - 结果收敛
  - 跨模块去重和排序
  - 最终 `VULSEEK_EVENT` 提交
- scan subagent：
  - 模块职责理解
  - 逐函数安全敏感度扫描
  - 模块级观察
  - 生成候选草案，不直接入库

### 8.4 Analysis / Verify 并发

沿用当前平台中的并发常量控制：

- analysis：小并发
- verify：更小并发

## 9. 风险点

### 9.1 候选数量爆炸

全仓扫描很容易产生过多 candidate。

需要控制：

- 规则命中去重
- 同根因合并
- 候选数上限
- 对低价值目录降权

### 9.2 扫描成本高

全仓 LLM 扫描成本明显高于 delta scan。

需要考虑：

- 先结构建模，再高价值路径优先
- 尽量让长说明写入 report，不塞入事件 JSON
- 候选 JSON 只保留短结构化字段

### 9.3 结果质量波动

如果 full scan 直接对全仓自由搜索，容易产生大量低质量候选。

需要通过：

- 入口建模
- 模块划分
- 主 agent 汇总
- 候选去重

来提升质量

## 10. 分阶段实施建议

### Phase 1：最小可用 Full Scan

目标：

- 能创建 `scanType=full` 的 `ScanJob`
- 主 agent 能完成轻量仓库分析与模块划分
- scan subagent 能按模块运行
- 能稳定产出 `VulnerabilityCandidate`
- 能进入现有 analysis / verify 流水线

完成内容：

- Full Scan prompt / skill 规范化
- Full Scan job 创建与调度
- 主 agent / scan subagent 基础编排
- 模块计划、共享上下文、subagent 扫描结果落盘
- 主 agent 汇总后统一事件入库
- 前端按钮与列表展示复用现有页面

### Phase 2：质量提升

目标：

- 提升 candidate 质量，降低爆炸

完成内容：

- 更好的模块切分策略
- 更好的共享上下文抽取
- 模块级观察模板化
- scan 阶段轻量去重

### Phase 3：性能与资产复用

目标：

- 降低 full scan 成本

完成内容：

- 共享 CodeQL / CVE / PR / fuzz / build 资产
- 缓存仓库结构摘要
- 缓存高价值入口点

## 11. 测试计划

### 11.1 单元/服务层

验证：

- 能创建 `scanType=full` 的 `ScanJob`
- full scan job 能进入扫描队列
- candidate 事件能稳定入库
- analysis / verify 能消费 full scan 的 candidate

### 11.2 集成测试

准备一个小型 C/C++ 仓库，验证：

1. 点击 `Full Scan`
2. 生成 `ScanJob`
3. 生成多个 candidate
4. analysis 自动运行
5. verify 自动运行
6. 前端可见 job/candidate/result/files

### 11.3 回归测试

验证以下能力不被破坏：

- 现有 `Delta Scan`
- 现有 candidate detail / job detail 页面
- 现有 analysis / verify 结果展示
- 现有上下文目录布局

## 12. 当前建议

建议先把 `Full Scan` 定义为：

- 基于最新仓库版本
- 一个主 agent 负责模块划分、subagent 调度与最终汇总
- 多个 scan subagent 负责模块级安全敏感度筛查
- 只有主 agent 通过 `candidate` / `candidate_batch` 事件上报候选
- 复用当前 analysis / verify 流水线

也就是说，第一版重点不是“极致智能编排”，而是：

- 把 `full(main agent -> subagents) -> candidates -> analysis -> verify` 这条链路稳定打通
- 保证日志、文件、结果、状态都能闭环
