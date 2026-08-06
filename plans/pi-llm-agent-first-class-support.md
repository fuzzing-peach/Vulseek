# Pi LLM Agent 一等支持实施计划

> **Implementation scope:** 代码和镜像同时支持 dev/release，但数据库迁移、镜像构建、运行验证和浏览器验收只在 dev 执行；不连接、不修改、不重启 release。

**Goal:** 将 Pi 作为与 Codex、Claude Code 并列的第三种 Agent Provider，完整支持 Agent Profile、pipeline task、结构化输出、new/resume/fork/persistent session、实时活动、Session 回放、token/cost、MCP 和 subagent。

**Architecture:** 继续使用 Vulseek 现有 ACP driver，接入 `@victor-software-house/pi-acp@0.17.1`。该 adapter 在进程内运行 Pi `AgentSession`，由 Vulseek 通过 ACP 管理 session。Pi 固定为 `@earendil-works/pi-coding-agent@0.83.0`；对 adapter 增加 settlement 和 per-prompt usage 补丁。Pi 原生 session JSONL 仍是 Session 标签页的唯一数据源。

## Global Constraints

- 不把 Pi 伪装成 Codex，也不在未知 provider 时回退到 Codex 分支。
- Pi adapter、Pi、MCP、subagent 和 Bun 全部固定版本并在 tools image 构建时安装；task 运行时不得联网安装。
- 目标仓库中的 `.pi/extensions`、`.pi/agents`、`.pi/settings.json` 不作为可信配置自动加载。
- Agent API key、MCP credential 不写入 task snapshot、driver input、task artifact 或普通日志。
- Pi 暂不支持 Review Terminal；task execution、Files、Monitoring 和 Session 正常支持。
- 旧 Codex/Claude profile、snapshot、session 目录和 pipeline 行为保持兼容。

---

### Task 1: Provider、数据库与 Profile Contract

**Interfaces:**

```ts
type AgentProvider = "codex" | "claude_code" | "pi";

type PiAgentConfig = {
	llmProvider: string;
	api: "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai" | null;
	contextWindow: number | null;
	maxTokens: number | null;
	reasoning: boolean;
	inputModalities: Array<"text" | "image">;
	headers: Record<string, string>;
	compat: Record<string, unknown>;
	samplingParams: Record<string, unknown>;
	mcpEnabled: boolean;
	subagentsEnabled: boolean;
};
```

- [ ] 为 PostgreSQL `agentProvider` enum 增加 `pi`，并为 `agent_profiles` 增加可空 `pi_config` JSONB；生成 Drizzle migration 和 snapshot。
- [ ] 扩展 Agent Profile CRUD、共享类型和 `TaskAgentProfileSnapshot`；snapshot 保存全部非敏感 Pi 配置和插件开关。
- [ ] `llmProvider` 和 `model` 对 Pi 必填。内置 provider 允许 `baseUrl/api` 为空；自定义 endpoint 必须同时提供 URL 和 API protocol。
- [ ] `api_key` 生成 Pi `auth.json`；`host_home` 只读取 `<homePath>/auth.json`。API key 为空时仅允许显式配置的 keyless custom endpoint。
- [ ] Agent Profile UI 增加 Pi 选项、模型协议、context/max token、reasoning、modalities、headers/compat/sampling advanced JSON，以及 MCP/subagent 独立开关。
- [ ] 新建 Pi Profile 默认启用 MCP 与 subagent；复制、编辑和禁用 Profile 时完整保留配置。
- [ ] 建立集中式 `AGENT_PROVIDER_CAPABILITIES`，描述 transport、nativeGoal、reviewTerminal、MCP、subagent、resume 和 fork；替换所有“Claude else Codex”分支。

### Task 2: Tools Image 与 Pi ACP Adapter

- [ ] tools image 固定安装 Bun `1.3.14`、Pi `0.83.0`、`@victor-software-house/pi-acp@0.17.1`、`pi-mcp-adapter@2.20.1` 和 `@mjakl/pi-subagent@3.0.0`。
- [ ] 将 adapter 安装到独立 `/opt/vulseek-pi`，通过 npm override/dedupe 强制其 `@earendil-works/pi-coding-agent` 解析为 `0.83.0`；构建时用 `npm ls` 和命令 smoke test 验证实际版本。
- [ ] 增加版本固定的 `pi-acp-0.17.1.patch`：不能直接修改 npm package，也不能在运行时动态 patch。
- [ ] 将 adapter 的 prompt 完成条件从 `agent_end` 改为 `agent_settled`，因为 retry、compaction 和 queued continuation 可能在 `agent_end` 后继续。
- [ ] adapter 在每个 ACP prompt 开始前记录 Pi session usage/cost，结束后返回 delta；禁止把累计 session totals 当作当前 task usage。
- [ ] 保留 `usage_update` 的 context `used/size` 语义；PromptResponse 返回当前 prompt 的 input/output/cacheRead/cacheWrite delta。
- [ ] 验证 adapter advertises `sessionCapabilities.resume/close/fork`，fork 生成新的 Pi session ID，resume 不创建重复 session。
- [ ] tools image content hash 纳入 Pi package versions、adapter patch 和相关 driver 文件，继续区分 dev/release image tag。

