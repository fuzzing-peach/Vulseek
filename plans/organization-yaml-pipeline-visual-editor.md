# 组织级 YAML Pipeline 可视化编辑与通用运行改造计划

## 1. 目标与确定的产品规则

交付一个组织级共享的 Pipeline 管理模块。管理员可在同一页面通过画板或 YAML 编辑 Stage、Edge、Schema，保存无效草稿或发布不可变版本；项目 Profile 和 Evaluation Profile 均可选择已发布 Pipeline 运行。

已确定规则：

- Pipeline 归组织所有，跨项目共享。
- Owner/Admin 可创建、编辑、发布、切换版本、归档；普通成员只能查看已发布版本、选择和运行。
- 草稿不可运行；只有已发布版本可运行。
- 发布版本不可原地修改。继续编辑时，从指定版本复制出共享草稿，再发布为递增的 `vN`。
- Profile 保存 `pipelineId`，默认跟随该 Pipeline 当前发布版本；每次运行解析并冻结确切 `pipelineVersionId`。
- Run 高级选项可临时选择历史版本，但不会改变 Profile 默认值。
- Prompt 只允许 YAML 内联 `prompt`；新格式拒绝 `promptFile`。
- 运行输入固定为仓库/目标参数，不根据 Schema 动态生成自定义表单；移除 `researchScope`、`threatDirection` 等特殊运行输入。
- Pipeline 允许环路；每个版本配置任务数和时长限制，默认 `10,000 tasks / 24h`，平台硬上限 `100,000 tasks / 7d`。
- 无效 YAML 或语义错误可以保存为草稿，但不能发布。
- 纯 YAML 编辑保存原始文本和注释；第一次画板修改前提示将进行稳定序列化，之后不保证保留原注释和排版。
- V1 不包含实时多人协作、自动保存、Git 同步或任意代码/脚本插件。

## 2. YAML 契约、持久化与版本生命周期

### 2.1 统一 Pipeline Document V3

将当前分裂式 definitions 和独立 YAML runtime 合并为唯一、可前后端共享的 V3 契约。旧 V2 只保留迁移与历史运行适配器。

```ts
type PipelineDocumentV3 = {
	version: 3;
	name: string;
	description?: string;
	supportedTargets: Array<"project" | "evaluation">;
	root: string;
	limits: {
		maxTasks: number;
		maxDurationSeconds: number;
	};
	schemas: Record<string, JsonSchema>;
	stages: Record<
		string,
		{
			name: string;
			description?: string;
			role: "scan" | "analysis" | "verification";
			group: string;
			mode: "serial" | "fanout";
			concurrency: number;
			maxConcurrency?: number;
			disableable?: boolean;
			runtime: {
				kind: "agent";
				agentProfileId?: string | null;
				persistent?: boolean;
				reuseContainer?: boolean;
				nullableOutput?: boolean;
				cwd?: string;
				skills?: string[];
				prompt: string;
				prepareRepository?: "none" | "target" | "diff";
				includePolicy?: boolean;
				plugins?: AllowedRuntimePlugin[];
			};
			inputSchema?: JsonSchema;
			outputSchema?: JsonSchema;
			inputArtifacts?: ArtifactMapping[];
			outputArtifacts?: ArtifactMapping[];
			effects?: AllowedEffect[];
			report?: { path: string; required?: boolean };
			taskName?: string;
			containerNameParts?: string[];
			allowAgentExit?: boolean;
			promptValues?: Record<string, unknown>;
		}
	>;
	edges: Array<{
		id: string;
		name: string;
		from: string;
		to: string;
		fork?: boolean;
		mode?: "map" | "fanOut";
		foreach?: string;
		input?: unknown;
		artifacts?: ArtifactMapping[];
		outputSchema?: JsonSchema;
		outputSchemaDescription?: string;
		route?: { key: string; default?: boolean };
	}>;
	groups?: Array<{
		id: string;
		name: string;
		leader: string;
		members: string[];
	}>;
	ui?: {
		nodes: Record<string, { x: number; y: number }>;
		edges?: Record<string, { bendPoints: Array<{ x: number; y: number }> }>;
	};
};
```

