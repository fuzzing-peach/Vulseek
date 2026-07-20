# 外置 Pipeline 配置并支持无重启更新

## Summary

将 pipeline 定义及其 prompt 文件从 Vulseek 构建产物中移除，改为通过 `VULSEEK_SCAN_PIPELINE_DEFINITIONS_PATH` 指定外部资源目录。

采用“创建 Job 时生成 snapshot”的语义：

- 新建 Job 时读取并校验当前外部 YAML。
- 将完整 pipeline 配置及 prompt 内容保存到现有 `scanPipelineDefinitionSnapshot`。
- pipeline 启动时继续读取该 Job 的 snapshot。
- 外部配置更新后无需重启服务，新 Job 立即使用新配置。
- 已有 Job 保持原 snapshot，不受后续配置修改影响。

## Implementation Changes

- 新增外部配置加载器：
  - 从环境变量目录读取 `schemas/`、`stages/`、`pipelines/`。
  - 同目录读取 YAML 引用的 `promptFile`。
  - 解析、校验、规范化失败时拒绝创建 Job，并输出明确错误。
  - 不再回退到 `dist/definitions` 或源码目录。
  - 加载时将 `promptFile` 内容解析并写入 snapshot，保证 Job 配置完整且不可变。

- 调整 pipeline 定义使用方式：
  - 移除模块加载时固定读取仓库内 YAML 的 `SCAN_PIPELINE_DEFINITIONS` 运行时依赖。
  - `createScanJobRepo` 每次创建 Job 时调用外部配置加载器。
  - pipeline runtime 继续通过 `loadScanJobPipelineDefinitionSnapshotRepo` 获取配置。
  - UI/API 的 pipeline metadata 也改为读取当前外部配置，或统一从明确的外部配置加载入口获取。

- 移除构建产物复制：
  - 删除 `copyScanPromptTemplates` 对 `pipeline/definitions` 和 prompt 的复制逻辑。
  - 删除 Dockerfile 中将 definitions/stages/prompts 复制进最终镜像的步骤。
  - 保留测试所需的 fixture，不将正式配置作为 server build artifact。

- 更新运行环境：
  - `dev.sh` 设置 `VULSEEK_SCAN_PIPELINE_DEFINITIONS_PATH=/opt/vulseek/scan-pipeline`，并将 dev 配置目录只读挂载到容器。
  - `run.sh` 使用独立的 release 配置目录和同一容器路径，避免与 `/etc/vulseek` 数据卷嵌套挂载。
  - 两套环境禁止共享配置目录。
  - 外部配置更新采用临时目录写入后原子替换，避免服务读取半套 YAML。

## Test Plan

- Loader 测试：
  - 正确加载 schemas、stages、pipelines 和 prompt 文件。
  - 缺文件、重复 key、非法 YAML、schema 错误、非法 prompt 路径均明确失败。
  - 修改外部 YAML 后，下一次创建 Job 使用新配置，无需重启进程。

- Snapshot 测试：
  - 新 Job 保存外部配置和已解析 prompt 内容。
  - 外部配置更新后，旧 Job 仍使用旧 snapshot。
  - pipeline 启动使用 snapshot，不重新读取当前外部 YAML。

- 构建与运行验证：
  - 构建产物中不存在 `dist/definitions`、内置 pipeline prompt。
  - dev 容器能够通过挂载目录创建并运行 Job。
  - `pnpm --filter @vulseek/server typecheck`
  - `pnpm --filter vulseek typecheck`
  - pipeline 定义和 snapshot 相关 Vitest 测试。
  - `git diff --check`

## Assumptions

- 不新增数据库字段或 migration，继续使用现有 `scanPipelineDefinitionSnapshot`。
- “热更新”定义为：服务无需重启，外部配置更新后新建 Job 使用新配置。
- 运行中的 Job 和已有 Job 不动态切换配置。
- production 外部配置目录是必需配置；未设置或目录无效时服务启动/创建 Job 应明确报错，而不是回退到镜像内文件。dev 默认使用源码挂载的 scan 资源目录，也不读取构建产物。
