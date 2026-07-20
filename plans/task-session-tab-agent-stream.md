# Task Session 标签页

## Summary

在 Task 详情页新增 `Session` 标签，复用现有 `AgentStream` 和任务级 SSE 接口，展示 Codex/Claude Code 的原生会话内容。标签始终显示，但仅在用户打开时建立 SSE 连接，避免详情页默认加载会话流。

## Implementation Changes

- 扩展 `ShowScanTaskDetail` 的标签类型和 UI，新增 `session` tab，保持 `Details` 作为默认标签。
- 复用现有 `AgentStream` 的 GitHub Light 风格、折叠 prompt/thinking/tool、结果子滚动条、自动跟随和跳转最新功能。
- Session 面板打开时创建稳定的 `SseAgentStreamTransport`，请求 `/api/scan/tasks/{taskId}/agent-stream`；切换标签或 task 时清理 EventSource。
- 运行中 task 显示实时增量内容；已完成、失败、退出 task 显示仍可定位到的 native transcript 快照。
- 没有 thread、transcript 已不存在或 task 没有原生会话时，显示明确的等待或 `source_unavailable` 状态。
- 不读取 `stdout`、`sandbox-agent-event.jsonl` 或 task output 作为 fallback。
- 增加 English 和简体中文的 Session、等待、不可用、连接失败等文案。
- 服务端继续使用现有认证、组织权限校验和 native transcript 定位逻辑，不新增数据库字段、迁移或 API 协议。

## Test Plan

- 验证 Session 标签存在且默认不建立 SSE，打开后创建 EventSource，卸载或切换标签后关闭连接。
- 覆盖 metadata、snapshot、append、done、waiting 和 stream error 事件。
- 验证运行中内容增量显示、终态 task 快照显示，以及 transcript 缺失时的不可用提示。
- 保持 AgentStream 的自动跟随、跳转最新和折叠交互测试通过。
- 补充已结束 task、persistent lane transcript 和 task transcript 路径定位测试。
- 执行 `pnpm --filter vulseek test`、`pnpm --filter vulseek typecheck`、`pnpm --filter @vulseek/server typecheck` 和 `git diff --check`。
- 使用 agent-browser 验证运行中及已结束 task 的 Session 页面。

## Assumptions

- Session 标签始终显示并按需加载，不作为默认标签。
- Codex/Claude Code 原生 transcript 是唯一会话来源。
- transcript 缺失时不回退到旧日志或 task output。
- Session 页面沿用现有 AgentStream 视觉和交互，不重新实现 viewer。