### Task 3: Pi Home、模型与受控资源加载

- [ ] 每个 task/lane 创建容器内临时 `PI_CODING_AGENT_DIR`，权限 `0700`；将认证、settings、models、extensions 和 agent definitions 放在该目录。
- [ ] 原生 session 单独持久化到 `<job-agent-home>/pi/<agentProfileId>/sessions`，并设置 Pi session directory；凭证不得落入持久化 agent-home。
- [ ] API-key 模式生成权限 `0600` 的 `auth.json`；host-home 通过 helper container 只复制 `auth.json` 并校验 source/target hash，不复制整个 home。
- [ ] 根据 Profile 生成 `models.json`：支持 Pi 内置 provider，以及 OpenAI Completions、OpenAI Responses、Anthropic Messages、Google Generative AI custom endpoint。
- [ ] 根据 Profile 生成受控 `settings.json`，禁用版本检查和交互式启动信息；模型和 thinking 必须在首个 prompt 前校验成功。
- [ ] 仅将 YAML 当前 stage 声明的 skills 链接到 Pi home；不再依赖固定 runtime skill 列表。
- [ ] 仅将 Vulseek 安装的插件链接到 Pi home `extensions/`；拒绝项目 `.pi` resources 和未声明 extension。
- [ ] 并发 task 使用独立临时 Pi home；同 Profile 可以共享 session 根目录，但不得共享可变 auth/settings 临时文件。

### Task 4: ACP Driver 与 Pipeline Execution

- [ ] driver 对 Pi 启动 `/opt/vulseek-pi/node_modules/.bin/pi-acp`，Codex/Claude 的 adapter 命令保持不变。
- [ ] Pi 使用现有 ACP `session/new`、`session/resume`、`session/fork`、`session/prompt`、`session/cancel` 和 `session/close`；不增加第二套 pipeline completion flow。
- [ ] `new` 必须创建全新 session；`persistent` lane 复用同一 ACP session；`resume` 使用 task threadId；`fork` 使用 parentSessionId 并写回新的 threadId。
- [ ] 保留 `/task/output.json`、schema、route envelope、nullable output 和一次 recovery prompt contract。
- [ ] recovery prompt 在同一 Pi session 中发送，其 usage 累加到当前 task；不得覆盖第一次 prompt usage。
- [ ] cancel 先发送 ACP `session/cancel`，等待 cooperative cancellation，再终止 adapter、Pi 和 subagent 进程组；canceled task 后续 output 不得触发 completion 或 dispatch。
- [ ] 处理 adapter 退出、Pi extension error、模型 error、missing output、invalid output、timeout 和 fork/resume source missing，并输出 provider/session/task 诊断字段。
- [ ] ToB Goal 的 Pi task 移除 `/goal` 前缀，使用普通结构化 objective prompt，并标记 `goalExecutionMode: "prompt"`；Codex 保持 native goal。
- [ ] Review Terminal UI 对 Pi 隐藏入口，服务端对 Pi 返回明确 unsupported，不回退到 Codex terminal。

### Task 5: MCP 与 Subagent

- [ ] 建立 provider-neutral MCP loader，读取受控 `agents/mcp`；支持现有 Codex TOML 标准字段并转换为 Pi adapter 使用的 `mcp.json`。
- [ ] MCP 默认使用单一 `mcp`/`mcpScript` 代理工具；允许每个 server 用 `directTools` 暴露白名单或全部工具。
- [ ] ACP `mcpServers` 对 Pi 不作为数据源，因为所选 adapter 尚未将其接入 Pi；Pi MCP 配置完全由 `pi-mcp-adapter` 和受控 Pi home 提供。
- [ ] 无头 task 禁止交互 OAuth、elicitation 和 approval dialog；静态 token、环境变量、stdio 和 HTTP MCP 可用，需交互认证时明确失败。
- [ ] Profile 关闭 MCP 时不链接 MCP extension、不生成 MCP config，也不向模型暴露 MCP 工具。
- [ ] 提供受控 Pi subagent definitions：`explore`、`security-review`、`full-scan`；`full-scan` 明确加载 `full-scan-subagent` skill。
- [ ] Profile 开启 subagent 时才加载插件和 definitions；最大 delegation depth 固定为 1、cycle prevention 开启、单次最多 4 个并行 calls。
- [ ] 子 Agent 继承父 Agent 的 model、thinking、stage skills、MCP 和 cwd；Full Scan 子任务默认 fresh context，不意外继续旧 named session。
- [ ] 子 Agent tool result 的 nested usage 纳入父 task；取消、超时和容器退出必须回收子进程、临时 prompt 和 session lock。

### Task 6: Native Session、AgentStream 与活动监控