具体约束：

- Stage、Edge、Schema、Group ID 使用稳定 slug：`^[a-z][a-z0-9_-]{0,63}$`。
- Schema 使用标准 JSON Schema；内部引用统一写为 `#/schemas/<schemaId>`。
- Stage 和 Edge 的 Schema 属性既可内联，也可通过 `$ref` 引用。
- `ui` 仅存节点位置和边折点，运行编译时忽略；缩放和视口属于用户本地偏好。
- Prompt 使用当前 `{{variable}}` 模板机制；编辑器从核心上下文、`promptValues` 和插件清单提供自动补全。
- 表达式继续支持 `$input`、`$output`、`$ctx`、`$computed`、`$item`、`$file(...)`，由前后端共用同一验证器。
- `runtime.plugins` 只能选择服务端注册的安全插件。首批迁移插件为 `research-track`、`research-deadline`、`tob-goal-native`。
- `effects` 继续采用现有安全白名单，如 candidate、research registry、tob-goal registry 操作；禁止 YAML 指定任意 JS、Shell 或模块路径。
- 编译器根据插件和 effects 自动生成 `capabilities`，供运行结果页决定是否显示 Candidates、Research、Goal 等页签。

### 2.2 数据库模型

| 实体 | 关键字段与行为 |
| --- | --- |
| `scan_pipelines` | `pipelineId`、`organizationId`、稳定 `slug`、列表用名称/描述、`draftYaml TEXT`、`draftRevision`、`draftBaseVersionId`、`currentPublishedVersionId`、`systemKey`、`archivedAt`、审计时间和用户 |
| `scan_pipeline_versions` | `pipelineVersionId`、`pipelineId`、单调递增 `versionNumber`、原始 `yaml TEXT`、`contentHash`、`compiledDefinition JSONB`、`source=user/system/migration`、发布人和发布时间；只允许插入 |
| `scan_jobs` | 新增可空 `pipelineId`、`pipelineVersionId`、`pipelineYamlSnapshot`、`pipelineCompiledSnapshot`、任务上限、`deadlineAt`、持久化任务计数、`terminationReason`；`scanType` 改为可空且仅服务旧记录 |
| `dataset_evaluations` | 将旧 `pipelineId` 重命名为 `legacyPipelineKey`，新增真正的 `pipelineId`、`pipelineVersionId`、YAML/编译快照；一次 Evaluation 的所有 Trial 固定同一版本 |
| Profile | Application、Compose、Dataset Profile 新增可空 `defaultPipelineId`，迁移默认指向组织内置 Full Pipeline |

约束：

- `(organizationId, slug)`、`(organizationId, systemKey)`、`(pipelineId, versionNumber)` 唯一。
- 发布版本不能更新或删除；存在已发布版本的 Pipeline 只能归档。
- 系统 Pipeline 不允许删除或归档，`systemKey` 不允许修改。
- 自定义 Pipeline 若仍被 Profile 设为默认，归档前必须在确认框中选择替代 Pipeline。
- 运行记录和 Evaluation 通过快照保持可复现，不受后续版本切换、归档或 Agent Profile 修改影响。

### 2.3 草稿与发布流程

- 新建来源支持空白、粘贴/导入 YAML、复制其他已发布版本。
- 每个 Pipeline 同时只有一个组织共享草稿。
- “保存草稿”直接保存原始 YAML，即使语法或语义无效；同时递增 `draftRevision` 并返回诊断。
- 使用乐观锁：客户端提交 `expectedDraftRevision`；冲突返回 `409` 和服务端版本，界面提供查看差异、重新加载、复制本地 YAML 或复制为新 Pipeline，不提供静默强制覆盖。
- “发布”可直接携带当前未保存的编辑缓冲区。服务端校验 revision、完成全量编译并在事务中插入新版本、切换 current、清空活动草稿。
- 相同 `contentHash` 不重复生成版本；返回已有版本并允许将其设为 current。
- 发布后页面进入只读版本视图；“编辑此版本”复制它为新草稿。
- “恢复历史版本”也是复制到草稿，不修改历史记录。
- 显式保存，支持 `Ctrl/Cmd+S` 和离开页面脏数据提醒；V1 不自动保存。

