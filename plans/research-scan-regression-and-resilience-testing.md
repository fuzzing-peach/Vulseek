# Research Scan Regression And Resilience Testing Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立一套可重复的 Research Scan 回归与韧性测试，覆盖已修复的 Review artifact、route persistence、Research Broker、Registry、Task/UI 问题，并提前发现恢复、并发、流式读取和性能退化。

**Architecture:** 使用“确定性 pipeline fixture + 历史 Job 审计 + 一个真实运行中的 dev Research Job”三条验证路径。确定性 fixture 必须走通全部 12 个 stage 和深层 route；真实 Job 先验证 Track Review 回归，再在持续产生业务进度时进行最长 120 分钟的纵向观察，始终不等待 Job 终态。

**Tech Stack:** Vitest、Node test runner、Drizzle/PostgreSQL、YAML pipeline definitions、Docker Swarm、tRPC/SSE、agent-browser。

## Global Constraints

- 只连接、修改、重启 dev；禁止连接、修改或重启 release。
- 不创建 Terminal Research Job fixture；真实扫描达到纵向检查点、失去业务进度或达到 120 分钟上限后取消。
- 不依赖 LLM 恰好产生 Finding、Primitive 或 Chain；这些路径由确定性 fixture 覆盖。
- 不把 Broker token、agent credential、数据库密码写入测试报告、artifact、快照或命令输出。
- 失败注入只能作用于测试 task、临时目录或 mock，不修改现有用户 Job。
- 如果连续 Docker 操作均出现 `runc` 错误，先保存错误和资源状态；确认属于主机缓存压力后，可执行用户已授权的 `echo 3 | sudo tee /proc/sys/vm/drop_caches`，随后只重试失败的 dev 步骤。

## Execution Status (2026-07-26)

- 已完成历史 dev Research Job 审计：31 个 Job 按 9 个 `scanPipelineDefinitionSnapshot` cohort 分组；当前 stage funnel、lineage、queued starvation、pending dispatch、资源增长、Registry revision 和成本缺口均已纳入回归门槛。
- 已通过 ACP driver、deterministic 12-stage pipeline、dispatch recovery、Registry effect consistency、runtime recovery、runtime-loop、Broker contract、progress audit 和 dev DB integration 测试；本轮新增的 ACP 缺失 output、跨 Track Finding、取消恢复测试也通过。
- 真实 dev Job `P8oc4fvsiL2eHq5yaimQw` 已走过 `research-scope -> surface-map -> track-plan -> vulnerability-discovery -> track-review -> finding-validation -> finding-review -> chain-synthesis`，产生 32 个 completed、1 个 failed、19 个 canceled task；取消后没有新 task、匹配容器或 agent 进程。
- 该 Job 的 Track Review 成功保存原始 route，并从 `$output` 生成子 task artifact；Broker `list-tracks`/`list-findings` 返回合法 JSON；Overview、Tasks、Findings、Tracks、Primitives、Chains、Monitoring、Files 及 API p95 `<500ms` 已用 agent-browser 验证。
- 本轮发现并修复取消清理缺陷：Research task 原先会留在 BullMQ waiting 队列，且 Job 取消只清理 open task；现在按普通/分组队列的确定性 task job ID 清理全部任务，重复取消也会执行清理。对 `P8oc4...` 重复执行 dev 取消入口后，所有 stage 的 waiting/active/delayed/prioritized 均为 0。
- 本轮唯一真实失败为 `vulnerability-discovery` 的 `ACP prompt completed without output.json`：stdout 有 `task_done(end_turn)`、容器未 OOM，但 agent 未写最终 envelope。driver 按协议正确拒绝；已强化 Discovery prompt，要求显式写入并重新校验 `/task/output.json`，仍保留缺失即失败的协议测试。
- 仍未满足的运行门槛：完整真实 Job 尚未到达 Exploit/Report，dev CPU 稳态约 30-42% 高于 `<25%` 目标，历史存在成本计算缺口、Track revision 不一致和深层 stage starvation；这些作为后续修复/性能工作项，不宣称本轮通过。未连接、修改或重启 release。

---

## Test Model

### Historical Baseline

以下基线来自 2026-07-22 至 2026-07-26 的 31 个 dev Research Job。历史 Job 分属 9 个 pipeline snapshot，不能把旧 snapshot 的故障直接视为当前回归结果，但必须把它们转化为测试用例。

