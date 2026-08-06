# Vulseek UI System Unification Plan

## 1. 目标与范围

本计划统一 Projects、Datasets 及其 Profile、Evaluation、Scan Job、Task、Registry 等页面的视觉语言、交互模型和组件结构。目标不是一次性换肤，而是建立可持续复用的 UI contract，消除同层级资源各自实现页面壳、列表、状态和路由的现状。

本轮浏览器审查覆盖了 Projects/Datasets 列表、Project Environment、Project/Dataset Profile、Evaluation Overview/Trials、Project/Dataset Job 与 Task、Candidates/Research Registry、创建模态框，以及 390px 移动端。实现继续使用当前 Pages Router、Next.js 16 preview、React 18、Radix UI、Tailwind 和 TanStack Table；不把 App Router 或 React 19 迁移混入本次工作。

## 2. 审查结论

### 2.1 高优先级问题

- Dataset Job/Task 是 Project Scan Job/Task 的简化副本，路由、面包屑、Tabs、Files、Session、状态和列表能力均不一致。两类入口应复用同一页面实现，仅注入不同导航上下文。
- Project Jobs 会一次渲染大量卡片；Datasets、Profiles、Evaluations、Trials 等列表又缺少搜索、过滤、排序或分页。列表能力没有统一的数据契约。
- `show-scan-job-detail.tsx` 已超过 5,000 行，混合查询、轮询、URL 状态、列表、详情和业务动作，无法作为可维护的共享基线。
- 共享 `Dialog` 强制 `modal={false}`，并自行模拟 overlay、滚动锁和 outside interaction，增加焦点、键盘与嵌套弹层风险。
- Dataset 页面重复定义 `statusClassName`，其他页面又使用 `Badge`、`StatusTooltip` 或裸文本；同一状态在颜色、尺寸、动画和文案上不一致。

### 2.2 一致性问题

- Projects 与 Datasets 都是顶层资源集合，但前者有搜索/排序，后者没有；卡片标题、元数据、空状态和动作位置不同。
- Project Environment 与 Dataset Detail 都管理 Profiles，却使用不同卡片结构、创建流程和删除交互。
- Profile、Evaluation、Job、Task 的标题区、Tabs 间距、内容边框和返回按钮各自实现；面包屑存在时仍重复显示 `Back to ...`。
- Candidates、Findings、Tracks、Primitives、Chains、Tasks、Trials 的 toolbar、页码、page size、排序箭头和详情入口没有共同规则。
- Advanced 页面把大量不相关配置纵向堆叠，并分散多个 Save 按钮，缺少 section navigation、dirty state 和稳定操作区。
- 移动端仍直接展示桌面表格与高密度 toolbar，Tabs 和表格产生横向溢出。

### 2.3 可保留的基线

- `DashboardPanelShell` 的“侧栏色外框 + 主内容面”可作为统一页面容器，但应减少内部 Card 套 Card。
- Project Scan Job 的 URL 同步 Tabs、Tasks 分页和 Candidate 详情路由可作为能力基线。
- Research Registry 已有服务端分页、过滤、排序和右侧 Sheet，可抽象为通用 CollectionView，而不是继续复制。
- 仓库已有 TanStack Table、Radix Dialog/Sheet/Tabs 和 Tailwind token，无需引入第二套 UI 库。

## 3. 统一视觉规范

### 3.1 页面层级

每个 dashboard 页面固定采用以下结构：

```text
BreadcrumbBar
DashboardPageShell
  PageHeader (icon, title, description, status, primary/secondary actions)
  PageTabs? (URL-backed)
  PageBody
    Section / CollectionView / FormSection
```

