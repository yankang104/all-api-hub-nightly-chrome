# 一次性诊断探针

这个目录下的脚本是为定位某一次具体问题而写的诊断工具，不是可复用的回归测试。

- 不进 CI，package.json 里也不会逐一注册对应 script（`test:real:dump` 除外，
  它指向 dump-checkin-page.mjs，作为排查签到页结构的固定入口保留）。
- 文件名前缀 probe- / dump- / headless-*-proof 都属于这一类：探测页面结构、
  验证某个一次性假设是否成立，结论固化后代码保留但不再维护。
- 不要在这里添加断言式的回归测试，那类测试放在 tests/e2e（需要真实扩展）
  或 tests/smoke（只读烟测）。

scripts/dev-probes 是同类脚本在开发工具侧的对应目录：选择器探测、书签读取、
种子数据注入等一次性辅助脚本。
