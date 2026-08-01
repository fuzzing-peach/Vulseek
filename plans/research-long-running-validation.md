# 长期 Research Scan 运行与验证计划

## Summary

在 dev 环境通过 agent-browser 启动一个 WordPress 7.0.1 Research Scan，使用现有 Profile `wordpress-gpt5x-dev-20260719`。不设置硬超时，持续运行并周期性检查；直到用户要求停止，或出现数据一致性、资源失控等硬故障时才取消。

测试只读检查 dev 数据、日志、API、文件和 UI，不连接或修改 release，不自动修改代码。发现问题时先保留证据并汇报根因。

## 启动与基线

- 启动前确认 `vulseek-dev`、PostgreSQL、Redis、Docker network、checkout image 和 tools image 健康，且没有其他 running Research Job。
- 通过 agent-browser 从 WordPress Profile 页面创建 `scanType=research` Job，记录 Job ID、创建时间、pipeline snapshot hash、runtime settings 和 agent profiles。
- 确认 Job 使用当前 12-stage Research pipeline，Research task 获得 `VULSEEK_RESEARCH_DATABASE_URL`，不使用旧 Broker/event 写入路径。
- 保存初始 DB、UI、队列、容器和 artifact 目录基线。

## 持续观测

- 每 60 秒检查 Job/task 状态、各 stage pending/running/completed/failed 数量、最老 pending dispatch、运行容器和 runtime registry。
- 每 5 分钟生成一次等价于 `ResearchProgressSnapshot` 的只读快照：
  - pipeline frontier 和 snapshot hash；
  - Track、Finding、Primitive、Chain 数量、状态和 revision；
  - token、estimated cost、task 数、artifact 总量和 agent-home p95；
  - dispatch pending 数量及年龄。
- 每 15 分钟使用 agent-browser 验证 Overview、Tasks、Findings、Tracks、Primitives、Chains、Monitoring、Files：
  - URL、标签选中状态和刷新恢复；
  - running/finished task 数量、名称、动画和 activity；
  - Registry 搜索、过滤、排序、分页及长文本布局；
  - Monitoring 与 DB/token/task 状态一致；
  - Files 和 Session 可读取且运行中持续追加；
  - console、失败请求、重复 SSE 和 React 错误。
- 每到达新 stage，抽查 task 的 input、output schema、output、stdout、activity、agent-home 和原生 session JSONL。
- 对 Track Review、Finding Review、Chain Review、Exploit Review 验证 route 与 `downstreamRouteKey` 一致、dispatch 已完成、review artifact 与父 output 一致，并确认下游实体 ID 和关系字段属于当前 Job。
- 对 agent-owned DB 写入验证 revision 只在成功 mutation 时递增；CAS conflict 最多重试三轮；`alreadyApplied`、`alreadyExists` 不增加 revision；Finding、Primitive、Chain 的父级引用存在且不跨 Job。

## 异常判定与清理

以下情况立即保留 UI、网络、日志、DB、artifact 和容器证据，并自动取消 Job：

- pipeline snapshot 在运行中漂移；
- Registry 出现跨 Job 引用、非法关系或 revision 回退；
- completed task 缺少必要 output/artifact，或 dispatch pending 超过 30 秒且无法恢复；
- 同类基础设施错误连续出现三次；
- 最近 500k token 没有 Registry/frontier 业务进度；
- artifact 平均超过 15 MiB/task，或 agent-home p95 超过 25 MiB；
- 发现 credential 泄露、数据库破坏风险或容器失控。

单个 LLM/ACP task 失败先记录并观察 pipeline 恢复；只有失败模式连续重复或阻断业务推进时才取消。连续 Docker `runc` 错误时先记录主机和 Docker 状态，再按既有授权清理 page cache，并只重试失败的 dev 操作。

用户要求停止或命中硬停止条件后，从 UI 取消 Job，并确认：

- Job 为 `canceled`；
- 无 pending/starting/running task；
- 20 秒内 task 和 Registry 数量不再增长；
- BullMQ 无 active/waiting/delayed 项；
- runtime registry 已删除；
- 无匹配容器、agent 进程或临时 credential 文件；
- Files 和 Session 仍可读取历史证据。

## Acceptance

- Research 至少稳定经过 Scope、Surface Map、Track Plan、Discovery 和 Track Review，并持续观察自然到达的 Finding、Primitive、Chain、Exploit 或 Report。
- UI、API、DB、artifact、session 和容器状态保持一致。
- Registry revision/CAS 和实体关系正确，无旧 Broker/event 路径参与。
- 运行期间每 15 分钟提供一次进度、资源和异常摘要。
- 停止后没有任务复活、队列残留或容器残留。