| 指标 | 历史观测 | 测试含义 |
| --- | --- | --- |
| Job 终态 | 0 completed、2 failed、29 canceled | 不能用 task success 代替端到端进度 |
| Stage 漏斗 | 18 个 Job 到 Track Review、7 个到 Finding、3 个到 Chain Synthesis、2 个到 Chain Review、0 个到 Exploit/Report | 深层 12-stage 路径必须由确定性 fixture 强制覆盖 |
| Finding 循环 | 279 个 completed Finding Review 中 204 个为 `needs-more-evidence`；单 Finding 最多 19 次 Validation + 18 次 Review | 必须检测无证据增量的循环并停止继续消耗 |
| Track 增长 | 546 个 Track 中 310 个仍为 queued；一个 46 分钟 Job 增长到 120 个 Track | 必须检测新 Track 爆炸、排队饥饿和重复 surface |
| Dispatch | p95 0.78 秒，但终态历史 Job 留有 42 个 `completed + pending` task | 调度速度不是主要瓶颈，恢复和终态一致性仍需验证 |
| Registry 一致性 | 存在 completed Review 但 Finding 仍为 discovered；存在 Broker 失败文本却完成并写入 Chain | Registry effect 成功必须成为业务完成条件 |
| Entity contract | 历史 Chain 使用 `id`，持久化读取 `chainId`，同一逻辑链产生两个 DB 记录 | Track、Primitive、Chain 需要严格嵌套 schema 和引用完整性 |
| 资源增长 | 148-196 task 的 Job 占用 1.5-2.0 GiB，最高累计 7.76M tokens | 必须按 task 数量监测磁盘和 token 增长斜率 |
| Snapshot 漂移 | 28 个 Job 使用 7 个 definition hash，历史还存在 `candidate-found` route | 所有比较必须按 snapshot cohort 分组，新 Job 禁止旧字段/route |

### Current Structural Risks

- 历史实现曾先把 task 写成 completed，再调用 `stage.onSuccess`; 当前已改为在完成事务中执行 effect，测试仍必须防止回归到 completed task 与缺失 Registry effect 的裂缝。
- Track、Primitive、Chain 已改为严格稳定 ID/schema；持久化层仍需通过跨 Job、stale revision 和 effect/event 一致性测试证明 schema-valid 同时可安全持久化。
- Pipeline 只有三小时 minimum deadline，主要阻止 Exploit Review 过早进入 Report；它不提供 Finding/Track 循环预算、停滞检测或深层阶段推进保证。
- 每个历史 task 的 agent-home 约 11-21 MiB，包含 session、skill/plugin cache 等运行文件；大量循环会把逻辑停滞放大为 GiB 级磁盘增长。
- 历史 estimated cost 均为 0，即使 token 已达到百万级；测试必须区分“价格确实为零”和“成本没有配置/计算”。

### Fixtures

- `DeterministicResearchPipeline`: 使用固定 stage output 驱动完整 12-stage graph，并分别强制进入 continue、finding、primitive-gap、accepted、runtime-retry、confirmed route，不调用真实模型。
- `HistoricalResearchAudit`: 只读聚合历史 dev Job，按 pipeline snapshot hash 输出漏斗、循环、资源和一致性指标。
- `ActiveResearchJob`: 从 dev UI 新建，先运行到 Track Review 成功分发，再按业务进度门槛决定是否继续纵向观察。
- `EmptyRegistryJob`: 使用 Active Job 的早期时间窗口验证 Findings、Tracks、Primitives、Chains 空状态，不再创建第二个 Job。
- `CrossJobFixture`: 自动化测试中创建两个临时 scanJobId，用于验证 Registry 和 Broker 隔离。

### Required Evidence

每次真实验证记录以下非敏感证据：

- scanJobId、taskId、stage、status、route、dispatch status 和时间戳；
- 父 task output 与子 task `inputs/*.json` 的 SHA-256；
- Registry 当前行数、event 行数、revision 和 actorTaskId；
- API 状态码、响应时间和浏览器失败请求；
- task container 名称、镜像摘要、退出状态和清理结果；
- pipeline snapshot hash、当前 frontier、progress signature、累计 token 和 Job artifact 字节数；
- 失败时按 `UI -> network -> dev logs -> DB -> artifacts -> runtime` 顺序记录根因。

### Fixed-Issue Coverage Map

| 已修问题 | 主要验证任务 |
| --- | --- |
| Review 让 LLM 生成 `reviewPath`，自然语言被当成路径 | Task 1、Task 8 |
| completion 后才保存 route，dispatch 失败会丢 route | Task 2、Task 8 |
| Broker 使用错误地址、404 或错误 credential 来源 | Task 3、Task 8 |
| Research Finding 与 Candidate 混用、artifact 格式不稳定 | Task 1、Task 4 |
| Track/Primitive/Chain/Finding projection 或状态不一致 | Task 4、Task 7、Task 9 |
| Research stage 不出现在 Running/Finished Tasks | Task 5、Task 9 |
| Monitoring、Session、activity 数据缺失或不一致 | Task 6、Task 9 |
| task 名称仍是 stage 名或未渲染模板 | Task 8 |
| Registry 列表缺少过滤、分页、排序或发生文本溢出 | Task 4、Task 9 |
| 空 stage 轮询、重复文件读取导致 dev CPU/API 变慢 | Task 5、Task 6、Task 7、Task 9 |