## 3. 后端、API 与通用运行改造

### 3.1 编译和校验

建立唯一的纯函数编译链：`raw YAML → AST → PipelineDocumentV3 → diagnostics → CompiledPipelineDefinition`。浏览器共享语法、结构和引用校验，服务端始终执行最终权威校验。

诊断统一返回：

```ts
type PipelineDiagnostic = {
	severity: "error" | "warning";
	code: string;
	message: string;
	path?: Array<string | number>;
	entity?: {
		type: "pipeline" | "stage" | "edge" | "schema" | "group";
		id: string;
	};
	location?: { line: number; column: number };
};
```

发布校验依次覆盖：

- YAML 语法、重复键、别名膨胀和文档大小。
- V3 严格字段和类型；未知执行字段视为错误。
- root、端点、唯一 ID、Group 成员、所有 Stage 从 root 可达；允许图环路。
- Route、fanOut/foreach、artifact 与模板表达式规则。
- JSON Schema 编译、`$ref` 存在性；递归 Schema 允许。
- Agent Profile 属于当前组织，插件/effect 在安全注册表中且与目标兼容。
- `supportedTargets`、仓库准备模式和限制范围。
- `promptFile`、目录穿越、非法 skill 路径、宿主机路径和任意代码入口。
- Error 阻止发布；Warning 在发布对话框展示但不阻止。

安全默认值：

- YAML 最大 1 MiB，Alias 上限 50。
- `cwd`、artifact、report 路径必须位于允许的容器工作目录，禁止 `..`。
- Skill 只能从服务端注册表选择，不接受文件路径。
- 客户端不再允许提交任意 `scanPipelineDefinitionSnapshot`；快照只能由服务端根据发布版本生成。

### 3.2 Pipeline API

新增组织级 `pipelineRouter`：

- 查询：`list`、`get`、`getVersion`、`listVersions`、`publishedOptions(targetType)`、`validate(yaml)`、`runtimeCatalog`。
- 变更：`create`、`saveDraft(expectedRevision)`、`publish(expectedRevision, yaml)`、`copyVersionToDraft`、`setCurrentVersion`、`duplicate`、`archive`、`unarchive`、`deleteDraftOnly`。
- 普通成员查询仅返回已发布内容；草稿、诊断和管理操作仅 Owner/Admin 可访问。
- 所有查询和变更必须显式按 `organizationId` 过滤。

统一新运行接口，移除新请求中的 `scanType`：

```ts
type CreatePipelineRunInput = {
	target:
		| { type: "application"; applicationId: string }
		| { type: "compose"; composeId: string }
		| { type: "datasetTrial"; trialId: string };
	pipelineId: string;
	pipelineVersionId?: string;
	repository: {
		targetRef?: string;
		targetTag?: string;
		commitSha?: string;
		baseSha?: string;
		commitWindow?: number;
	};
	stageOverrides?: Record<
		string,
		{ enabled?: boolean; concurrency?: number; agentProfileId?: string }
	>;
};
```

运行创建逻辑：

- 未传 `pipelineVersionId` 时，在事务中解析 `currentPublishedVersionId`。
- 显式历史版本必须属于同一 Pipeline、同一组织且已发布。
- 冻结 YAML、compiled definition、版本信息、解析后的 Agent Profile 配置和运行限制。
- 队列 payload 只传 `scanJobId`，Worker 从数据库读取不可变快照。
- Dataset Evaluation 创建时只解析一次版本，所有 Trials 使用同一快照。
- 已归档或没有已发布版本的 Pipeline 不能发起新运行。

### 3.3 去除 `scanType` 运行语义

