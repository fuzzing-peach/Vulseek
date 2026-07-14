# 参考 Raptor 精细化 Stage Prompt、职责与输入输出

## Summary

保留当前 full scan pipeline 结构，不改 DAG：

```text
Repository -> Module -> Function -> Analysis
Analysis -> Fuzz Build -> Fuzz Run -> Analysis
Analysis -> Critic -> Analysis
Analysis -> Verification
```

参考 Raptor 的核心设计，但不照搬 Raptor 的线性 Stage A/B/C/D/E/F。重点吸收：

- inventory/context-map 思维；
- evidence-driven finding；
- hypothesis / attack path / disproof / ruling 分层；
- 每个 stage 只产出自己负责的结构化结果；
- critic/sanity/review 作为事实核查和反驳机制。

实施方式上可以直接覆盖现有 stage prompt，不需要保留旧 prompt 兼容层、fallback prompt 或双路径切换。但不能破坏既有输入输出规范：structured output envelope、route 语义、schema 校验、artifact 路径、task/runtime 输入字段和 pipeline stage contract 必须保持明确且可验证。

## Key Changes

- 先改 schema，再改 prompt：
  - 增加统一 evidence schema，用于表达代码证据、运行证据、反证、前置条件、可达性和复现信息。
  - 扩展 `Candidate`、`Analysis`、`BuildFuzzerRequest`、`FuzzBuildResult`、`FuzzRunResult`、`CriticResponse`、`FinalAnalysis`、`Verification`。
  - prompt 只要求 agent 填写对应 stage 负责的字段，避免把关键证据散落在 prose 中。
  - prompt 文案可以直接替换现有实现，不需要为旧提示词保留兼容或 fallback；兼容边界只保留在输入输出 schema、route、artifact 和 pipeline contract 上。

- `RepositoryProfileStage`：
  - 仍以划分 repository-level security modules 为核心目的，但模块不是代码目录的互斥分片。
  - 每个 module 表达一种安全分析视角：独立的威胁模型、攻击面、安全边界、入口、关键状态和危险 sink 组合。
  - 允许模块重叠：同一个文件、函数、协议层、解析器或状态机可以出现在多个 module 中，只要它在不同攻击路径或信任边界下承担不同安全角色。
  - 输出增加 repository-level context：entry points、trust boundaries、dangerous sinks、runtime attack surfaces、test/generated exclusions、build/run hints。
  - 每个 module 的 `files` / `entryPoints` / `trustBoundaries` / `attackSurfaces` 要说明为什么这些元素共同构成一个安全模块，而不是仅按目录或组件 ownership 拆分。
  - 目标是给后续 module/function scan 提供类似 Raptor `context-map.json` 的全局背景，同时保留安全模块划分，帮助后续 stages 针对不同威胁模型分别枚举函数和 candidate。

- `IdentifyTargetStage`：
  - 从 module function enumeration 升级为 module security model analyzer。
  - 目标不是单纯列出函数，而是分析当前 module 的安全边界、攻击面、威胁模型、入口、关键状态、危险 sink 和主要漏洞类型。
  - 输入的 module 可能与其他 module 共享文件或函数；本 stage 只围绕当前 module 的威胁模型、攻击面、入口和安全边界选择函数，不要求去重到全局唯一 ownership。
  - 输出 module-level security model：trust boundaries、attacker-controlled inputs、privileged operations、state transitions、dangerous sinks、expected invariants、likely vulnerability classes、high-value attack paths。
  - 每个 function 增加 role、reachability、source-to-sink hint、exclude reason、priority reason。
  - 每个 function 还要说明它和当前 module 安全模型的关系：它是入口、解析/规范化、认证/授权、状态更新、边界检查、资源管理、加解密/证书处理、危险 sink、错误处理，还是反证/低优先级函数。
  - 目标是让 function stage 知道为什么扫这个函数、它对应哪个攻击面或安全边界、可能关联什么漏洞类型，以及它在攻击路径中的可能位置。

- `ScanTargetStage`：
  - 对应 Raptor Stage A 的 one-shot candidate formation。
  - Candidate 输出增加 claim、rootCauseKey、evidence、attackerControl、affectedSink、preconditions、quickDisproofAttempt、needsFuzzing、needsManualAnalysis。
  - `needsFuzzing` 不只表示“需要动态证据证明漏洞”，也可以表示“代码路径、状态机、解析逻辑或输入空间过于复杂，静态审计无法可靠覆盖，需要 fuzz 辅助探索可达路径和异常状态”。
  - 目标是过滤低质量 candidate，并把初始证据链带给 Analysis。

- `AnalysisStage`：
  - 保持为 debate group 的主调度者，承担 hypothesis/process/ruling/finalization。
  - 输入从单个 `feedback` 扩展为可累计的 feedback/evidence history。
  - route 语义明确化：
    - `build_fuzzer`: 当前需要动态探索或动态证据，包括缺少漏洞证据、静态路径不完整、状态空间复杂、解析/协议交互复杂、前置条件难以人工枚举、或需要发现未预期状态。
    - `critic`: draft analysis 已有足够证据，需要反驳和事实核查。
    - `verification`: critic convinced 且 final ruling 完成。
  - 输出必须包含 hypothesis、evidence table、attack path、blockers、ruling rationale、missing evidence request。
  - Analysis 应主动考虑 fuzz：当代码结构复杂、控制流/状态机/解析器/协议交互难以静态掌握时，即使尚未形成强漏洞 claim，也可以 route 到 `build_fuzzer` 进行探索性 fuzz。