---

### Task 1: Strengthen Pipeline Contract And Review Artifact Tests

**Files:**

- Modify: `apps/vulseek/__test__/scan/research-pipeline-contract.test.ts`
- Modify: `apps/vulseek/__test__/scan/research-pipeline-artifacts.test.ts`
- Modify: `packages/server/src/services/scan/pipeline/scan-pipeline-schema-contracts.test.ts`
- Test data: `packages/server/src/services/scan/pipeline/definitions/pipelines/research.yaml`
- Test data: `packages/server/src/services/scan/pipeline/definitions/schemas/research.yaml`

**Interfaces:**

- Consumes: Research pipeline definitions loaded by `loadScanPipelineDefinitions()`.
- Produces: Deterministic assertions for all stage schemas, routes, fan-out expressions and edge artifacts.

- [ ] 为 Track Review、Chain Review、Exploit Review 分别构造合法 output，确认 schema 接受且没有 `reviewPath`。
- [ ] 为三个 Review output 注入 `reviewPath` 和未知字段，确认 `additionalProperties: false` 拒绝旧格式。
- [ ] 枚举三个 Review 的每条出边，确认 `artifact.from === "$output"`、`inputField === "reviewPath"`，目标分别为 `inputs/track-review.json`、`inputs/chain-review.json`、`inputs/exploit-review.json`。
- [ ] 执行 edge transform 后读取子 task artifact，断言其 JSON 与父 task `output` 深度相等，且注入 input 为 `/task/inputs/<review>.json`。
- [ ] 覆盖 `/tmp/...`、`/task/../...`、自然语言和缺失 artifact，确认 task 在 dispatch 前失败且不创建 child task。
- [ ] 覆盖所有 route key、默认 route、fan-out JSONPath 和 Finding ID 传递，防止 YAML 与 schema 漂移。
- [ ] 为 Track Plan item 建立严格 fixture，至少要求非空 `trackKey`、`approachFamily`、`researchIdea`、`scope` 和 `mechanisms`；缺少稳定 key 或包含旧 Candidate 字段时必须失败。
- [ ] 为 `FindingValidation.primitive` 和 `FindingReview.confirmedPrimitive` 建立同一严格 Primitive contract，要求 `primitiveId`、`name`、`capability`、`requiredInput`、`producedCapability`、`trustLevel` 和 `evidenceRefs`。
- [ ] 为 `ChainSynthesis.chains[*]` 建立严格 Chain contract，要求 `chainId`、`chainKey`、`steps`、`entrypoint`、`requiredCapabilities`、`producedCapabilities`、`trustBoundaryCrossings`、`deploymentConditions`、`primitiveGaps` 和 `successTarget`。
- [ ] 明确拒绝只提供 `id` 而没有 `chainId` 的 Chain，并断言 Chain Review、Exploit Validation、Exploit Review 和 Research Report 始终沿用同一 `chainId`。
- [ ] 使用已持久化的 Finding/Primitive ID 驱动完整深层 fixture，断言 12 个 stage 全部至少执行一次，最终产生 Research Report；不允许用空对象或随机 ID 绕过引用校验。
- [ ] 运行：

```bash
pnpm --filter vulseek test -- \
  research-pipeline-contract \
  research-pipeline-artifacts \
  scan-pipeline-schema-contracts
```

预期：所有测试通过；旧 `reviewPath`、越界路径、未知 route、宽松 Track/Primitive/Chain object 和不稳定实体 ID 均被拒绝。

### Task 2: Verify Atomic Route Persistence And Dispatch Recovery

**Files:**

- Modify: `apps/vulseek/__test__/scan/task-status-transition.test.ts`
- Modify: `packages/server/src/services/scan/pipeline/completion-claim.test.ts`
- Modify: `packages/server/src/services/scan/pipeline/pipeline-runner.settlement.test.ts`
- Create: `packages/server/src/services/scan/pipeline/research-dispatch-recovery.test.ts`
- Exercise: `packages/server/src/services/scan/pipeline/pipeline-runner.ts`
- Exercise: `packages/server/src/services/scan/persistence/task.repo.ts`

**Interfaces:**

- Consumes: `transitionTaskStatusRepo()`, completion claim and pending dispatch recovery.
- Produces: Deterministic proof that the agent's raw route survives completion, fallback and restart.