- [ ] `native-agent-transcript` 增加 `pi` locator，只在服务端推导出的 `<job-agent-home>/pi/<profile>/sessions` 中按 session header ID 定位。
- [ ] `claude-replay/agent-stream` 增加 Pi parser，支持 session header、tree parentId、active branch、compaction、user/assistant/thinking/toolCall/toolResult 和 usage。
- [ ] batch parser 与 incremental parser 共用状态机，支持半行 JSONL、truncate、file replacement 和 branch 切换。
- [ ] AgentStream transport、SSE metadata、React state 和 UI provider 类型增加 `pi`；标签显示 `PI`，thinking/tool spinner、折叠、自动跟随和子滚动条沿用现有样式。
- [ ] ACP `agent_thought_chunk`、message、tool call/update 和 usage update 映射到共享 activity normalizer；未知 Pi event 记录诊断但不破坏流。
- [ ] 运行中 task 实时追加 session；completed/failed/canceled task 从原生 JSONL 加载历史；缺失时显示 `source_unavailable`，不回退到 stdout 或 sandbox event。
- [ ] Running Tasks、Monitoring、task detail、Files 和 Session 中所有 provider label、icon、过滤和序列化路径支持 Pi。

### Task 7: Token、Cache 与 Cost

- [ ] usage normalization 支持 Pi 的 `inputTokens/outputTokens/cachedReadTokens/cachedWriteTokens` 及原生 JSONL `input/output/cacheRead/cacheWrite`。
- [ ] persistent/resumed session 仅保存当前 task 的 prompt delta；结构化输出 recovery 和 nested subagent usage计入同一 task。
- [ ] `thoughtTokens` 在 Pi 没有明确字段时保存为 `0`，不能从 thinking 文本长度估算。
- [ ] Job token 聚合移除 Claude-only cached token 分支，对所有 provider 累加 task 持久化字段。
- [ ] cost 继续逐 task 使用 snapshot 中的 model 与 `pricingProvider` 计算，不能用 Job 聚合 token 统一计价。
- [ ] Pi adapter 自报 cost 只作为诊断比对，不覆盖 Vulseek task cost；两者明显不一致时输出 warning。

### Task 8: Tests 与 Dev 验收

- [ ] Migration/API/UI 测试覆盖 Pi Profile 创建、编辑、复制、条件字段、插件开关、snapshot 和 stage settings 选择。
- [ ] Adapter conformance 测试覆盖 `new/resume/fork/close/cancel`、thinking、tool update、`agent_end` 后 retry、最终 `agent_settled` 和 PromptResponse usage delta。
- [ ] 使用本地 fake OpenAI Responses/Completions、Anthropic 和 Google endpoint 验证模型配置，不依赖外部计费 API。
- [ ] Credential 测试覆盖 API key、host-home、并发 Profile 隔离、文件权限和 secret 不进入 driver input/artifact/log。
- [ ] MCP 测试使用 mock stdio/HTTP server 覆盖 discovery、proxy call、directTools、超时、取消、错误和无头认证失败。
- [ ] Subagent 测试覆盖单任务、4 路并行、深度/循环限制、model/thinking 继承、nested usage、取消和无残留进程。
- [ ] Session parser/SSE/React 测试覆盖 snapshot、append、half-line、branch、compaction、tool correlation、truncate、历史 session 和 unavailable。
- [ ] 分别使用 Pi Profile 创建短时 Full、Delta、Research 和 ToB Goal dev Job；每个至少完成首个 agent stage 和一次下游 dispatch。
- [ ] 使用 agent-browser 验证 Profile、Advanced Stage Settings、Tasks、Running activity、Monitoring、Files、Session、失败提示和浏览器控制台。
- [ ] 取消所有测试 Job，确认 BullMQ 无 active/waiting entry，Docker 无 Pi/task 残留容器，当前用户无残留 Pi/subagent 进程。

## Verification Commands

```bash
node --test packages/server/src/services/dockerfiles/vulseek-acp-driver.test.mjs
pnpm --dir vendor/claude-replay test
pnpm --filter vulseek test
pnpm --filter @vulseek/server typecheck
pnpm --filter vulseek typecheck
git diff --check
```

另需构建 dev scan-tools image，并在容器内验证：

```text
bun --version = 1.3.14
pi --version = 0.83.0
pi-acp package = 0.17.1
pi-mcp-adapter package = 2.20.1
@mjakl/pi-subagent package = 3.0.0
```

## Acceptance Criteria

- Pi Profile 可以被任意 pipeline stage 选择并稳定执行结构化 task。
- new、resume、fork、persistent 和 cancel 的 session 语义与现有 pipeline 一致，rerun 不意外复用旧 session。
- ACP prompt 只在 `agent_settled` 后完成，persistent task token/cost 不重复累计。
- Pi task 能使用受控 skills、MCP 和最多 4 个 subagents，且关闭 Profile 开关后相关工具完全不可见。
- Running activity、Monitoring 和 Session UI 能正确展示 Pi 的 thinking、tool call/result、usage 和历史会话。
- Full、Delta、Research、ToB Goal 的 dev 冒烟测试通过，清理后无队列、容器、进程或 credential 残留。
- release 环境未被连接、迁移、重启或修改。
