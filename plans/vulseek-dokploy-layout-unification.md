# Vulseek Dokploy 风格布局统一计划

## Summary

以 `third_party/dokploy-upstream` 和线上 Dokploy 为视觉基准，仅重构布局、样式和共享 UI 组合，不修改查询、权限、路由、数据库或业务行为。覆盖 Projects、Datasets 及完整下属链路：Environment、Profile、Evaluation、Job、Task、Candidate/Registry。

目标节奏：

- 页面外框：`bg-sidebar p-2.5 rounded-xl`
- Header：动态高度，移动端 16px、桌面 24px 内边距
- Body：上下 32px，移动端水平 16px、桌面 24px
- 同级区块 16px、网格 20px、紧密元素 6–8px
- Tabs 高 40px，桌面标签间 32px、移动端 16px，首个内容距标签约 26px
- Card 内边距 24px；列表一项一行，行内边距和行间距均 16px

## Implementation Changes

### 1. 共享样式与页面壳

- 对齐 Dokploy 的 `Card`、`Tabs`、`Button` 视觉实现；保留 React 18 `forwardRef` API，不迁移 React 19、Tailwind 4 或 UI 框架。
- `Card` 恢复 Dokploy 的 `rounded-xl + ring-1` surface，增加 `size="default|sm"` 和 `CardAction`；列表行继续显式使用 border。
- `Tabs` 根节点采用纵向 `gap-2`，列表为 `h-10 p-1`；Trigger 使用水平 12px、垂直 6px；按钮默认高 40px、内部 `gap-1.5`，按压反馈改为 Dokploy 的轻微纵向位移。
- 重构 `DashboardPageHeader`：删除固定 92px 高度、图标方框、隐藏描述占位和 action 裁切；采用 `p-4 sm:p-6`、`gap-4`、自然换行，图标以内联 24px muted icon 呈现。
- `DashboardPageBody` 统一 `border-t px-4 py-8 sm:px-6`。新增 `DashboardPageTabContent`，通过 16px 外间距加 10px 内容顶部留白形成约 26px 的 Dokploy 标签内容节奏。
- `DashboardPanelShell` 继续作为兼容代理，但目标链路全部迁移到 `DashboardPage`；完成后目标页面不得直接使用旧壳。
- 所有覆盖类继续通过现有 `cn()/tailwind-merge` 合并；不新增独立 CSS spacing 系统，也不从 `third_party` 运行时导入代码。

### 2. 列表、卡片和 Section

- 调整 `CollectionView` 的内部结构：toolbar 控件间 16px，toolbar block 到结果区 24px，结果到 pagination 16px；移除当前统一的 `space-y-3`。
- 卡片网格统一 `repeat(auto-fill,minmax(300px,1fr)) gap-5`；`RowList` 使用 `gap-4`，`RowListItem` 使用 `rounded-lg p-4 gap-4`。
- 新增共享 `ResourceCard`，用于 Projects、Datasets 和 Profile 卡片：Header 24px、标题/描述 6px、Footer 顶部 16px并用 `mt-auto` 底部对齐；保留一个主 Link 和独立 actions menu，禁止嵌套交互元素。
- 新增轻量 `CollectionSection`，统一 section 标题、描述和列表内容；删除各页面重复的 `border-0 shadow-none Card`、手写 `px-0 pt-0` 组合。
- Projects 和 Datasets 使用同一 ResourceCard 网格；Profile 保持服务式卡片网格；Evaluations、Jobs、Samples、Tasks 使用一项一行的 RowList；Trials/Registry 的高密度数据可继续使用 table。
- 创建、编辑和删除 Dialog 仅调整到 Dokploy 的 24px 内容留白、16px 内容栈和 8px footer 按钮间距，保留现有 Radix modal/focus 行为。

### 3. 页面迁移顺序

1. **Projects / Datasets 列表**
   - 统一 Header、toolbar、自动填充卡片网格、空状态和 pagination。
   - Projects/Datasets 卡片使用相同标题、描述、metadata、footer 和 actions 位置。

2. **Project Environment / Dataset Detail**
   - Profile 卡片统一为 Dokploy 服务卡片布局。
   - Dataset Evaluations 改为标准 RowList；移除列表外不必要的厚重 Card 嵌套。
   - 搜索、过滤、批量操作和分页保持现有 URL/query 行为。

3. **Profile / Evaluation**
   - Application、Compose、数据库 Profile 和 Dataset Profile 使用相同动态 Header、Tabs 和 TabContent。
   - Overview/Form 内容使用 `flex flex-col gap-4` 的 24px Card；指标网格保持响应式，但卡片 padding 改为 24px。
   - Evaluations、Jobs、Samples、Trials 的列表标题和结果区统一 CollectionSection。

4. **Job / Task / Candidate/Registry**
   - 将 `ShowScanJobDetail`、`ShowScanTaskDetail`、`ShowScanCandidateDetail` 从 `DashboardPanelShell + CardHeader/CardContent` 迁移到 `DashboardPageHeader + DashboardPageTabs + DashboardPageTabContent`。
   - 标签栏统一桌面 32px、移动端 16px并横向滚动；移除各 TabContent 手写的重复 `pt-4`。
   - Job、Task、Candidate 内部详情 section 和结果列表使用统一 16px 栈；保留现有 Provider、轮询、URL tab、文件树及操作逻辑。
   - Project 与 Dataset 入口继续共享同一详情组件，只由现有 navigation adapter 提供 breadcrumb。

## Public Interfaces

- `Card` 增加 `size?: "default" | "sm"` 和 `CardAction` 导出。
- UI system 增加 `DashboardPageTabContent`、`ResourceCard`、`CollectionSection`。
- `DashboardPageHeader`、`CollectionView` 现有业务 props 和 query contract 保持兼容；仅调整 DOM 和样式。
- 不新增或修改 tRPC API、数据库 schema、route builder、URL 参数或权限接口。

## Test Plan

- 更新 React 测试，断言 Dashboard Header 不再固定高度、Body 使用 32px 纵向留白、Tabs/TabContent 间距、ResourceCard 结构、RowList 的 16px 规则及移动端横向 Tabs。
- 保留并运行 CollectionView、RowList、Dialog、URL Tabs、route builder 和扫描页面现有测试。
- 执行：
  - `pnpm --filter vulseek test`
  - `pnpm --filter vulseek typecheck`
  - `pnpm --filter vulseek lint`
  - `pnpm --filter vulseek build-next`
  - `git diff --check`
- 使用 agent-browser 在 `1440×900`、`1024×768`、`390×844` 验证：
  - Projects → Environment → Profile → Job → Task → Candidate
  - Datasets → Dataset → Profile → Evaluation → Trial → Job → Task
  - 创建/删除 Dialog、Tabs、搜索、过滤、分页和浏览器 Back/Forward
- 验收要求：目标链路无旧页面壳、无页面级横向滚动、Header/actions 不裁切、列表行保持单行资源布局、Tabs 与内容节奏一致、console 无新增错误。

## Assumptions

- 采用高保真的 Dokploy 结构和间距，但保留 Vulseek 品牌、文案和业务信息。
- 本轮是纯视觉与组件结构重构，不继续现有计划中的 API、分页协议或 canonical route 迁移。
- 共享 primitive 调整可能影响其他 Vulseek 页面，因此需做 dashboard 冒烟回归，但不主动迁移非 Projects/Datasets 页面。
- 当前工作树已有修改必须保留；实现时只在现状上增量编辑，不恢复或覆盖用户改动。
