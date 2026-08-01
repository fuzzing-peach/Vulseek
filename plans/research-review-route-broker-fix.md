# Research Review、Route 与 Broker 修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 Research pipeline 的 Review artifact 路径错误、route 丢失和 Research Broker 404，使新的 Research Scan 可以稳定完成 Track Review 及其下游分发。

**Architecture:** Review stage 只生成结构化 output，pipeline 负责把完整 `$output` 写入下游 task 的 `inputs/*.json`，并继续通过 `reviewPath` 注入生成后的 `/task` 路径。Task 完成事务保存 agent 原始 route，dispatch 只消费该 route，不再用 fallback route 覆盖数据库值。Broker 使用 dev/release 各自独立的共享环境 token，并通过 Vulseek 容器网络服务名访问 API。

**Tech Stack:** TypeScript、Drizzle/PostgreSQL、YAML pipeline definitions、Bash、Python research-db skill、Vitest、Docker Swarm、agent-browser。

## Global Constraints

- 所有实现和运行验证只操作 dev；不连接、不重启、不修改 release 实例。
- release 只修改并静态验证 `run.sh`；release token 仅在未来执行新版脚本时首次生成。
- 不新增数据库字段或 migration。
- Broker token 按环境共享，不提供 task 级 token 隔离。
- 不兼容依赖旧 Review stage 输出 `reviewPath` 的历史 pipeline snapshot；验证使用新建 Research Job。
- 不从 `auth.json`、`.credentials.json` 或 agent API token 推导 Research Broker credential。

---

### Task 1: 统一 Review Artifact Contract

**Files:**
- Modify: `packages/server/src/services/scan/pipeline/definitions/schemas/research.yaml`
- Modify: `packages/server/src/services/scan/pipeline/definitions/pipelines/research.yaml`
- Modify: `packages/server/src/services/scan/prompts/track-review.prompt.md`
- Modify: `packages/server/src/services/scan/prompts/chain-review.prompt.md`
- Modify: `packages/server/src/services/scan/prompts/exploit-review.prompt.md`
- Test: `apps/vulseek/__test__/scan/research-pipeline-artifacts.test.ts`
- Test: `packages/server/src/services/scan/pipeline/scan-pipeline-schema-contracts.test.ts`

**Interfaces:**
- `TrackReview`、`ChainReview`、`ExploitReview` output 不再包含 `reviewPath`。
- 三类 Review 的出边使用 `artifact.from: "$output"`，并通过 `inputField: reviewPath` 注入 `/task/inputs/track-review.json`、`/task/inputs/chain-review.json` 或 `/task/inputs/exploit-review.json`。
- Dynamic route envelope 的 `route` 字段和 route key 保持不变。

- [x] 在三个 schema 中删除 `reviewPath` property 和 required 项，保持 `additionalProperties: false`。
- [x] 在三个 prompt 中删除创建 review 文件和返回 `reviewPath` 的要求，明确只返回 schema 定义的结构化字段。
- [x] 修改三个 Review 的所有出边：删除 `reviewPath: "$output.reviewPath"`，将 artifact source 改为 `$output`，保留目标文件名和 `inputField: reviewPath`。
- [x] 添加测试，验证自然语言 review 内容不能进入 artifact path 解析，且生成的子 task 文件内容等于父 task 的结构化 output。
- [x] 运行 `pnpm --filter vulseek test -- research-pipeline-artifacts scan-pipeline-schema-contracts`，确认旧的 `reviewPath` output 被拒绝。

### Task 2: Persist Original Route Before Dispatch

**Files:**
- Modify: `packages/server/src/services/scan/pipeline/pipeline-runner.ts`
- Modify: `packages/server/src/services/scan/persistence/task.repo.ts`
- Test: `packages/server/src/services/scan/pipeline/completion-claim.test.ts`
- Test: add focused route persistence/dispatch retry tests under `packages/server/src/services/scan/pipeline/`

**Interfaces:**
- `persistTerminalSuccess()` 增加 `routeKey: string | null` 参数。
- `transitionTaskStatusRepo()` 的终态成功 patch 同时写入 output、token usage、完成状态和 `downstreamRouteKey`。

- [x] 所有异步完成路径将 `resolveStageRawOutput()` 得到的原始 route 传入 `persistTerminalSuccess()`；immediate、非路由和 agent exit 路径传入 `null` 或当前合法 route。
- [x] 在现有条件状态转换事务中保存原始 route，确保只有 completion claimant 能写入 route。
- [x] 删除 dispatch 成功后用 selected/fallback route 更新 `downstreamRouteKey` 的逻辑。
- [x] 保留运行时 fallback、disabled-stage fallback 和 deadline route override，但只影响当前 dispatch，不覆盖原始 route。
- [x] 添加测试覆盖并发 completion、artifact dispatch 失败后 `completed + pending`、下一轮按原 route 重试、非路由 stage 保存 `null`。
- [x] 不为历史 `downstreamRouteKey = NULL` 的 completed task 增加 backfill；历史任务使用 rerun 或新 Job 验证。

