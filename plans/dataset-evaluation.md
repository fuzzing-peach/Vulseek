# Dataset Evaluation 功能实施计划

## Summary

新增与 Project 并列的组织级 `Dataset`，并在 Dataset 下引入与现有 Project Profile 对应的 `Dataset Profile`。Dataset Profile 表示一次准备完成、可复现、可运行的数据集工作区。Evaluation 按 sample、repetition 严格串行运行真实 `scan_job`，汇总时间、token、cost 和内置结构化结果。

每个成功结束的 Dataset Trial 都会在独立 agent 容器中比较 `groundTruthArtifacts` 与该 Scan Job 的 `outputs`，并保存逐 Job output 的 hit/miss、匹配依据和未命中的 ground truth。旧 Application Job `Evaluate` UI、API 和 worker 被移除；历史表暂时保留，不执行破坏性迁移。CyberGym 作为首个参考 adapter；其任务生成独立 workspace 的模式与 Dataset manifest 契约匹配。[CyberGym 官方仓库](https://github.com/sunblaze-ucb/cybergym)

## Data And Contracts

新增五类表：

- `datasets`：组织、名称和 Git/local source。
- `dataset_profiles`：local host root、轻量 checkout image digest 和配置 snapshot；source digest 保留为空。
- `dataset_samples`：profile 下的 id、顺序、repositoryPath、groundTruthArtifacts 和 metadata。
- `dataset_evaluations`：引用 profile，保存 pipeline、预算、repetitions、stage settings snapshot 和汇总状态。
- `dataset_evaluation_trials`：sample x repetition、scan 状态、用时、token、cost、结果和错误。

固定 manifest 路径：

```text
/workspace/dataset/.vulseek/manifest.json
```

实际文件位于 Dataset 配置的 local path；Evaluation 运行时只挂载当前 sample 子目录。

Manifest V1 包含：

```json
{
  "version": 1,
  "samples": [
    {
      "id": "unique-key",
      "title": "Sample title",
      "repositoryPath": "samples/example/repo",
      "groundTruthArtifacts": [
        "samples/example/description.txt",
        "samples/example/patch.diff"
      ],
      "metadata": {}
    }
  ]
}
```

`repositoryPath` 必须是存在的相对目录且不能逃逸 Dataset 根目录。`groundTruthArtifacts` 中的每一项也是相对 Dataset 根目录的路径，必须指向根目录内已存在的文件，但不限制扩展名或内容格式；省略时按空数组处理。`metadata` 仅供评估器使用，不暴露给 scan agent。

## Checkout And Execution

- Dataset source 仅支持 host 上的绝对 local path；不支持 Git URL、ref、SSH key 或 submodule。
- Checkout 直接使用 local path 作为 Dataset Profile 的 host root，不复制数据，不计算 source digest；仅验证目录中的 manifest，并构建不包含数据的轻量 checkout image。
- 成功后从 host root 验证 manifest，事务化写入 profile samples，并记录 host root 和 checkout image digest。
- Profile prune 只允许删除未被 Evaluation 引用的 profile，只清理 Vulseek 构建的轻量 image，不删除用户的 local source 目录。
- Agent credentials 使用临时挂载，不得提交到 preparation image。
- 每个 trial 只把当前 sample 的 host 目录 bind mount 到容器，不挂载 Dataset Profile 根目录、其他 samples、manifest 或 evaluator metadata。
- 每个 scan task 基于轻量 checkout image 启动，将当前 sample host 目录只读挂载到 `/workspace/repo`；不允许 task 修改源数据，persistent lane 只复用会话和容器，不共享其他 sample。
- `scan_jobs` 新增唯一、可空的 `datasetEvaluationTrialId`，并约束 application、compose、dataset trial 三种 target 必须且只能存在一个。
- 抽象 `ScanTargetContext`，让现有 pipeline runtime、权限、artifacts、Files、Session、成本统计支持 Dataset trial。
- Evaluation 选择现有 `full`、`research`、`tob-goal` 等非 Delta pipeline，不新增 `evaluation` scanType。
- 创建 Evaluation 时配置并快照完整 stage settings、sample 子集、repetitions 和每个 trial 的 active scan time budget。
- Trial 顺序采用 round-robin：所有 sample 的 repetition 1 完成后再运行 repetition 2。

新增持久化 BullMQ coordinator：

- 事务 claim 下一个 trial，数据库约束确保每个 Evaluation 最多一个 active trial。
- scan job 终态或 timeout 时唤醒 coordinator。
- timeout 取消 scan job；预算不包含准备和暂停时间。
- 单个 scan 失败记录后继续；最终状态为 `completed_with_errors`。
- 成功或部分成功的 scan 在 Trial 终态前启动一次非持久、不可复用的评分容器；评分 agent profile 从 Job output producer task 的快照解析，缺失时回退到该 Job 的其他 agent task。
- 评分输入复制到 Job 下的隔离 evaluation 目录，agent 只能读取当前 sample、ground-truth 副本和 Job output 副本；强制为每个 Job output 返回且只返回一条结果。
- 评分失败记录为 `scoring_failed`，不混同于 `scan_failed`；评分结果写入 `dataset_evaluation_trials.result.scoring`。
- 所有 trials 结束后生成内置汇总；汇总失败则 Evaluation 为 `failed`。
- Pause 立即暂停当前 scan。
- Cancel 立即停止 scan 并清理运行中的容器，不删除可复用的 Dataset Profile host 数据。
- Pause/Resume 通过现有 scan job 控制接口暂停当前 trial；coordinator 在 paused 状态不推进下一个 sample，恢复后继续当前 trial。
- 服务重启时从数据库恢复 coordinator、timeout 和当前 trial，不重复创建 scan job。

## API And UI

新增 `/dashboard/datasets` 入口，组织成员可查看，owner/admin 可创建、修改、checkout、运行和删除。

### Projects 创建入口

Projects 页面顶部现有的 `Create Project` 按钮必须改为共享的 `Create` 下拉菜单，作为 Dataset 创建的唯一新增入口：

- 菜单项 `Create Project` 继续打开现有 Project 创建对话框，不改变原有的 `canCreateProjects` 和组织权限判断。
- 菜单项 `Create Dataset` 跳转到 `/dashboard/datasets/new`，只对当前组织的 owner/admin 显示；普通成员只能看到 Project 入口（如果其原有 Project 创建权限允许）。
- 下拉菜单必须复用现有的 Project 创建表单和权限逻辑，不复制一份 Project 创建流程；关闭菜单或打开对话框不能改变页面纵向布局。
- Dataset 创建页提交成功后进入 `/dashboard/datasets/:datasetId`，取消或返回不创建空 Dataset。
- 直接访问 Dataset 创建路由时仍执行服务端组织和角色校验，不能仅依赖菜单隐藏。

验收要求：Project 和 Dataset 两个菜单项在同一入口下可区分，Project 创建行为保持回归兼容，Dataset 创建不会绕过组织权限，也不会改变现有 Project 页面布局。

Dataset 页面包含：

- Overview：source、当前 profile、sample/evaluation 数量。
- Configuration：source。
- Profiles：checkout 状态、host root 摘要、日志、checkout image digest、Prune。
- Samples：搜索、分页、metadata 详情。
- Evaluations：运行历史和创建入口。

Evaluation 创建页提供 sample 子集、repetitions、pipeline、time budget 和 Stage Agent Settings。详情页展示总体进度、trial 列表、状态、时长、token、cost 和逐 Job output 的 ground-truth 比对详情，并链接复用现有 Job/Task/Files/Session 页面。首版不增加 JSONL/CSV 导出。

被 Evaluation 引用的 profile 不可删除；Prune 只删除未引用 profile、镜像和 artifacts。

## Test Plan

- Schema/API：组织隔离、target XOR、profile 不可变、sample 唯一性、路径逃逸和 JSON Schema 校验。
- Checkout：Git/local、非法 manifest、credential 不进入镜像、失败恢复。
- Isolation：scan agent 只能看到当前 sample；挂载只读且不同 trial/task 不共享可写数据；persistent lane 行为不回归。
- Coordinator：严格串行、round-robin、重复次数、timeout、continue-on-error、幂等唤醒和重启恢复。
- Scoring：任意文件类型、路径隔离、每个 output 恰好一条结果、未知 artifact 拒绝、半写 output、agent 失败和评分超时。
- Lifecycle：Pause/Resume 排除暂停时间；Cancel 后无 task container、挂载清理和 BullMQ 残留。
- Regression：Project Application/Compose scans 保持兼容；旧 Ground Truth Scoring 不再注册 API、队列或 worker。
- UI：使用 agent-browser 验证 Dataset CRUD、checkout、sample 列表、Evaluation 创建/控制、trial Job 链接、结果和错误状态。
- UI：验证 Projects 页 `Create` 下拉菜单、Project 创建对话框、Dataset 创建导航和不同权限用户的菜单可见性；覆盖提交、取消、刷新、键盘/点击关闭和直接访问 `/dashboard/datasets/new`。
- CyberGym：实现时浅克隆到 `third_party/cybergym` 供本地参考，不作为生产依赖；提交轻量 adapter 示例和 synthetic fixture，不下载约 240 GB 的完整数据。可在本地已有 CyberGym subset 时额外执行单 sample smoke test。

## Assumptions

- Dataset Profile 配置随 Profile 固定，创建 Evaluation 时不可覆盖。
- Scan 失败或超时只记录 trial 状态并继续后续 sample；显式 Cancel 时停止当前 trial。
- Evaluation 生成内置状态、时长、token 和 cost 摘要。
- Dataset Profile host root 不直接暴露给 scan agent；scan agent 只能看到当前 sample 的只读挂载，轻量 checkout image 不包含数据。
- 首版采用单实例 coordinator，与当前 Vulseek 部署模型一致。
