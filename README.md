# 自助签到中转站

一个基于 Chrome Manifest V3 的多站点、多账号登录与签到管理扩展。使用 WXT、React、TypeScript、Zustand 和 Tailwind CSS 构建，当前版本为 `0.2.2`。

## 功能

- 管理多个站点和账号，支持单账号执行、批量队列与定时签到。
- 支持账密登录、GitHub / LinuxDO 授权、会话复用与账号身份核对。
- 支持页面按钮、接口、重新登录、奖励领取和录制的学习流程。
- 提供余额、今日状态、执行进度与诊断记录。
- 从书签导入站点，从 Chrome 密码 CSV 导入账号，使用口令加密备份迁移数据。
- 提供代理与 Clash 配置管理，以及整页管理界面和 Chrome 侧边栏。

站点页面、验证流程和接口会变化，内置模板与学习流程需要按实际站点验证。

## 安装与运行

准备 Node.js 24 或更高版本，以及 pnpm `11.25.0`。

```bash
git clone https://github.com/yankang104/all-api-hub-nightly-chrome.git
cd all-api-hub-nightly-chrome
pnpm install --frozen-lockfile
pnpm build
```

1. 在 Chrome 打开 `chrome://extensions`，启用「开发者模式」。
2. 点击「加载已解压的扩展程序」，选择项目中的 `.output/chrome-mv3`。
3. 点击扩展图标打开管理页，添加或导入站点及账号。
4. 先执行一个账号并查看结果，再按需设置批量任务或定时计划。

开发时运行 `pnpm dev`，加载 `.output/chrome-mv3-dev`。生产构建更新后，在扩展管理页点击「重新加载」。`pnpm zip` 可生成安装包。

## 开发与测试

| 命令 | 用途 |
| --- | --- |
| `pnpm dev` | WXT 开发模式 |
| `pnpm compile` | TypeScript 严格检查 |
| `pnpm test` | 单元测试，单 worker |
| `pnpm build` | 生产构建 |
| `pnpm test:icons` | 检查扩展图标 |
| `pnpm test:fixture` | 构建本地端到端测试站点 |
| `pnpm test:e2e` | 加载扩展，验证本地登录与签到流程 |
| `pnpm test:ui` | 虚构数据截图与布局检查 |
| `pnpm zip` | 打包扩展 |

首次运行浏览器测试需要安装 Playwright Chromium：

```bash
pnpm exec playwright install chromium
pnpm build
pnpm test:fixture
pnpm test:e2e
pnpm test:ui
```

在无桌面的环境中，设置 `E2E_HEADLESS=1` 后执行 `pnpm test:e2e` 或 `pnpm test:ui`。真实站点测试会使用账号并可能执行签到，请按 [测试指南](docs/TESTING_GUIDE.md) 单独配置。

## 目录

```text
src/entrypoints/   WXT 入口：后台、内容脚本、管理页、侧边栏
src/automation/    页面识别、登录、签到、学习与验证
src/background/    队列、代理、OAuth、滑块与任务生命周期
src/components/    React 界面
src/data/          数据迁移与集中持久化写入
src/stores/        Zustand 状态
src/lib/          消息协议与共享工具
src/sites/        站点模板
src/types/        共享类型
tests/            单元测试以外的端到端、烟雾与诊断脚本
public/           图标及 OpenCV.js Worker
scripts/          图标生成与开发辅助工具
docs/             架构、流程设计与测试文档
```

单元测试与源码放在一起，命名为 `*.test.ts`。`tests/dev-probes` 和 `scripts/dev-probes` 中的一次性诊断脚本不属于持续集成测试。

## 数据与权限

账号、站点和运行数据保存在当前浏览器的 `chrome.storage.local`。**本地账号凭据当前以明文保存**；导出的账号备份使用 PBKDF2 与 AES-GCM 口令加密，两者的保护范围不同。

扩展按功能使用标签页、Cookie、脚本注入、书签、代理、定时器与调试器等权限。`<all_urls>` 用于访问用户配置的站点；内容脚本会先检查当前标签页是否有任务。代理设置作用于整个 Chrome，任务结束时由扩展恢复。

凭据 CSV、私钥、订阅抓取结果、浏览器测试资料和运行日志应保留在本地。提交问题时请移除账号、Cookie、Token、代理订阅链接及备份内容。详见 [安全说明](SECURITY.md)。

## 项目文档

- [架构与模块边界](docs/ARCHITECTURE.md)
- [测试指南](docs/TESTING_GUIDE.md)
- [通用签到流程设计](docs/通用签到流程设计.md)
- [参与开发](CONTRIBUTING.md)

仓库暂未指定项目整体许可证；第三方依赖及随附资源的权利和许可归各自项目所有。