### Task 3: Broker Credential 与容器网络配置

**Files:**
- Create: `scripts/research-broker-token.sh`
- Modify: `dev.sh`
- Modify: `run.sh`
- Modify: `.gitignore`
- Modify: `packages/server/src/services/scan/runtime/run-single-turn-agent.ts`
- Modify: `apps/vulseek/pages/api/internal/scan/research-broker.ts`
- Modify: `agents/skills/research-db/SKILL.md`
- Test: `apps/vulseek/__test__/scan/research-broker-contract.test.ts`
- Test: add runtime environment and token helper tests

**Interfaces:**
- Token files：`.vulseek-secrets/research-broker-dev.token` 和 `.vulseek-secrets/research-broker-release.token`。
- URL 优先级：显式 `VULSEEK_RESEARCH_BROKER_URL`，否则 `http://${VULSEEK_SERVICE_NAME}:3000/api`，两者都缺失时 Research task 启动失败。
- API 路径、POST 方法、operation 名称和响应结构不变。

- [x] Shell helper 首次使用时以 `umask 077`、临时文件和原子 rename 生成 `openssl rand -hex 32` token；目录设为 `0700`，文件设为 `0600`，已有 token 复用，空值或非法格式明确失败。
- [x] 将 `.vulseek-secrets/` 加入 `.gitignore`，并让 `dev.sh`、`run.sh` 分别加载对应 token 后注入 `VULSEEK_RESEARCH_BROKER_TOKEN`，不打印 token。
- [x] 将 runtime 默认 Broker URL 从 host gateway + `PORT` 改为容器网络服务名；保留显式 URL 覆盖。
- [x] Scan container 使用 `-e VULSEEK_RESEARCH_BROKER_TOKEN` 从 Vulseek 进程环境继承 token，避免 token 出现在 Docker command/error 文本中。
- [x] `acp-driver-input.json` 的 `adapterEnv` 只包含 URL、scanJobId、taskId 等非敏感运行参数；token 不序列化到 task 文件。
- [x] 让 research-db skill 明确禁止读取 auth 文件作为 Broker credential；helper 缺失 token 时直接报告配置错误。
- [x] 测试 token 首次生成、重复复用、dev/release 隔离、权限、非法文件、URL override、服务名默认值和 401/403/200 API 响应。

### Task 4: Dev Research Scan End-to-End Verification

**Scope:** 只启动和操作 dev Research Job，不启动或修改 release。

- [x] 执行 `bash -n dev.sh run.sh scripts/research-broker-token.sh`。
- [x] 运行 `pnpm --filter vulseek test`、`pnpm --filter @vulseek/server typecheck`、`pnpm --filter vulseek typecheck` 和 `git diff --check`。
- [x] 重启 dev，使新 token、Broker URL 和 pipeline definitions 生效；确认 token 文件未被 Git tracking，且 token 内容不出现在 task artifact 或普通日志中。
- [x] 通过前端创建新的 Research Scan，观察至少一个 Track Review 完成并生成下游 task，不要求等待整个 Job 终态。
- [x] 检查父 task output、子 task `inputs/track-review.json`、DB 中的原始 `downstreamRouteKey` 和 dispatch 状态。
- [x] 在 scan container 中执行 `research-db list-findings`，确认返回合法 JSON，不出现 Broker 404 或 context 未配置错误。
- [x] 使用 agent-browser 验证 Tasks、Monitoring、Tracks、Findings、Primitives、Chains 标签页、加载状态、控制台错误和失败请求。
- [x] 检查 dev 日志中不存在 `Task artifact paths must be absolute paths under /task`、`Cannot POST /api/internal/scan/research-broker` 或 `research broker context is not configured`。
- [x] 验证结束后取消仍运行的测试 Job，确认没有残留 task container。

## Acceptance Criteria

- 新的 Track/Chain/Exploit Review task 不再要求 LLM 生成路径，所有下游 review 文件由 pipeline 创建。
- 任何 dispatch 失败都不会丢失 agent 原始 route；重试不会退回默认 route。
- dev Research Broker 使用 `vulseek-dev:3000` 可达，正确 token 返回 200，错误 token 返回 401。
- token 不出现在 `acp-driver-input.json`、task output 或普通 Docker 错误日志中。
- 新建 dev Research Scan 至少完成 Track Review 到下游 task 的分发，且前端和 API 无相关错误。