- [ ] 模拟两个并发 completion，断言只有一个 claimant 写入 output、usage 和 `downstreamRouteKey`。
- [ ] 对 completed、failed、exited、canceled task 重放 stale completion，断言为无副作用 no-op。
- [ ] 在 task 已写为 `completed + pending` 后注入 enqueue/dispatch 异常，断言 route 和 output 已持久化且 task 不回退为 failed。
- [ ] 执行下一轮 runtime recovery，断言使用数据库中的原始 route，创建相同确定性 child taskId、dispatch key 和 BullMQ jobId。
- [ ] 模拟部分 child 已创建后重试，断言 child row 和 queue job 不重复。
- [ ] 覆盖 disabled-stage fallback、默认 route 和 exploit deadline override，断言它们只改变本轮分发，不覆盖原始 `downstreamRouteKey`。
- [ ] 覆盖非路由 stage，断言 terminal route 为 `null` 且 dispatch 正常完成。
- [ ] 运行：

```bash
pnpm --filter vulseek test -- \
  task-status-transition \
  completion-claim \
  pipeline-runner.settlement \
  research-dispatch-recovery
```

预期：所有 completion 副作用只执行一次；dispatch 失败可恢复且不改变原始 route。

### Task 3: Verify Broker Credential, Network And Driver Isolation

**Files:**

- Modify: `apps/vulseek/__test__/scan/research-broker-config.test.ts`
- Modify: `apps/vulseek/__test__/scan/research-broker-contract.test.ts`
- Modify: `packages/server/src/services/dockerfiles/vulseek-acp-driver.test.mjs`
- Exercise: `scripts/research-broker-token.sh`
- Exercise: `packages/server/src/services/scan/runtime/run-single-turn-agent.ts`
- Exercise: `agents/skills/research-db/research_db.py`

**Interfaces:**

- Consumes: shared dev token, service-name Broker URL and driver-created short-lived credential file.
- Produces: Proof that Broker is reachable without leaking or substituting credentials.

- [ ] 在临时目录验证 token 首次生成、重复复用、dev/release 隔离、目录 `0700`、文件 `0600`、空文件和非法格式 fail-fast。
- [ ] 验证 URL 优先级为显式 URL，其次 `http://${VULSEEK_SERVICE_NAME}:3000/api`；缺失两者时 Research task 启动失败。
- [ ] 验证 Broker host 同时加入 `NO_PROXY` 和 `no_proxy`，避免请求误入外部代理。
- [ ] 驱动 fake ACP adapter，确认原始 `VULSEEK_RESEARCH_BROKER_TOKEN` 不进入 adapter env，临时 token 文件可读且 driver 退出后被删除。
- [ ] 扫描 `acp-driver-input.json`、task output、stdout、stderr 和普通 Docker command，确认不包含 token 值。
- [ ] 对 dev Broker 执行无 token、错误 token、跨 Job task、非法 operation 和合法 read，期望分别为 `401`、`401`、`403`、`400`、`200`。
- [ ] 从运行中的 scan container 执行 `research-db list-tracks` 和 `research-db list-findings`，确认返回 JSON；删除 Broker context 的 fixture 必须报告基础设施错误且不得读取 `auth.json` 或 `.credentials.json`。
- [ ] 运行：

```bash
bash -n dev.sh run.sh scripts/research-broker-token.sh
node --test packages/server/src/services/dockerfiles/vulseek-acp-driver.test.mjs
pnpm --filter vulseek test -- research-broker-config research-broker-contract
```

预期：Broker 合法请求可达，认证失败清晰，token 不进入持久化文件或 agent credential 路径。

### Task 4: Verify Registry State, Events And Cross-Job Isolation

**Files:**

- Modify: `packages/server/src/services/scan/persistence/research-registry-state.test.ts`
- Modify: `packages/server/src/services/scan/persistence/research-finding-state.test.ts`
- Modify: `apps/vulseek/__test__/scan/research-registry-db.integration.test.ts`
- Modify: `apps/vulseek/__test__/scan/research-registry-api.test.ts`
- Create: `packages/server/src/services/scan/pipeline/research-effect-consistency.test.ts`
- Exercise: `packages/server/src/services/scan/persistence/research-registry.repo.ts`
- Exercise: `packages/server/src/services/scan/pipeline/pipeline-runner.ts`
- Exercise: `packages/server/src/db/schema/research.ts`

**Interfaces:**

- Consumes: Research Registry effects and event idempotency keys.
- Produces: Verified projections for Tracks, Findings, Primitives and Chains plus append-only events.