- 用单一 `runPipelineJob` 替代新流程中的 Full/Delta/Research/Tob Goal 分支入口。
- root Stage、Stage 列表、Edge、运行参数和并发覆盖全部来自已冻结的 compiled definition。
- 仓库准备由 `runtime.prepareRepository` 决定：Full/Research/Goal 迁移为 `target`，Delta 迁移为 `diff`。
- root 输入固定为标准化的 `{ run, target, repository, limits }` 上下文，不允许 Pipeline 声明额外运行表单。
- 将当前按 `scanType` 或 Stage 名称判断的 Research 输入增强、身份校验、deadline prompt value、Goal native prompt 转成显式安全插件。
- Research/Goal 的容器不复用、taskId 容器命名等行为写回 YAML 属性或安全插件，不再由 `scanType` 隐式决定。
- 运行详情页固定显示 Overview、Graph、Tasks、Files、Sessions；附加页签由 compiled capabilities 决定。
- 新 V3 路径不得读取 `scanType`；该字段只允许出现在旧快照适配器和历史展示代码中。

环路安全：

- 在创建每一个下游 Task 前，使用数据库原子计数检查 `maxTasks`。
- `deadlineAt` 和任务计数持久化，Worker 重启或重试不能重置。
- Evaluation 的 `timeBudgetSeconds` 与 Pipeline 时限取较小值。
- 超限时停止继续分发、取消排队 Task、终止运行容器，将 Job 标记为 `failed`，并记录 `task_limit` 或 `duration_limit`。
- Pause、Resume、Cancel、Rerun 仍基于同一 Pipeline 快照，Resume 不重置计数和 deadline。

### 3.4 内置 Pipeline 和兼容迁移

- 将 Full、Delta、Research、Tob Goal 四套当前 definitions 转换为四份 V3 YAML，所有 prompt 文件内容内联。
- 为每个现有组织创建对应的 `systemKey` Pipeline 和 `v1`；新组织创建时自动初始化。
- Profile 默认回填到组织 Full Pipeline；自动 Delta 通过 `systemKey=delta` 查找 current version。
- 产品发布携带内置模板 hash。发现新 hash 时，为每个组织追加系统版本并自动切换 current，即使当前是用户自定义版本；旧系统版和自定义版全部保留，可手动切回。
- 迁移和更新过程幂等，并记录发布来源、模板 hash 和 current 切换审计。
- 旧 Job/Evaluation 不伪造版本关联，继续读取旧 `scanType + scanPipelineDefinitionSnapshot`；旧任务可查看、恢复和完成。
- 新功能稳定后移除文件系统 definitions 的运行时读取，仅保留 V2 转换器和历史适配测试。

## 4. 前端编辑器与 Profile 集成

### 4.1 页面结构

新增：

- `/dashboard/pipelines`：组织 Pipeline 列表、状态、current 版本、草稿状态和管理操作。
- `/dashboard/pipelines/new`：空白、复制或导入。
- `/dashboard/pipelines/[pipelineId]`：草稿编辑、版本查看和历史切换。

编辑页桌面布局：

- 左侧可折叠资源栏：Stage、Schema、Group。
- 中央 Visual/YAML 双模式编辑区。
- 右侧 360–440px Inspector；窄屏改为 Sheet。
- 顶部展示名称、Draft/Published、版本选择、保存、校验、发布。
- 底部统一诊断栏，点击问题定位 YAML 行或选中画板实体。

ReactFlow 和 CodeMirror 作为浏览器端重组件按需加载；编辑状态采用 `Provider + reducer + selectors`，避免每次输入导致整个画板重渲染。

### 4.2 编辑状态一致性

