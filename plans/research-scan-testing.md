# Research Scan Testing Plan

## Summary

建立一套“确定性自动测试 + dev 环境真实运行中扫描”的 Research Scan 测试体系，验证 Pipeline、产物文件、API、数据库和前端展示之间的一致性。

真实扫描只使用 Active 和 Empty Research Job，不等待 Job 运行结束。完整路由、终态、失败和 settlement 行为通过固定 stage output 的自动化测试验证。所有测试仅在 dev 环境执行，不连接或修改 release。

## Test Fixtures

- Active Research Job：真实启动的 dev Research Scan，至少有一个 task 进入 running。
- Empty Research Job：刚创建且 Registry 尚无数据，用于验证等待和空状态。
- Deterministic Pipeline Fixture：使用固定 stage output 驱动全部 12 个 Research stage，不调用真实 LLM。
- 测试结束后取消 Active Job，并确认队列停止分发、运行容器被清理。

## Pipeline And Artifact Tests

- 验证真实 task 按 `pending -> launching -> running` 流转，stage 容器、`agent-home` 和原生 session JSONL 正常建立。
- 对已完成的 stage 检查 `input.json`、`output.schema.json`、`output.json`、activity 和 stdout/stderr。
- 校验 `scopePath`、`surfaceMapPath`、`discoveryReportPath`、`reviewPath`、`validationPath` 指向当前 task 内存在且 schema-valid 的文件。
- 校验下游 `inputs/*.json` 与上游产物内容一致，不允许跨 Job 路径。
- 若真实扫描进入 Track Planning 或后续 stage，检查 fanOut 数量、route 选择和 Registry 增量写入。
- 使用 deterministic fixture 覆盖 12-stage graph、局部循环、失败、取消、重试、幂等 dispatch 和 settlement，不等待真实 Job 完成。
- 取消 Active Job 后不得继续创建下游 task，并应停止该 Job 的运行容器。

## Database And API Tests

- 校验 `scan_jobs` 保存 `scanType=research`、pipeline snapshot、runtime settings，并与 API/UI 状态一致。
- 校验 `tasks` 的数量、stage、状态、threadId、时间、token、input 和 output 与文件系统一致。
- 校验 `research_tracks`、`exploit_primitives`、`exploit_chains` 及对应 event 表随 stage effect 增量写入。
- 校验 revision 单调递增、idempotency key 去重、task retry 不产生重复 Registry 记录。
- 覆盖 `scan.researchTracks`、`scan.exploitPrimitives`、`scan.exploitChains` 的空数据、增量数据、搜索、status filter、分页、越界页和 organization 隔离。
- 覆盖 Research Broker 的 401、非法 operation、task/job 不匹配 403、正常查询和 100 条返回上限。
- 验证 pause、resume、cancel 后 API、DB、队列和容器状态一致。

## Frontend Tests

使用 Vitest 验证组件与路由逻辑，并使用 agent-browser 在 dev 上执行真实 UI 冒烟：

- Research Job 显示 `Tracks`、`Primitives`、`Chains`，Full/Delta Scan 不显示。
- 标签切换后 URL、选中状态和面板同步，刷新后保持当前标签。
- Running Tasks 展示 Research stage、运行状态动画和取消按钮，数量与 API 一致。
- Tasks、Monitoring、Files、Session 在运行期间正常增量刷新。
- Registry 标签覆盖 loading、empty、error、数据表、搜索、status filter、分页和详情 Sheet。
- Files 能导航并打开已生成的输入、输出、日志和报告文件。
- Session 能增量展示原生 JSONL，离开底部后不强制自动滚动。
- 检查浏览器控制台错误、失败请求、重复请求、加载状态和布局溢出。

失败时按 `UI state -> network response -> dev logs -> DB rows -> artifact files -> mapper/router` 顺序诊断。

## Automation And Acceptance

已落地的自动化测试单元：

- `apps/vulseek/__test__/scan/research-pipeline-contract.test.ts`
- `apps/vulseek/__test__/scan/research-pipeline-artifacts.test.ts`
- `apps/vulseek/__test__/scan/research-registry-list.test.ts`
- `apps/vulseek/__test__/scan/research-registry-db.integration.test.ts` (dev DB opt-in)
- `apps/vulseek/__test__/scan/research-registry-api.test.ts`
- `apps/vulseek/__test__/scan/research-broker-contract.test.ts`
- `apps/vulseek/__test__/scan/research-registry-ui-contract.test.ts`
- `apps/vulseek/__test__/scan/research-registry-tabs.test.ts`
- `apps/vulseek/__test__/scan/job-tabs-routing.test.ts`

已有的 server pipeline routing、retry 和 running-task 测试继续作为确定性生命周期覆盖；dev smoke 负责补充真实任务、数据库、文件和接口之间的联调证据。

执行：

```bash
pnpm --filter vulseek test
pnpm --filter @vulseek/server typecheck
pnpm --filter vulseek typecheck
git diff --check
```

真实扫描满足以下条件后即可取消，无需等待终态：

1. 至少一个 Research task 进入 running。
2. `agent-home` 和 session JSONL 已生成。
3. 至少一个 stage 成功生成结构化产物，或已记录可定位的失败原因。
4. UI、API、DB 和文件系统中的 task 状态一致。
5. 取消后不再分发下游 task，相关运行容器已清理。