- `FuzzBuildStage`：
  - 把 `BuildFuzzerRequest` 改成可执行测试规格，而不是普通说明。
  - 增加 harness entry、input model、expected oracle、seed corpus hints、build command hints、sanitizer/runtime assumptions。
  - 支持两类 fuzz 目标：证据导向 fuzz，用于验证具体 hypothesis；探索导向 fuzz，用于覆盖复杂路径、状态机、解析边界和异常状态。
  - 输出保留 build status，同时记录 crate/executable/logs/error 的可消费路径。

- `FuzzRunStage`：
  - 作为动态 evidence collector 和 path/state explorer。
  - 输出增加 command run、exit status、crash signal、reproducer path、observed behavior、negative evidence、coverage/proximity、new paths or states reached、input classes discovered、confidence impact。
  - 始终回流 Analysis，由 Analysis 判断证据是否足够进入 critic、继续补证据，或基于 fuzz 发现的新路径/状态形成新的 hypothesis。

- `AnalysisCriticStage`：
  - 从普通 reviewer 升级为 checklist 化 sanity/review。
  - 检查 code existence、citation validity、reachability、precondition realism、test/mock/generated、false-positive alternatives、severity/exploitability leap。
  - 输出必须明确哪些字段缺证据、哪些 claim 被反驳、是否 convinced。

- `VerifyingStage`：
  - 作为最终验证和报告包装，不重复做大范围探索。
  - 输入应包含 finalAnalysis、evidence bundle、critic approval、fuzz evidence。
  - 输出 final verification、report、issue draft、PoC、Dockerfile、run script。

## Test Plan

- Schema tests：
  - 覆盖新增 evidence/candidate/analysis/fuzz/critic/verification schema 的 required/optional 字段。
  - 验证旧的最小输出样例按预期失败或通过兼容路径。

- Prompt tests：
  - 确认每个 stage prompt 明确描述职责边界、输入上下文、输出字段和 route 规则。
  - 确认新 prompt 直接覆盖旧 prompt 后，structured output envelope、schema required 字段、route 枚举和 artifact 路径仍符合现有 pipeline contract。
  - 确认 Repository prompt 明确允许 module 重叠，并要求按威胁模型、攻击面、安全边界和入口解释 module 划分依据。
  - 确认 Module prompt 要求产出 module-level 安全边界、攻击面、威胁模型和漏洞类型，而不是只枚举函数。
  - 确认 Module prompt 不把跨 module 重叠函数当成错误，也不要求全局唯一 ownership。
  - 确认每个 function 输出包含 role、reachability、source-to-sink hint、exclude reason、priority reason，以及与当前 module 安全模型的关系。
  - 确认 Analysis route prompt 鼓励在复杂控制流、状态机、解析器、协议交互或输入空间难以静态掌握时主动 route 到 `build_fuzzer`，而不只在缺少漏洞证据时 fuzz。
  - 确认 Analysis route prompt 不允许 verification 跳过 convinced critic。
  - 确认 FuzzBuild/FuzzRun prompt 只写 task 目录下 artifact。

- Pipeline tests：
  - Function -> Analysis 的 candidate 输入包含初始 evidence。
  - FuzzBuild/FuzzRun/Critic feedback 能累计回 Analysis。
  - Analysis final output 必须携带 critic approval 和 evidence bundle 才能进入 Verification。

- Runtime validation：
  - 实现完成后启动一次 wolfSSL full scan，观察 30 分钟。
  - 抽查 Repository/Module/Function/Analysis/Critic/Verification 的 prompt jsonl 和 output.json。
  - 确认输出结构更稳定，Analysis 不再把 fuzz/critic/verification 职责混在一个 prose 里。
  - 观察期间记录 scan job id、当前 stage/task 状态、failed task 数量和关键日志。
  - 如果 30 分钟内出现 failed task，立即结合 task runtime 日志、driver lifecycle、event jsonl 和相关代码分析根因。
  - 30 分钟验证结束后必须 cancel 该 full scan job，确认 job 状态变为 canceled 或不再有对应运行容器，避免后台继续占用资源。

## Assumptions

- 当前 pipeline DAG 保持不变。
- Prompt 可以直接覆盖现有版本，不需要旧 prompt 兼容或 fallback；但输入输出规范不能被放宽、破坏或隐式改变。
- Repository modules 是安全分析视角，不是互斥代码 ownership；允许重叠，但必须解释重叠的安全理由。
- 不引入 Raptor 的 Python orchestration，不把 pipeline 改成 Stage A/B/C/D/E/F。
- Raptor 只作为职责划分和证据结构参考。
- 优先做 schema 和 prompt 结构化改造，再考虑 UI 展示这些新增证据字段。