- `rawYamlBuffer` 是保存和脏状态的唯一依据。
- 同时保留 `lastValidDocument`、诊断和当前选中实体。
- YAML 输入在短暂 debounce 后解析；有效时更新画板模型，但不自动重排原始 YAML。
- YAML 无效时，画板显示最后一次有效内容并进入只读 stale 状态；不存在有效版本时显示空态。
- 只有 YAML 有效时才能切换到可编辑画板。
- 第一次画板操作执行稳定序列化；若原始 YAML 含注释或自定义排版，先明确提示可能被改写。
- YAML 模式使用 CodeMirror 原生撤销；Visual 模式维护图操作撤销栈，模式切换不伪造跨模式撤销。

### 4.3 Canvas 行为

不直接把现有 `scan-stage-graph` 改成编辑器，而是提取无业务状态的 Stage 外壳、端口样式和正交 Edge，再分别由运行监控图和编辑器适配。

画板能力：

- 工具栏、双击空白处新增 Stage；自动生成唯一 ID。
- Stage 四向连接点在 hover/选中时显示；拖拽连接创建 Edge。
- Stage、Edge、Schema、Group 均可选中并在右侧编辑。
- 设置 root、复制 Stage、重命名、删除；重命名原子更新 root、Edge、Group 和布局引用。
- 删除 Stage 前展示受影响 Edge；确认后同步删除。
- Edge 具有稳定 ID，名称可独立修改；支持删除、路由、fanOut、foreach、artifact 和折点编辑。
- 允许创建循环边；发布校验只要求从 root 可达。
- Schema 重命名自动更新全部 `$ref`；被引用 Schema 禁止直接删除并展示引用位置。
- Group 支持创建、改名、leader/members 编辑；画板显示与当前 Stage Graph 一致的分组框。
- 缺少 `ui` 布局时执行确定性自动布局；拖动节点或折点后写入 YAML。
- 提供缩放、适配视图、自动布局和键盘删除；危险操作需要确认。

视觉方向沿用当前 Stage Graph 的节点层级、端口、正交边和语义色彩，调整为编辑状态；只借鉴 open-kritt 的右侧 Inspector、脏状态保护和问题计数，不引入其代码或视觉依赖。

### 4.4 Inspector 和 Schema 编辑器

Stage Inspector 覆盖 V3 的全部属性，包括：

- 基础信息、role、group、mode、并发、是否可禁用。
- Agent Profile、持久化、容器复用、cwd、skills、仓库准备模式、Policy。
- 内联 Prompt 编辑器和变量自动补全。
- input/output Schema 引用或内联配置。
- artifacts、effects、plugins、report、task name、container name parts、prompt values。

Edge Inspector 覆盖端点、map/fanOut、foreach、input 映射、artifact、route 和 output Schema。

Schema Inspector：

- 可视化支持 object、array、string、number、integer、boolean、null、properties、items、required、description、`$ref`。
- 高级模式直接编辑完整 JSON Schema/YAML。
- 可视化修改只更新已识别字段，保留未知高级关键字；无法可视化的根 Schema 自动切为只读摘要并引导到高级模式。
- 引用选择器列出当前 Pipeline 内的 Schema，并显示引用计数。

### 4.5 Project/Evaluation Profile

- Application 和 Compose 详情页把四种硬编码 Run Dialog 收敛为一个 “Run Pipeline” 入口。
- Profile 设置增加默认 Pipeline 选择器，只保存 `pipelineId`。
- Run Dialog 默认选中 Profile Pipeline 的 current version；高级区域可临时选择历史版本。
- Pipeline 选项按 `supportedTargets` 过滤，显示系统/自定义、版本、归档和兼容状态。
- Dataset Profile 采用同一选择器；Evaluation 创建后展示冻结的 Pipeline 名称与 `vN`。
- Job/Evaluation 详情展示 Pipeline 链接、确切版本和 content hash。
- Pipeline current 发生切换后，新 Run 自动使用新版；已创建的 Job/Evaluation 永不变化。

## 5. 实施顺序、测试与验收

### 5.1 实施顺序

