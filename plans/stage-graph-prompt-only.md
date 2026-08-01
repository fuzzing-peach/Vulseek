# 统一使用 Stage Graph Prompt

## Summary

删除所有 `buildXXXPrompt` fallback 构建逻辑，prompt 的唯一来源改为 Stage Graph 中配置的 `runtimeConfig.prompt` 或 `runtimeConfig.promptFile`。所有 stage 在执行时使用同一组运行时变量渲染 prompt，正常执行和 rerun 使用完全相同的流程。

## Implementation Changes

- 保留现有 `.prompt.md` 文件作为 `promptFile` 内容，不搬进 YAML。
- 删除 `prompts/*prompt.ts` 中的 `buildXXXPrompt`，以及 analyze、critique、verify、triage stage 内的本地 prompt builder 和 fallback 构建逻辑。
- 保留并维护现有 stage prompt Markdown 文件，作为 Stage Graph 的唯一默认来源。
- 重构 `resolveStageRuntimePrompt`：
  - 从当前 job 的 Stage Graph snapshot 获取 `prompt`，或通过 `promptFile` 加载模板。
  - `runtimeConfig.prompt` 优先于 `promptFile`。
  - 两者都缺失时抛出明确错误，不使用源码 fallback。
  - 使用 `renderPromptTemplateString` 替换模板变量。
  - 未替换变量或变量缺失时失败，禁止将 `{{...}}` 发送给 agent。
- 所有 stage 统一使用：

  ```ts
  const promptTemplate = await resolveStageRuntimePromptTemplate(ctx);

  prompt: await resolveStageRuntimePrompt(ctx, promptTemplate, {
  	...values,
  });
  ```

- 为 `delta-scope`、`analyze-finding`、`critique-finding`、`verify-finding`、`triage-finding` 补齐完整变量传递。
- 保持 attack-surface-model、identify-target、repository-profile、scan-target 当前已有的变量传递方式。
- 校正 prompt 文件中的旧 skill 路径和名称：`analyze` 改为 `analyze-finding`，`criticize` 改为 `critique-finding`，其他名称与 Stage Graph 的 `skills` 配置一致。
- 校验所有内置 Stage Graph YAML 都配置有效的 `promptFile`；缺失配置在 pipeline definition 校验阶段失败。
- 不修改 rerun 的 task 创建和 artifact 复制逻辑；rerun 自动复用同一套 Stage Graph prompt 渲染流程。

## Tests

- 删除 prompt builder 直接调用测试，改为 Stage Graph prompt 渲染测试。
- 覆盖 promptFile 加载、直接 prompt 覆盖 promptFile、所有 stage 的变量替换、缺失变量失败、缺少 prompt 配置失败。
- 验证最终 prompt 不包含 `{{...}}`。
- 增加 analyze、critique、verify、triage、delta-scope 的正常执行和 rerun 回归测试。
- 验证 rerun task 使用真实 `/task/inputs/*.json` 路径，并使用正确的 skill 路径。
- 运行相关 Vitest、server typecheck、Vulseek typecheck、Biome、server build 和 Next build。

## Assumptions

- Stage Graph 的 `runtimeConfig.prompt` 可以覆盖 `promptFile`，两者都属于 Stage Graph 配置。
- 默认 prompt 继续以 Markdown 文件保存，并由 YAML 的 `promptFile` 引用。
- Stage Graph 缺少 prompt 配置属于配置错误，直接阻止 task 执行，不保留旧 fallback。
- 正常 pipeline 和 rerun 必须走完全相同的 prompt 渲染路径。