- 页面只保留一个主 surface。普通 section 使用分隔线或轻边框，不再默认嵌套厚重 Card。
- 页面 padding：移动端 `16px`，桌面 `24px`；section gap 为 `16/24px`。
- surface 圆角 `12px`，普通 panel 和 dialog `10px`，control `8px`。阴影仅用于主 surface、Dialog、Sheet，不用于每一行列表。
- 页面标题 `24/32 semibold`，section 标题 `18/26 semibold`，card/row 标题 `14/20 medium`，正文 `14/20`，辅助与 monospace metadata `12/18`。
- 继续使用现有 Inter 与 monospace 配置，不在本轮引入新字体。

### 3.2 状态与标签

新增唯一的 `EntityStatus` 映射层，领域组件只传 `kind` 和 `value`，禁止在页面内拼接颜色类。

| 语义 | 示例 | 表现 |
| --- | --- | --- |
| neutral | pending, queued, idle, canceled, exited | 灰色 badge |
| info | preparing, launching, starting | 蓝色 badge |
| active | running, dispatching, finalizing | 绿色 badge + 仅此类使用轻量 pulse/spinner |
| success | ready, completed, finished, accepted, confirmed | 绿色静态 badge |
| warning | paused, partially_finished, needs-more-evidence | 琥珀色 badge |
| danger | failed, error, invalidated, false-positive | 红色 badge |

拆分 `StatusBadge`、`MetadataBadge`、`FilterChip` 三种用途，移除页面中的任意 `red/yellow/green` 选择。状态文案统一 sentence case，不依赖 CSS `capitalize` 修正数据库值。

### 3.3 按钮、动画与反馈

- 每个 header/section 最多一个 primary action；其余使用 outline、ghost 或 overflow menu。
- 统一尺寸：compact `32px`、default `36px`、large form action `40px`；移动端可点击区域至少 `44px`。
- icon-only 按钮必须有 tooltip 和 `aria-label`；危险操作只使用 destructive variant 并进入 `ConfirmDialog`。
- 运行态动画只表达真实进度。页面进入使用 skeleton/stagger 不超过 `200ms`；禁止为静态 card 添加无意义缩放。
- 所有动画尊重 `prefers-reduced-motion`，路由切换保留旧数据并显示局部 loading，不闪空页面。

## 4. 共享组件架构

### 4.1 页面组合组件

在 `apps/vulseek/components/dashboard/ui-system/` 建立组合层，底层 Radix primitive 继续位于 `components/ui/`：

```text
DashboardPage
  DashboardPage.Header
  DashboardPage.Tabs
  DashboardPage.Body

CollectionView
  CollectionView.Toolbar
  CollectionView.Filters
  CollectionView.BulkActions
  CollectionView.Grid | CollectionView.Table
  CollectionView.Pagination
  CollectionView.Empty | Loading | Error

EntityDetailSheet
FormSection
FormActions
EntityStatus
```

使用 compound components 和显式 variant，避免一个组件堆积 `showSearch/showFilters/cardMode/compact/...` 布尔参数。领域页面提供 columns、filter schema、row identity、actions 和 detail renderer，不再自行实现 toolbar/pagination。

### 4.2 CollectionView 契约

- 所有可能持续增长的集合使用服务端契约 `{ items, total, page, pageSize }`。Jobs、Tasks、Candidates、Findings、Tracks、Primitives、Chains、Evaluations、Trials 必须分页；Projects/Datasets/Profiles 也使用同一接口，即使当前数量较少。
- URL 是列表状态唯一来源：`q`、`status`、领域过滤项、`sort`、`order`、`page`、`pageSize`。切换 Tab 时清除不适用的列表参数，而不是保存多套冗长前缀参数。
- 搜索输入即时回显，使用 `useDeferredValue`/`startTransition` 更新结果；只有请求层 debounce。任何 filter/search/sort 变化都把 page 重置为 1。
- Table 使用 TanStack Table manual sorting/pagination；卡片集合使用同一 controller。底部统一显示 `x-y of total`、page size、上一页/下一页和页码。
- 桌面 toolbar 左侧搜索，右侧 filters/sort/view；选择行后用同位置的 contextual bulk action bar 替换，不改变纵向布局。
- 一行只保留一个主导航 anchor 和一个 actions menu。禁止整张 Link/Card 内再嵌套按钮，也不重复提供 row click、标题链接和 `View` 链接。