- [ ] 对每个 Registry effect 验证 projection 更新与 event insert 位于同一事务。
- [ ] 重放相同 task/effect，断言 idempotency key 阻止重复 event，revision 不重复增加。
- [ ] 注入 stale `expectedRevision`，断言更新失败并保留当前 projection，不覆盖较新状态。
- [ ] 验证 Track 从 `queued` 进入 active/blocked/exhausted 等状态，`currentTaskId`、findingIds、iteration 和 event actor 与实际 task 一致。
- [ ] 验证 Discovery Report 只通过 `findingPaths` 写入严格 Finding；inline Candidate/Finding、跨 Job trackId 和重复 findingId 必须失败。
- [ ] 验证 Finding Review 生成 Primitive，Chain Synthesis/Review 更新 Chain，并建立正确 findingId/primitiveId/chainId 引用。
- [ ] 注入 Registry effect 抛错，断言下游 dispatch 被阻止；系统不得出现 task 已 completed/dispatched、projection/event 却缺失的状态。
- [ ] 对每个成功 Research task 建立 effect completeness 断言：`actorTaskId + sourceStage + entityId` 必须能找到预期 event，event 的 resultingRevision 必须等于 projection revision。
- [ ] 模拟 Broker 命令失败后 agent 仍返回 schema-valid output，断言该 output 不能以“缺少 Registry evidence”为依据创建 Primitive/Chain 或完成依赖 Broker 的 stage。
- [ ] Chain Synthesis 只能引用同 Job confirmed Primitive；零 Primitive、未知 Primitive、跨 Job Primitive 和不兼容相邻 capability 均不得持久化 Chain。
- [ ] 使用两个临时 scanJobId 验证 repository、tRPC 和 Broker 均不能跨 Job 读取或更新 Registry。
- [ ] 验证所有列表的搜索、多状态/枚举过滤、排序、分页、越界页和 `items.length <= pageSize`。
- [ ] 运行 dev DB opt-in 测试：

```bash
VULSEEK_RESEARCH_DB_INTEGRATION=1 \
VULSEEK_RESEARCH_DB_TEST_JOB_ID="$RESEARCH_JOB_ID" \
pnpm --filter vulseek test -- \
  research-registry-db.integration \
  research-effect-consistency
```

预期：task、projection、event 和 artifact 四者一致；effect 失败不会被伪装成业务成功，重试无重复数据，Job 间完全隔离。

### Task 5: Verify Runtime Recovery, Cancellation And Concurrency

**Files:**

- Modify: `packages/server/src/services/scan/pipeline/pipeline-runtime-registry.test.ts`
- Modify: `packages/server/src/services/scan/pipeline/runtime-loop-snapshot.test.ts`
- Modify: `apps/vulseek/__test__/server/running-task-stage.test.ts`
- Create: `packages/server/src/services/scan/pipeline/research-runtime-recovery.test.ts`

**Interfaces:**

- Consumes: process-global runtime registry, pending-aware scheduler and deterministic task dispatch.
- Produces: Recovery guarantees without requiring a real terminal Job.

- [ ] 模拟模块重复加载，断言同一 Research Job 只存在一个 runtime；旧 runtime 不能删除替代实例。
- [ ] 模拟进程重启后的 completed+pending task，断言 recovery 继续 dispatch，不重跑已完成 agent。
- [ ] 模拟 pause 发生在 loop snapshot 与 claim 之间，断言不启动新 task；resume 后只恢复 pending task。
- [ ] 模拟 cancel 发生在 agent completion 与 dispatch 之间，断言不再创建下游 task，迟到 completion 不改变 canceled 状态。
- [ ] fan-out 四个 Discovery/Finding Validation task，断言并发不超过 stage limit，taskId 和 queue job 唯一。
- [ ] 零 pending task 时断言不 poll Research stage queue；只有 pending stage 被轮询。
- [ ] 验证 12 个 Research stage 均能映射到 Running/Finished Tasks，未知 stage 明确失败而不是静默隐藏。
- [ ] 运行：

```bash
pnpm --filter vulseek test -- \
  pipeline-runtime-registry \
  runtime-loop-snapshot \
  running-task-stage \
  research-runtime-recovery
```

预期：重启、pause、resume、cancel 和 fan-out 不产生重复 task、越界并发或幽灵容器。

### Task 6: Verify Session, Activity And Monitoring Streams

**Files:**

- Modify: `packages/server/src/services/scan/runtime/driver-stdout-tail-reader.test.ts`
- Modify: `apps/vulseek/__test__/server/agent-stream-api.test.ts`
- Modify: `apps/vulseek/__test__/server/scan-monitoring-hub.test.ts`
- Modify: `apps/vulseek/__test__/agent-stream-state.test.ts`
- Modify: `apps/vulseek/__test__/agent-stream-transport.test.ts`

**Interfaces:**

- Consumes: incremental stdout reader, native transcript locator, AgentStream SSE and monitoring hub.
- Produces: Stream correctness under append, reconnect, truncate and multiple subscribers.

