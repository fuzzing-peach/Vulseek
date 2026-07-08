# YAML 定义 Scan Stage 与 Pipeline v1

## Summary

在新分支 `codex/yaml-scan-pipeline-definition` 上实现 YAML v1：YAML 作为 scan stage metadata、pipeline edges、groups、route、默认 concurrency、是否可禁用的唯一配置源。Stage executor、edge transform/createTasks、schema parser 仍保留 TypeScript registry，不在 v1 动态化，避免把复杂运行时逻辑塞进 YAML。

默认分支策略：基于当前工作树创建新分支，因为当前 `main` 已有旧 stage 清理改动；先建分支再改文件，避免后续切分支丢改动。

## Key Changes

- 新增 `packages/server/src/services/scan/pipeline/scan-pipelines.yaml`，定义 `stages`、`pipelines.full`、`pipelines.delta`、`edges`、`groups`、`route`、`defaultConcurrency`、`maxConcurrency`、`disableable` 和描述信息。
- 新增 YAML loader + Zod 校验，启动时 fail-fast 检查重复 stage、未知 edge endpoint、未知 group member、route 默认值规则，并导出 serializable catalog 给后端和 UI 使用。
- 后端从 YAML 派生 `SCAN_STAGE_IDS`、display name helpers、full/delta stage ids、root stage、disableable 状态和默认 concurrency。
- Pipeline runtime 使用 YAML 拓扑 + TypeScript registry：stage id 绑定现有 `StageDefinition`，edge name 绑定现有 `transformOutput/createTasks/outputSchema` 实现。
- Graph API 和 scan stage settings UI 不再维护硬编码 stage/edge/group 列表，改为消费 YAML 解析后的 catalog。
- `repository-profile` 和 `delta-scope` 默认 `disableable: false`；其他 stage 默认可禁用。

## Implementation Notes

- 创建分支：`git switch -c codex/yaml-scan-pipeline-definition`。
- 不回退或丢弃当前工作树中的旧 stage 清理改动。
- 不在 v1 中把 prompts、input/output schemas、executor 函数或 task creation logic 写进 YAML。
- 不做 codegen；前端通过服务端解析后的 catalog 获取配置。

## Test Plan

- YAML loader 单测覆盖合法 full/delta pipeline、重复 stage、未知 edge endpoint、未知 group member、route 默认值错误、缺失 registry implementation。
- Runtime settings 单测覆盖未知 stage 过滤、`disableable=false` stage 不能被禁用、用户 concurrency 覆盖 YAML 默认值。
- Pipeline 组装测试确认 full/delta stage 顺序、edge route 和当前行为一致。
- Graph/settings 测试确认 nodes、edges、groups、default/max concurrency、disableable 来自 catalog。
- 验证命令：
  - `pnpm --filter @vulseek/server typecheck`
  - `pnpm --filter vulseek typecheck`
  - targeted `tsx --test` for YAML loader, pipeline routing, runtime settings
  - `pnpm --filter vulseek test` if touched UI coverage exists

## Assumptions

- YAML 是 repo 内静态配置，不做数据库动态编辑。
- TypeScript registry 是 v1 的运行时安全边界，YAML 只定义拓扑和配置。
- 当前未提交旧 stage 清理改动会作为新分支基础状态处理，不在本计划中强制提交或拆分。
