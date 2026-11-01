# 项目架构

本文档描述仓库当前的职责边界、依赖方向和运行时数据流，并给出保持行为等价的渐进式拆分路线。它不是一次性目录重写方案；涉及 Chrome 扩展执行上下文、持久化事务或跨页面任务接续的边界，应优先保持稳定。

## 技术与运行环境

- WXT 负责 Manifest V3 扩展入口、构建和打包。
- React 提供 Options Page 与 Side Panel 共用的管理界面。
- Zustand 管理界面状态和用例调用。
- Tailwind CSS 与 Motion 负责样式和动效。
- `chrome.storage.local` 保存应用数据，`chrome.storage.session` 保存运行中任务、队列和租约等短期状态。
- Content Script 负责页面 DOM 自动化；Background Service Worker 负责浏览器 API、任务调度和跨页面协调。
- Vitest + jsdom 覆盖纯逻辑与 DOM 单元测试，Playwright 覆盖扩展端到端流程、截图和真实站点验证。
- OpenCV.js Worker 为滑块图像匹配提供运行时能力。

## 当前目录职责

```text
.
├─ public/                  构建时原样复制的扩展静态资源
│  ├─ icon/                Manifest 使用的扩展图标
│  └─ opencv/              滑块图像匹配 Worker 及 OpenCV.js
├─ scripts/                 图标、探测、种子数据等人工开发工具
├─ src/
│  ├─ assets/              全局样式入口与静态源码资产
│  ├─ automation/          Content Script 使用的页面自动化与纯判定逻辑
│  ├─ background/          Service Worker 的队列、代理、任务和浏览器能力模块
│  ├─ components/          React 页面、业务组件与表单组件
│  ├─ data/                持久化仓库、迁移与关联数据写入
│  ├─ entrypoints/         WXT 识别的扩展入口
│  ├─ lib/                 跨功能复用的协议、存储和纯工具
│  ├─ sites/               站点模板、内置站点与配置合并规则
│  ├─ stores/              UI 状态和应用用例适配
│  └─ types/               共享领域类型与协议类型
├─ tests/                   Playwright、真实站点、截图及测试夹具
├─ docs/                    稳定的项目文档
├─ wxt.config.ts            WXT 与扩展 Manifest 配置
├─ vitest.config.ts         单元测试配置
└─ tsconfig.json            TypeScript 配置
```

### WXT 入口

- `src/entrypoints/background.ts`：Background Service Worker。注册 Chrome 事件、接收消息、驱动任务队列并协调标签页、OAuth、代理、定时任务和结果回写。
- `src/entrypoints/auto-login.content.ts`：注入页面的 Content Script。读取当前标签页任务并调用自动化引擎；没有任务时立即退出。
- `src/entrypoints/options/`：整页管理界面入口。
- `src/entrypoints/sidepanel/`：Side Panel 管理界面入口。

Options Page 和 Side Panel 虽然共同渲染 `App`，但它们是两个独立的 WXT 入口，拥有不同的页面载体和 `surface` 参数。两份很薄的 `main.tsx` 与 `index.html` 是有意保留的入口声明，不属于应消除的业务重复。

### Automation 与 Background

`automation/` 主要运行在网页上下文，负责：

- 识别登录、授权、公告、签到和挑战页面；
- 操作 DOM、填写受控输入框、点击页面控件；
- 按任务 `stage` 接续登录和签到流程；
- 解析页面或接口返回的身份、余额和签到证据；
- 将进度和结果通过类型化消息交给 Background。

`background/` 主要运行在扩展 Service Worker，负责：

- 串行签到队列和任务生命周期；
- 标签页创建、关闭、恢复与超时清理；
- 全局代理租约、认证和连接错误处理；
- OAuth 弹窗接管与任务重新绑定；
- 可信指针、截图和滑块图像匹配等浏览器级能力；
- 无标签页签到尝试、计划任务和实时进度汇总。

同一功能可能在两个目录各有一部分。例如滑块的 DOM 检测属于 `automation/`，截图、OpenCV 和可信拖动属于 `background/`。这是浏览器执行上下文形成的必要边界，不应仅为目录聚合而合并。

### Data、Store 与消息协议

- `data/app-repository.ts` 是 `chrome.storage.local` 的集中写入边界，负责迁移、串行写锁和跨集合关联清理。
- `stores/app-store.ts` 面向 React 组件提供加载、查询和命令方法。读取可经 Repository 完成，需要后台协调的写入和任务命令通过消息发送。
- `lib/messaging.ts` 定义核心消息与统一响应包装。
- `lib/messages/` 按功能域拆分消息和响应类型，避免所有功能共同修改一个大型联合类型文件。
- `types/` 保存跨运行上下文共享的数据结构，不能依赖 React、DOM 或 Chrome 运行时实现。

## 依赖方向