0. **提交现有改动并新建分支**：先审查当前全部已跟踪和未跟踪改动，执行与现有改动相匹配的测试，使用 Conventional Commit 提交当前版本，确认工作树干净；随后从该提交创建并切换到 `feat/organization-yaml-pipeline-editor`。Pipeline 功能实现不得直接混入该基线提交。
1. **统一契约**：完成 V3 类型、稳定序列化、诊断、V2 转换器和内置 YAML 生成，消除两套 runtime schema 漂移。
2. **数据与 API**：加入 Pipeline/Version 表、Profile 和 Job/Evaluation 字段、乐观锁、权限和版本 API。
3. **通用运行器**：完成 snapshot 驱动的 runner、声明式仓库准备、安全插件、持久化限制和能力派生；保留旧 Job 适配器。
4. **内置迁移**：按组织 seed 四套 Pipeline、回填默认值、接入系统模板自动升级和自动 Delta。
5. **编辑器**：先抽取中性图形组件，再实现画板、Inspector、Schema Builder、YAML 双模式和诊断定位。
6. **业务入口**：替换 Application、Compose、Dataset Profile 的硬编码 `scanType` 选择和结果页签。
7. **灰度与清理**：先通过组织级功能开关启用；观察 V2/V3 运行量、发布失败、限额终止和队列错误，再关闭旧写入路径。

功能分支内每一阶段独立提交，并通过相关单测、类型检查和迁移回滚检查后再进入下一阶段。

### 5.2 测试矩阵

- 编译器：V3 解析、稳定序列化、表达式、route、Schema refs、递归 Schema、环路、不可达节点、非法插件和内联 prompt。
- 草稿：语法错误和语义错误可保存；大小/alias 攻击被拒；纯文本保存逐字不变。
- 版本：并发 revision 冲突、发布事务、递增版本、相同 hash 幂等、历史复制、current 切换、不可变约束。
- 权限：跨组织 ID、Agent Profile 引用和版本访问全部拒绝；成员不能读取草稿或调用管理 mutation。
- 系统迁移：四套模板逐组织 seed；重复迁移无重复数据；自定义 current 遇到系统更新后自动切新版且旧版仍可切回。
- 通用运行：project/evaluation、target/diff 仓库准备、动态 Stage 覆盖、root 输入、插件行为、结果 capability。
- 环路：正常结束、任务数超限、时长超限、Worker 重启后继续计数、Pause/Resume 不重置限制。
- 快照：current 切换或 Agent Profile 修改后，已创建 Job/Evaluation 仍使用原始快照。
- 兼容：旧 Full/Delta/Research/Tob Goal Job 可查看、恢复和完成；新 Job 不依赖 `scanType`。
- 编辑器：创建/连接/删除/重命名、root、Schema 引用、Group、折点、无效 YAML stale canvas、注释警告、冲突处理。
- Profile：默认值、单次覆盖、历史版本、目标兼容过滤、归档替代流程、Evaluation 多 Trial 固定版本。
- 质量门槛：相关 Vitest、`pnpm typecheck`、Biome 检查、数据库迁移测试和浏览器端拖拽/键盘/响应式回归。

### 5.3 最终验收标准

- 管理员能仅通过画板创建 Stage、Edge、Schema 和循环拓扑，并在右侧完成全部属性配置。
- YAML 与画板双向同步；无效 YAML 可保存草稿但不会被画板旧状态覆盖。
- 新 Pipeline 可不先保存草稿而直接发布 `v1`，发布后只读；再次编辑产生 `v2`。
- 普通成员能从 Project/Evaluation Profile 选择当前或历史发布版本运行，但看不到草稿和管理按钮。
- 每次 Run 和 Evaluation 都记录确切版本、原始 YAML 和编译快照。
- 内置 Pipeline 已组织化、Prompt 已内联、系统升级会追加版本并自动切 current。
- 新运行链路不存在 Full/Delta/Research/Tob Goal 的 `scanType` 分支，差异完全来自 YAML 和安全插件。
- 环路不会无限生成任务，超限在重启场景下仍能可靠终止。
- 跨组织访问、路径注入、YAML 膨胀和客户端伪造快照均被阻止。