- [ ] 覆盖 stdout append、半行 JSONL、无变化、truncate、inode replacement 和 reader reset。
- [ ] 验证两个订阅者共享一次文件读取，慢轮询不会重叠，最后一个订阅者离开后释放 watcher/cache。
- [ ] 验证运行中 task Session 增量更新；已完成 task 从原生 Codex/Claude transcript 读取历史，不回退到 sandbox event。
- [ ] 模拟 SSE 断线重连与文件重建，断言发送新 snapshot 后继续 append，不重复或丢失 turn。
- [ ] 验证 Monitoring 与 Running Tasks 对同一 activity/status/token 使用一致快照。
- [ ] task 没有 session 文件时显示 waiting/source unavailable；不得导致整个 Tasks 页失败。
- [ ] 运行：

```bash
pnpm --filter vulseek test -- \
  driver-stdout-tail-reader \
  agent-stream \
  scan-monitoring-hub \
  task-session-stream
```

预期：流式状态可恢复、无重复读取，缺失文件只影响对应面板。

### Task 7: Add Longitudinal Progress And Resource Auditing

**Files:**

- Create: `apps/vulseek/__test__/scan/research-progress-audit.ts`
- Create: `apps/vulseek/__test__/scan/research-progress-audit.test.ts`
- Modify: `apps/vulseek/__test__/scan/research-registry-db.integration.test.ts`

**Interfaces:**

- Produces: `ResearchProgressSnapshot` containing definition hash, frontier, task/route counts, Registry counts/revisions, pending dispatch age, token totals, artifact bytes and last meaningful progress time.
- Produces: `buildResearchProgressSignature(snapshot)` and `diffResearchProgress(previous, current)`.
- Consumes: read-only Job, task, Registry and artifact metadata; never reads credential content.

- [ ] 按 `scanPipelineDefinitionSnapshot` hash 对历史 Job 分组，禁止把不同 snapshot 的 route、schema 和失败率直接合并比较。
- [ ] 定义 meaningful progress：新增唯一 surface/Track/Finding/Primitive/Chain、已有 projection revision 增加、Finding/Chain 状态前进或 pipeline frontier 首次到达新 stage。
- [ ] progress signature 不包含 task 数量、自然语言变化、时间戳或 token 增长，避免把无效循环误判成进度。
- [ ] Finding 连续完成两轮 Validation + Review，但 Registry status/revision、evidenceRefs 和 requiredEvidence canonical hash 均未变化时，标记 `stalled-finding-loop`。
- [ ] 同一 lineage 连续两次 `new-surface`，但 surface inventory hash、唯一 entrypoint 和 trust boundary 均未增加时，标记 `stalled-surface-loop`。
- [ ] Track queued 超过两个 Track Plan iteration 且从未获得 Discovery task 时，标记 `track-starvation`；新 Track key 已存在时标记 `duplicate-track-growth`。
- [ ] 运行中的 Job 存在 `completed + pending` 超过 30 秒时标记 `dispatch-stalled`；Job 为 running 且 15 分钟没有 active/pending task 时标记 `orphan-runtime`。
- [ ] 计算 funnel：Job -> Track Review -> Finding -> Primitive -> Chain -> Exploit -> Report，并把“task completed 但 effect/event 缺失”单列为 consistency failure。
- [ ] 计算资源斜率：`artifactBytes/taskCount` 必须不高于 15 MiB，agent-home p95 不高于 25 MiB；最近 500k tokens 没有 progress signature 变化时标记 `token-runaway`。
- [ ] agent profile 有价格配置且 totalTokens > 0 时 estimated cost 必须大于 0；没有价格配置时返回 `null/unavailable`，不得用 `0` 冒充已计算成本。
- [ ] 以历史高频循环、Track 爆炸、双 Chain ID、Broker 失败后成功和正常 dispatch fixture 验证每种诊断只命中对应根因。
- [ ] 运行：

```bash
pnpm --filter vulseek test -- research-progress-audit
```

预期：审计器能区分“持续创建 task”和“真正推进 Registry/漏斗”，并能在资源失控前给出确定原因。

### Task 8: Execute One Active Dev Research Scan

**Scope:** 使用 dev UI 创建一个新 Research Job；不等待 Job 终态。

- [ ] 确认 dev 服务、数据库、Redis、Docker network、checkout image、tools image、Broker token 和 pipeline definition 均可用。
- [ ] 使用 agent-browser 登录 dev，在现有可 checkout 的 Project/Profile 上创建 `scanType=research` 的 Job，并记录 `RESEARCH_JOB_ID`。
- [ ] 确认 DB 中保存 `scanType=research`、当前 pipeline snapshot hash、runtime settings 和 12 个 stage settings；所有 task 必须保持同一 definition hash，且不得出现 `candidate-found` 或 Candidate 字段。
- [ ] 观察 `research-scope -> surface-map -> track-plan -> vulnerability-discovery -> track-review`，每 60 秒记录 task/queue/runtime 状态，每 5 分钟生成一次 `ResearchProgressSnapshot`。
- [ ] 每个出现的 task 检查 `input.json`、`output.schema.json`、`output.json`、stdout、activity、agent-home 和原生 session JSONL。
- [ ] 确认 task 名称描述实际目标，不是 stage 名加编号或未渲染的 `$file(...)` 模板。
- [ ] Track Review 完成后确认：
  - output 不含 `reviewPath`；
  - DB `downstreamRouteKey` 等于 agent 原始 route；
  - `downstreamDispatchStatus=completed`；
  - 子 task 的 `inputs/track-review.json` 与父 output 完全一致；
  - route 对应的下游 stage 正确。
