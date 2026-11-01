# 参与开发

## 本地验证

使用 Node.js 24+ 和 `package.json` 中固定的 pnpm 版本：

```bash
pnpm install --frozen-lockfile
pnpm compile
pnpm test
pnpm build
pnpm test:icons
```

修改登录、签到或任务生命周期后，构建本地测试站点并运行扩展端到端测试：

```bash
pnpm exec playwright install chromium
pnpm test:fixture
pnpm test:e2e
```

界面改动再运行 `pnpm test:ui`。真实站点测试配置见 [测试指南](docs/TESTING_GUIDE.md)。部分 HTTPS 专项脚本需要本地测试证书及私钥；私钥不随仓库分发，不属于默认端到端测试的依赖。

## 代码约定

- 使用两个空格缩进、单引号和 `@/*` 路径别名，中文注释与界面文案。
- 组件使用 PascalCase，函数使用 camelCase，模块使用 kebab-case。
- 保持 WXT 入口名称稳定；通过类型化消息让 UI 调用后台能力。
- `background/` 不依赖 React，`automation/` 不直接写持久化，`types/` 不引入运行时实现。
- 业务修复补充对应的同目录单元测试。诊断探针放到 `dev-probes`，避免混入回归测试。
- 不手工修改 `.wxt/`、`.output/` 或 `node_modules/`。

## 提交与 Pull Request

提交使用 Conventional Commits 和简洁的中文说明，例如 `fix: 修复签到状态回写`。PR 说明具体问题、修改后的行为和验证结果；界面改动附虚构数据截图。

提交前检查暂存区，确保不含账号、Token、Cookie、代理订阅、运行日志、凭据 CSV、私钥或浏览器用户目录。报告问题使用示例账号和脱敏日志。