依赖应从入口和界面层流向应用、领域和基础模块：

```text
entrypoints/options, sidepanel
  -> components
  -> stores
  -> data / messaging / sites / types

entrypoints/background
  -> background
  -> data / shared domain logic / lib / sites / types

entrypoints/auto-login.content
  -> automation
  -> shared domain logic / lib / sites / types

data
  -> storage / storage-lock / sites / types

lib, sites
  -> types

types
  -> no runtime project dependency
```

当前有少量纯逻辑仍位于 `automation/`，同时被组件或 Background 使用，例如诊断分类、站点适配器和部分余额解析。这些模块没有 DOM 副作用，后续可迁入共享领域目录。迁移前允许现有依赖继续存在，不应通过复制实现来临时消除跨目录引用。

必须保持以下约束：

1. `components/` 和 `stores/` 不得依赖具体的 Background 实现文件，只能通过消息协议调用浏览器侧能力。
2. `background/` 不得依赖 React 组件或 UI Store。
3. `automation/` 不得直接持有应用持久化事务，只回报类型化进度和结果。
4. `data/` 不得依赖 DOM 自动化或 React。
5. `types/` 不得引入运行时代码；barrel 导出只用于提供稳定的类型入口。
6. 消息发送方、消息类型和 Background 处理器必须在同一批改动中保持一致。

## 运行时数据流

### 界面加载与数据变更

```text
Options Page / Side Panel
  -> App
  -> Zustand Store.load()
  -> App Repository
  -> chrome.storage.local
```

界面发起需要浏览器协调的命令时，数据流为：

```text
Component
  -> Store / sendMessage
  -> Background message handler
  -> App Repository or browser capability
  -> chrome.storage / Chrome API
  -> STATUS_CHANGED broadcast
  -> Store reload
```

持久化写入集中在 Repository 的写锁内。删除站点、账号或代理时会同时清理状态、结果、余额、计划和关联引用；这些跨集合更新必须保持同一个原子写入边界。

### 签到任务

```text
UI START_LOGIN / START_BATCH
  -> Background 串行队列
  -> 解析站点、账号和代理
  -> 建立任务状态与代理租约
  -> 创建并导航任务标签页
  -> Content Script GET_TASK
  -> automation engine 按 stage 执行
  -> SET_STAGE / SYNC_PROGRESS
  -> 页面跳转后由新的 Content Script 接续
  -> TASK_RESULT
  -> Background 回写状态与结果
  -> 释放标签页、代理和队列占用
  -> 广播界面刷新
```

任务跨页面跳转时，Content Script 会被销毁重建，因此可恢复状态保存在 `chrome.storage.session`，而不是只放在 Service Worker 内存中。任何会触发页面跳转的动作必须遵守“先记录日志、再保存 stage、最后执行动作”的顺序，否则跳转会使进度丢失。

### Service Worker 恢复

Manifest V3 Service Worker 可能随时休眠。队列、任务信箱、OAuth 弹窗关系和代理租约等需要恢复的数据不能仅存于模块变量。启动、安装、闹钟和标签页事件会触发恢复或清理逻辑，并根据仍然存在的标签页和持久状态决定继续、失败或释放资源。

## 测试与工具归属

### 可重复测试

- `src/**/*.test.ts`：与实现同目录的单元测试，覆盖纯函数、DOM 判定、队列、租约和存储行为。
- `tests/e2e/`：需要真实扩展构建的正式回归与基础设施——`e2e.mjs`（加载真实扩展访问 fixture 的主要端到端回归）、
  `real-site-e2e.mjs`（需要显式凭据的真实站点流程）、`ui-shots.mjs`（界面截图与渲染断言）、
  `proxy-effective.mjs` / `proxy-scan-timeout.mjs`（代理生效与端口扫描超时回归），
  以及 `server.mjs`、`prepare-e2e-extension.mjs`、`wxt.e2e.config.ts`、`credentials.mjs`、
  `fixture/`（本地可控的 React 多页测试站点）等支撑文件。
- `tests/smoke/`：`real-site-smoke.mjs` 与 `site-smoke-targets.example.json`——公开登录页的只读烟测，不加载扩展、不登录。
- `tests/dev-probes/`：一次性诊断探针（`probe-*.mjs`、`dump-*.mjs`、`headless-*-proof.mjs`、`modal-probe.mjs`），
  不作为稳定断言运行，说明见该目录下的 `README.md`。

测试输出如 `tests/e2e/fixture/dist`、`tests/shots` 和 `tests/.wxt` 是生成内容，不属于源码。

### 开发工具与诊断脚本

`scripts/` 包含两类工具：

- 可重复维护工具：`gen-icons.mjs`、`verify-icons.mjs`；
- `scripts/dev-probes/`：一次性诊断或本地数据辅助（公开页面探测、选择器、书签、种子数据和代理池脚本）。