- [ ] 从该 task container 调用 Research Broker，并确认无 404、401、context missing 或 credential fallback。
- [ ] 对每个 completed Research task 验证对应 Registry effect/event 已提交；发现 `stage.post_success_handling_failed`、Broker 错误文本或 effect 缺失时立即判定失败，不继续把下游 task 当成有效进度。
- [ ] 若真实输出包含 Finding，验证 Finding projection/event 与 Finding artifact 一致，并最多观察两轮 Validation/Review；两轮后无 meaningful progress 必须报告 stalled loop。
- [ ] 若自然到达 Primitive/Chain，验证其 ID、引用和 capability 兼容性；若未自然到达，由 Task 1 的深层 fixture 提供覆盖，不人工伪造真实 Job 输出。
- [ ] 45 分钟内必须完成 Track Review 回归检查点。之后只有 progress signature 在每 15 分钟窗口内发生 meaningful change 才继续观察，最长 120 分钟；连续一个窗口无进度则取消并诊断。
- [ ] 每 15 分钟记录累计 tokens、Job bytes、agent-home p95、queued Track 数和最老 pending dispatch；达到 Task 7 的 runaway/stall 条件时提前取消。
- [ ] 不以 Job completed 为目标；达到深层自然检查点、失去业务进度或 120 分钟上限后进入清理。

### Task 9: Verify Dev UI And API Against The Active Job

**Files exercised:**

- `apps/vulseek/components/dashboard/scanning/show-scan-job-detail.tsx`
- `apps/vulseek/components/dashboard/scanning/research-registry-panels.tsx`
- `apps/vulseek/server/api/routers/scan.ts`
- `apps/vulseek/pages/api/scan/jobs/[scanJobId]/activities.ts`
- `apps/vulseek/pages/api/scan/tasks/[taskId]/agent-stream.ts`

- [ ] 验证 Overview、Tasks、Findings、Tracks、Primitives、Chains、Monitoring、Files 标签均显示，URL、选中状态和刷新恢复一致。
- [ ] 验证 Full/Delta Job 不显示 Research Registry 标签，避免共享 shell 回归。
- [ ] Running Tasks 数量、stage、动画、activity 和取消按钮与 API/DB 一致。
- [ ] Finished Tasks 的 completed/failed/canceled、搜索、stage/status filter、分页及 total 一致。
- [ ] Findings、Tracks、Primitives、Chains 验证 loading、empty、error、数据行、搜索、枚举过滤、排序、分页、详情和长文本换行。
- [ ] Monitoring 验证运行 stage、activity、token 和队列状态；Files 验证目录导航和 artifact 打开；Session 验证实时 append 与“跳到最新”。
- [ ] Overview/Monitoring 显示的 frontier、Registry 数量和 token 必须与 `ResearchProgressSnapshot` 一致；task 数增长但业务 signature 不变时不得展示为正常推进。
- [ ] 记录 `jobOverview`、`jobRunningTasks`、`jobQueueCounts`、`terminalTasks` 和四个 Registry API 连续 10 次延迟，p95 应低于 `500ms`。
- [ ] 检查浏览器 console、failed requests、重复 SSE 和 React 渲染错误；Next.js dev HMR 警告单独记录，不与业务错误混合。

### Task 10: Cancel And Prove Cleanup

- [ ] 从 UI 取消 Active Research Job，记录取消时间。
- [ ] 确认 DB Job 为 canceled，活动 task 最终为 canceled/exited，之后不再产生新 child task。
- [ ] 确认 runtime registry 删除该 Job，BullMQ 无该 Job 的 active/waiting entry。
- [ ] 等待已有 stop/cleanup 流程完成，确认无匹配 task container、agent process 或临时 Broker credential file。
- [ ] 确认 Files 和 Session 仍能读取已完成/已取消 task 的历史 artifact。
- [ ] 保留 Job 和非敏感 artifact 作为测试证据；只清理自动化测试创建的临时 Registry rows。

---

## Failure Injection Matrix