### 4.3 表单、Dialog 与 Sheet

- `FormField` 固定 label、optional description、control、validation message；禁止用 placeholder 代替 label。
- 长配置使用 `FormSection` 与 sticky `FormActions`，保存范围明确并显示 dirty/saving/saved/error。Advanced 拆为 Pipeline、Agent、Checkout、Runtime、Network、Security 等 section，桌面使用左侧 section nav，移动端使用 accordion。
- 修复共享 `Dialog`，恢复 Radix `modal=true`、focus trap、Escape、overlay 和 body scroll lock；Popover/Command 的嵌套问题通过明确 portal/container 处理，而不是关闭 modal semantics。
- 短创建流程统一为 `Create <Resource>` Dialog，footer 为 `Cancel` + `Create`。如果先选择类型，header 按钮打开 type menu，选择后再进入 Dialog。
- `EntityDetailSheet` 设 `compact(480px)`、`default(640px)`、`wide(800px)`；移动端全屏。详情必须 route-backed，可刷新、复制链接并用浏览器 Back 关闭。

## 5. 导航与路由规则

- Breadcrumb 只负责层级导航，当前项不可点击并截断显示；已有 breadcrumb 时删除内容区的 `Back to ...` 按钮。
- 所有 Tabs 使用 `?tab=<value>`，由统一 parser 校验默认值；`router.replace(..., { shallow: true })` 更新，不复制本地 tab state。
- 新增集中式 route builders，禁止页面拼接字符串。Project 和 Dataset 只提供不同的 `ScanNavigationContext`（breadcrumb、returnHref、source label）。
- Dataset Trial 和 Project Job 最终都渲染共享 `ScanJobDetail`；Dataset Task 和 Project Task 都渲染共享 `ScanTaskDetail`。先复用组件并保留旧 URL，稳定后增加 canonical `/dashboard/scan-jobs/[scanJobId]` 与 `/tasks/[taskId]`，旧 URL 用 redirect/compat entry 保留书签。
- Candidate/Registry detail 采用嵌套路由或稳定 detail query，返回时完整保留 list query。Pages Router 阶段不为了 intercepted routes 强行迁移 App Router。

## 6. 各页面目标形态

| 当前页面 | 目标 |
| --- | --- |
| Projects / Datasets | 同一 `ResourceCollectionPage`：标题、说明、创建按钮、搜索、排序、分页、统一 card metadata/actions |
| Project Environment / Dataset Detail | 同一 Profile collection shell；类型差异由 card content 和 create flow 注入 |
| Project / Dataset Profile | 同一 entity header + URL Tabs；Overview 展示配置与 summary，Jobs/Evaluations 使用 CollectionView |
| Evaluation Overview / Trials | Overview 使用标准 metric grid；Trials 支持搜索、状态/样本过滤、排序、分页，主链接进入共享 Job |
| Scan Job / Task | 删除 Dataset 简化副本，复用完整扫描 shell；按 scan type 声明 tabs，不在 5,000 行组件中条件堆叠 |
| Candidates / Research / Goal registries | 共享 DataTable、filter schema、StatusBadge 和 route-backed EntityDetailSheet |
| Advanced | section navigation + 分组表单 + 稳定保存区，避免无限纵向 card 堆叠 |

## 7. 响应式与可访问性

- `>=1024px` 使用完整 toolbar/table；`640-1023px` 隐藏低优先级列；`<640px` 将表格行转换为 `MobileResultCard`，不是缩小桌面表格。
- 移动端 filters 放入 Sheet，顶部仅保留搜索和 Filter 按钮；Tabs 可横向滚动并显示边缘渐隐，但页面本身不得横向滚动。
- Dialog/Sheet 初始焦点、关闭后焦点恢复、Escape、Tab 顺序、aria title/description 必须由 Radix 语义保证。
- 状态不能只依赖颜色；运行 spinner、文字和 icon 同时表达。表头排序提供 `aria-sort`，选择框有资源名称 label。
- 长 ID、路径和错误使用 `min-w-0`、line clamp 或局部横向滚动；禁止文本撑宽整个页面。

