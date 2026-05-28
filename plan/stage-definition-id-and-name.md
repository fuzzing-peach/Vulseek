# Stage Definition 拆分 `id` 与可读 `name`

## Summary

把现有 `StageDefinition.name` 拆成两个字段：

- `id`: 程序统一标识符，使用 kebab-case，用于 DB stage key、pipeline lookup、queue/runtime/path/container 拼接、settings key。
- `name`: 可读展示名，使用动词或动词 + 对象，用于前端展示、日志中面向人的 label、stage graph 标题。

本次同时迁移旧 DB 数据，把旧 PascalCase stage name 统一改成新的 kebab-case id。

## Key Changes

- 修改 stage definition 类型：
  - `StageDefinition` 改为 `{ id: string; name: string; ... }`。
  - `createStageDefinition` 要求调用方显式传入 `id` 和 `name`，不再在各 stage factory 内用默认 `input.name || ...`。
  - pipeline、runner、routing、group、runtime state、route schema、queue 相关逻辑全部用 `stage.id` 做程序匹配。
  - 展示、graph node label、用户可见错误文案优先使用 `stage.name`。

- 使用以下固定 stage 映射：
  - `RepositoryScanningStage` -> `id: "repository-scan"`, `name: "Scan Repository"`
  - `ModuleScanningStage` -> `id: "module-scan"`, `name: "Scan Module"`
  - `FunctionScanningStage` -> `id: "function-scan"`, `name: "Scan Function"`
  - `AnalysisStage` -> `id: "analyze"`, `name: "Analyze"`
  - `FuzzBuildStage` -> `id: "build-fuzzer"`, `name: "Build Fuzzer"`
  - `FuzzRunStage` -> `id: "run-fuzzer"`, `name: "Run Fuzzer"`
  - `AnalysisCriticStage` -> `id: "critique-analysis"`, `name: "Critique Analysis"`
  - `VerifyingStage` -> `id: "verify"`, `name: "Verify"`

- 迁移持久化 stage key：
  - 新增 migration，把以下位置的旧 PascalCase stage name 改成新 kebab-case id：
    - `tasks.stageName`
    - `scan_stage_lane_runtimes.stageName`
    - `scan_stage_group_lane_memberships.stageName`
    - `application.scanStageSettings` JSON object keys
    - `compose.scanStageSettings` JSON object keys
  - DB column 暂不重命名，`stageName` 字段继续保留，但语义变为“stage id”；代码层逐步用 `stageId` 命名新变量/API 字段。
  - 旧运行队列不做在线兼容，部署前需要没有 active scan job。

- 更新前端和 API：
  - `stageGraph` 返回 `stageId` 和可读 `name`；保留 `stageName: stageId` 作为兼容字段。
  - graph 节点展示 `node.name`，ReactFlow node id 使用 `stageId`。
  - stage settings panel 的 key 改用新 stage id，label 改用可读 `name`。
  - task detail/list 的 stage label 映射支持新 id，不再依赖 PascalCase 自动格式化。

## Test Plan

- 单元测试：
  - pipeline routing 测试更新为 `id + name`，确认路由选择逻辑仍按 `id` 工作。
  - `resolveStageTaskName` 更新为新 stage id，并覆盖 8 个 stage。
  - queue job id / retry failed tasks / candidate task lookup 的 stage id 映射测试更新。
  - stage graph API 测试或轻量断言：node `stageId` 为 kebab-case，`name` 为可读动词式名称。

- 迁移验证：
  - 准备包含旧 PascalCase stage key 的 `tasks`、lane runtime、group membership、application/compose `scanStageSettings` 数据。
  - 执行 migration 后确认全部变为新 kebab-case id。
  - 确认 migration 对空 JSON、缺失 key、已经是新 id 的 key 幂等安全。

- 运行验证：
  - 启动一次 wolfSSL full scan。
  - 确认新 task 的 `stageName` 存储为 kebab-case id。
  - 确认 stage graph 展示 `Scan Repository / Scan Module / Scan Function / Analyze / Build Fuzzer / Run Fuzzer / Critique Analysis / Verify`。
  - 确认 queue、runtime dir、container prefix、group lane、retry failed task 不再使用旧 PascalCase stage name。

## Assumptions

- 程序 id 统一使用 kebab-case。
- 旧 DB 数据要迁移，不只兼容读取。
- DB column 名 `stageName` 本次不重命名，避免扩大 schema 影响；它保存的是新的 stage id。
- 部署 migration 前没有正在运行的 scan job；如果有，需要先 cancel/清理，避免旧 queue job 和新 stage id 混用。