凭据、真实站点响应、截图、日志、代理节点和临时生成图片不得进入 Git。仓库根目录的 `output/`、`.tmp-*.json`、`tmp-imagegen-*` 和 `tmp/` 均视为本地产物。

## 当前不应拆分的边界

以下边界包含强时序、浏览器生命周期或原子写入约束，不能通过机械移动完成重构：

1. **Background 入口与任务生命周期**：消息路由、队列、标签页、OAuth、代理和终态清理互相协作。没有覆盖事件注册和恢复路径的测试前，不拆 `entrypoints/background.ts`。
2. **自动化主流程**：`engine.ts`、`steps.ts` 与 `checkin.ts` 共享 stage、日志顺序、页面跳转和错误判定契约。策略拆分必须保持调用顺序和超时语义。
3. **Repository 写事务**：`app-repository.ts` 的关联删除、身份迁移、状态结果和余额更新依赖同一写锁。不能按文件名简单拆成多个各自写存储的 Repository。
4. **消息协议**：`lib/messaging.ts`、`lib/messages/`、Background handler 和发送方是一套跨上下文契约，不能只移动或修改其中一端。
5. **Options 与 Side Panel 入口**：两个 WXT 页面入口必须分别保留。
6. **滑块执行上下文**：DOM 检测、后台截图、OpenCV Worker 和可信指针属于不同上下文；目录拆分不能改变 Worker URL 或 Chrome debugger 生命周期。
7. **OpenCV 静态路径**：`public/opencv/worker.js` 通过运行时 URL 加载资源，移动前必须同步修改引用并做真实扩展构建验证。

## 分阶段结构优化

每个阶段都应独立提交，保持原导出入口兼容，并在进入下一阶段前完成对应验证。

### 阶段 0：仓库卫生与可移植性

- 统一 UTF-8、LF、两空格缩进和文件末尾换行。
- 忽略本地产物，不删除或移动开发者已有文件。
- 移除机器专属 pnpm store 路径，保留可移植的单包 workspace 声明。
- 保持根目录只承载入口文档和构建配置。

验证：`git diff --check`、`pnpm --version`、`pnpm list -r --depth -1`。

### 阶段 1：纯类型与站点配置

- 将 `types/index.ts` 中的站点、账号、代理和任务类型分别迁入领域文件。
- 将 `sites/index.ts` 中的选择器、模板、内置站点和合并规则分别迁入模块。
- 保留原 `types/index.ts` 与 `sites/index.ts` barrel，避免调用方一次性改路径。

验证：`pnpm compile`、`pnpm test`、`pnpm build`。

### 阶段 2：共享领域逻辑

- 将无 DOM 副作用的诊断分类、站点适配和余额纯计算迁入共享领域目录。
- `components/`、`background/` 和 `automation/` 共同依赖共享实现。
- DOM 读取继续留在 `automation/`，Chrome API 调用继续留在 `background/`。

验证：相关单元测试、`pnpm compile`、`pnpm test`、`pnpm build`。

### 阶段 3：持久化迁移与 UI 聚合点

- 先将 Repository 顶部的纯迁移规则抽到 `data/migrations.ts`，保留单一写锁和公开 `appRepository`。
- 将 `App.tsx` 的控制逻辑、页面骨架和 Modal 容器分开，但保持 DOM 顺序、Store 接口和消息调用不变。
- 样式只在组件结构稳定后按原顺序拆分，避免层叠次序变化。

验证：`pnpm compile`、`pnpm test`、`pnpm build`、`pnpm test:ui`。

### 阶段 4：Background 与自动化编排

- 在具备消息路由、恢复、OAuth 和终态清理测试后，将 Background handler 按功能域拆分。
- 入口仅保留 Chrome 事件注册和依赖装配，协调器管理共享生命周期。
- 自动化签到策略按 `auto`、`button`、`api`、`relogin`、`claim` 和 `workflow` 渐进拆分，共享页面识别与日志契约。

验证：全部单元测试、扩展构建、fixture E2E、UI 测试，以及与改动域对应的真实站点只读烟测。

## 结构变更检查清单

提交任何目录或模块拆分前，确认：

- 没有改变 WXT 入口名称和入口目录；
- 没有复制共享逻辑形成两个实现；
- 原 barrel 导出和公共消息类型仍可用；
- Chrome 事件监听器没有重复注册或遗漏；
- storage key、任务 stage 和消息 `type` 字符串没有变化；
- Repository 的写锁与跨集合更新仍在同一事务边界；
- 页面跳转前的日志与 stage 写入顺序没有变化；
- Worker、图标和扩展静态资源 URL 没有变化；
- `pnpm compile`、单元测试和扩展构建通过；
- 涉及 UI、任务流程或浏览器生命周期时，已运行对应的专项测试。