## 8. 实施阶段

### Phase 0: 基线与约束

- 保存关键页面 desktop/mobile 截图基线，建立浏览器测试矩阵。
- 定义 typography、spacing、radius、status 和 motion token；记录允许的页面结构。
- 为 route/query parsers、status mapping 和 pagination contract 补单测。

### Phase 1: Primitive 与 Shell

- 修复 Dialog，扩展 Sheet size，新增 EntityStatus、DashboardPage、PageHeader、PageTabs、Empty/Loading/Error state。
- 让旧 `DashboardPanelShell` 代理新 shell，分批迁移，避免一次性大改。

### Phase 2: CollectionView

- 基于 TanStack Table 建立 server-mode DataTable、Toolbar、Filters、BulkActions 和 Pagination。
- 先迁移 Research Registry 与 Tasks，验证复杂过滤、轮询和详情 Sheet；再迁移 Projects/Datasets。

### Phase 3: Resource 页面

- 统一 Projects/Datasets、两类 Profile collection、Profile header/Tabs、Evaluation/Trials。
- 增加缺失的 paginated API，移除一次加载/渲染全部 Jobs 和 Evaluations 的路径。

### Phase 4: Scan 页面收敛

- 将 `show-scan-job-detail.tsx` 按 Overview、Tasks、Registry、Monitoring、Files 和 Actions 拆分，query controller 上移到 context。
- Dataset Job/Task 切换到共享 Scan 页面；删除重复 route page UI，仅保留 navigation adapter。

### Phase 5: Forms 与清理

- 重构 Advanced、创建 Dialog 和 destructive flows。
- 删除本地 `statusClassName`、重复 query-state、重复 pagination、冗余 Back/View 按钮及失效 CSS。

## 9. 测试与验收

### 自动测试

- Vitest：query parse/serialize、status exhaustive mapping、pagination boundary、selection across pages、route builders。
- React 测试：toolbar 状态、filter clear、sort、bulk action、Dialog focus、Sheet back navigation、loading/empty/error。
- tRPC repository/API：所有增长型列表的过滤、排序、分页和 organization authorization。
- 执行 `pnpm --filter vulseek test`、两个相关 typecheck、Biome/check 和 `git diff --check`。

### Agent-browser 回归

在 `1440x900`、`1024x768`、`390x844` 验证：

- Projects -> Environment -> Profile -> Jobs -> Job -> Task；
- Datasets -> Profile -> Evaluation -> Trials -> Job -> Task；
- Candidates/Findings/Tracks/Primitives/Chains 的搜索、过滤、排序、分页和详情 Sheet；
- 创建/删除 Dialog 的键盘、焦点和失败态；浏览器 Back/Forward、刷新与深链接；
- 页面无横向溢出、重复返回按钮、嵌套交互元素、console error 或失败请求。

验收指标：增长型列表初始 DOM 不超过当前页数量；列表 API p95 `<500ms`；搜索/过滤输入不阻塞；所有运行状态映射一致；移动端无页面级横向滚动；同一个 Job/Task 在 Project 与 Dataset 入口呈现同一能力和布局。

浏览器审查期间观察到 Next preview dev HMR 的 `isrManifest/components` console warning，应单独跟踪，不得用它掩盖应用自身错误，但不作为本 UI 迁移的阻塞项。

## 10. 非目标

- 不在本计划中迁移 App Router、React 19 或更换 UI 框架。
- 不改变 Project、Dataset、Evaluation、Scan 的业务语义和权限模型。
- 不追求一次 PR 完成全站迁移；每个 Phase 必须可独立发布，并保留旧 route 的兼容入口直到最终清理。
