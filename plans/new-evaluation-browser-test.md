# New Evaluation Browser 端到端测试计划

## Summary

仅测试成功路径，使用 dev 环境：

- 地址：`http://211.65.197.92:23000`
- Dataset：`Cybergym` / `WrVu0iFcvCYOmHOzYOCHp`
- Dataset Profile：`profile-1786249409325-9wi74s`
- Sample：`arvo-10013`
- Pipeline：Goal v5 / `a779EkxgtdE9mif4c4sd1`
- Pipeline Profile：`abc` / `gkY5wTaqsgGFkTPkLwVrO`
- Repetitions：`1`
- Time budget：`3600` 秒

所有创建和页面操作均通过 agent-browser 完成；数据库只做只读核验。测试 Evaluation 保留用于后续审计，不操作 release。

## Test Flow

| 阶段 | Browser / UI 验证 | DB、API 与产物验证 |
| --- | --- | --- |
| 前置检查 | Profile 页面正常加载，无控制台错误；Run Evaluation 可用 | Profile 为 `ready`；sample 有三个 Ground Truth 文件；Goal v5 支持 `evaluation`；`goal-dedup.jobOutput=true`；`abc` 指向 v5；Agent Profile 启用 |
| 参数配置 | 名称使用 `e2e-new-evaluation-<timestamp>`；选择 Goal v5 和 `abc`；仅勾选 `arvo-10013`；设置 repetitions=1、budget=3600 | Profile 原有 `selectedSampleIds` 不持久修改；浏览器提交 payload 只包含 `arvo-10013` |
| 创建事务 | 点击 Run Evaluation 后出现成功提示并进入 Evaluations 列表 | `dataset_evaluations` 新增一行；冻结 pipeline/profile/version/YAML/compiled/settings；`dataset_evaluation_trials` 只新增一行，ordinal=0、repetition=1 |
| Coordinator 启动 | Evaluation 详情显示 Pending 后转 Running；Trials 显示 Preparing/Running | Trial 依次为 `pending -> preparing -> running`；只创建一个 `scan_jobs`，其 `datasetEvaluationTrialId` 与 Trial 对应 |
| Scan Job | Trial 行出现可点击 Scan Job；Job 页面 Overview、Tasks、Files、Session 可打开 | Job 使用 Goal v5 和 `abc` settings；Root task 为 `goal-craft`；task 状态和 UI 一致；BullMQ 无重复 Job |
| Agent 运行 | Running/Finished Tasks 持续刷新；Session 有真实会话；无只读仓库 skill 错误 | Skills 位于 Job 的 `agent-home/skills`；`/workspace/repo/.agents` 不存在；task input/output、route、token 和状态一致 |
| Job Output | `goal-dedup` 成功后可从 Files 查看相关产物 | Dedup novel 输出包含 `/task/outputs/judge.json`；后端复制到 `/task/job-output/outputs/judge.json`；`scan_jobs.outputs` 保存对应 task、stage 和 artifact |
| 评分启动 | Scan Job 已 Finished/Partially Finished，但 Trial 在评分结束前仍显示 Running | 日志出现 `trial.scoring_started`；存在临时 scoring container；生成 `comparison-manifest.json`，内容同时包含三个 Ground Truth 和 Job Output 副本 |
| 评分完成 | Trial 转为 Completed；Ground Truth 列出现 `x/y outputs hit` 按钮 | Trial 写入 `result.scoring`，包含 groundTruthArtifacts、jobOutputs、matched/unmatched、summary 和 evaluator；评分容器被删除 |
| Evaluation 完成 | Header 显示 Completed；Overview 展示 Trials、Tokens、Duration、Cost | Evaluation 为 `completed`；startedAt/finishedAt 有值；聚合 token、duration、cost 与 Trial/Scan Job 一致 |
| 结果详情 | 打开 Ground-truth comparison；逐项显示 Hit/Miss、理由、输出文件和匹配 Ground Truth | UI 内容与 `result.scoring` 完全一致；Job Output 数量、hit 数量和 unmatched 列表一致 |
| 列表功能 | Trials 搜索 `arvo-10013` 命中；错误关键字为空；Completed 筛选命中；刷新后状态不丢失 | `trialsList` 的 total/items 与数据库一致；`evaluations.one` 返回冻结版本和正确 totals |
| 最终清理 | 页面无错误弹窗、console error 或持续加载 | 无 scoring/task 临时容器；BullMQ 无 active/waiting 残留；Evaluation 和 Job 保留为审计记录 |

## Monitoring And Diagnosis

- 每 30 秒记录 Evaluation、Trial、Scan Job 和当前 Stage；每个状态变化立即保存 UI 截图及 DB 快照。
- 开启浏览器网络记录，检查 `evaluations.create`、`evaluations.one`、`trialsList` 和 Job APIs 均返回成功。
- 评分期间重点检查 worker 日志、scoring container、comparison manifest 和 output 文件；当前没有独立 `scoring` 状态属于预期。
- 出现问题时按以下顺序定位：UI 截图 -> 浏览器 console/network -> Evaluation/Trial DB -> Scan Job/Task DB -> dev worker 日志 -> Job artifacts -> Docker container。
- 若 15 分钟没有 task 或状态进展，先诊断但不立即取消；达到 3600 秒预算后应自动取消 Scan Job，并将 Trial 标记为 `timed_out`，此时本轮测试判定失败。

## Acceptance Criteria

- Evaluation 创建后只产生一个 Trial 和一个 Scan Job，不重复调度。
- Goal v5、`abc` settings 和单 sample 参数被完整冻结。
- Job 成功产生至少一个文件型 Job Output。
- Ground Truth 评分容器成功运行并清理。
- Trial 为 `completed`，Evaluation 为 `completed`。
- UI 的状态、token、cost、artifact 和 Hit/Miss 结果与 DB 完全一致。
- 全流程没有 `/workspace/repo/.agents` 写入、只读挂载错误、评分缺少 Job Output、API 失败或残留容器。