| Failure | Injection | Expected behavior |
| --- | --- | --- |
| Review 输出旧 `reviewPath` | 固定 output 增加字段 | schema fail，无 child task |
| Review artifact 为自然语言/越界路径 | edge fixture | artifact validation fail |
| 非法 route | output envelope 使用未知 key | task fail，不走默认边 |
| Dispatch 中断 | completion 后 enqueue 抛错 | `completed + pending`，保留原 route |
| Runtime 重启 | pending dispatch 后重建 runtime | 同一 child/task/job ID 恢复 |
| Broker token 缺失/错误 | fake driver env/API request | 明确 infra error/401，无 auth fallback |
| Broker task/job 不匹配 | CrossJobFixture | 403，无跨 Job 数据 |
| Broker helper 失败但 agent 继续输出 | fake tool failure + schema-valid output | stage 不得产生依赖 Registry 的业务效果 |
| Registry effect 在 task completion 后失败 | effect mock 抛错 | 不 dispatch，下游看不到伪成功 |
| Registry effect 重放 | 同一 idempotency key 执行两次 | 单 event，revision 只增加一次 |
| Registry revision 冲突 | stale expectedRevision | 拒绝覆盖，保留较新 projection |
| Chain 使用 `id` 而非 `chainId` | Chain fixture 缺少稳定 ID | schema fail，不生成随机/重复 Chain |
| Chain 引用未知或跨 Job Primitive | Registry fixture | persistence fail，无 Chain/event |
| Finding Validation/Review 原地循环 | 两轮无状态或证据增量 | 标记 stalled 并停止继续分发 |
| Track/new-surface 爆炸 | 重复 surface hash 和 Track key | 去重并报告 stalled/starvation |
| Snapshot 中出现旧 Candidate route | 当前 definition fixture 注入 `candidate-found` | contract fail，禁止启动新 Job |
| Completed dispatch 长时间 pending | 将 dispatch 时间推进 30 秒 | 标记 stalled，recovery 后清除 |
| Running Job 无 task | 清空 active/pending 并保留 running | 标记 orphan runtime |
| Token 持续增长但无 Registry 进度 | 500k token 无 signature 变化 | 标记 token runaway |
| Agent-home/artifact 线性膨胀 | 生成超过资源斜率的 fixture | 资源 gate fail，指出增长来源 |
| Session 文件截断/替换 | 临时 JSONL truncate/rename | reset snapshot 后继续 append |
| Pause/cancel 竞态 | claim 前后切换 Job 状态 | 不启动新 task，不接受迟到副作用 |
| Fan-out 压力 | 固定生成超过 concurrency 的 items | 并发受限、无重复 queue job |
| 模型无 output/未调用工具 | fake adapter end_turn | task 明确失败，可诊断，不生成空 Registry |
| Docker `runc` 连续失败 | dev 容器操作 | 归类基础设施问题，记录并按约定恢复 |

## Final Verification

```bash
pnpm --filter vulseek test
pnpm --filter @vulseek/server typecheck
pnpm --filter vulseek typecheck
node --test packages/server/src/services/dockerfiles/vulseek-acp-driver.test.mjs
bash -n dev.sh run.sh scripts/research-broker-token.sh
git diff --check
```

## Acceptance Criteria

- Track、Chain、Exploit Review 均由 pipeline 生成 review artifact，LLM output 不再携带路径。
- 原始 route 与 completion 同事务保存；dispatch 失败、fallback 和 runtime 重启均不会覆盖或丢失 route。
- Broker 在 dev 容器网络可达，401/403/200 语义正确，token 不进入持久化 artifact、adapter env 或日志。
- Tracks、Findings、Primitives、Chains 使用稳定且严格的 ID/schema；projection、event、task effect 一致，重试幂等且 Job 间隔离。
- task 只有在必需 Registry effect 成功后才具有业务完成语义；Broker/effect 失败不能继续生成下游伪进度。
- 确定性 fixture 走通全部 12 个 stage，覆盖 Primitive、Chain、Exploit 和 Report；真实 Job 不要求终态。
- 两轮 Finding loop、两轮重复 surface loop、Track starvation、orphan runtime 和 30 秒以上 pending dispatch 均能被自动识别。
- progress signature 只反映业务状态前进，单纯增加 task、自然语言、token 或 artifact 不算进度。
- Job artifact 平均增长不超过 15 MiB/task，agent-home p95 不超过 25 MiB；500k tokens 无业务进度会触发 runaway。
- Task、DB、artifact、API、Monitoring、Session 和 UI 对同一状态达成一致。
- 真实 Job 至少完成一次 Track Review 到下游 task 的分发，并在有进度时进行最长 120 分钟纵向观察，随后可安全取消且无残留容器。
- 所有确定性测试、typecheck、shell syntax 和 diff check 通过；任何剩余问题都有 taskId、证据和明确归因。
