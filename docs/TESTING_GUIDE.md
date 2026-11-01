# 真实站点测试指南

本指南帮助你对每个站点进行完整的真实测试，验证全自动化功能。

## 测试准备

### 1. 构建扩展
```bash
pnpm build
```

构建完成后，扩展输出在 .output/chrome-mv3 目录。

### 2. 准备测试凭据

在**项目外**创建凭据文件：
```
../_凭据_勿入库/Chrome 密码.csv
```

CSV 格式：
```csv
name,url,username,password
可萌中转站,https://api456.me/login,test_user,test_password
1412's API,https://napi.kid1412.qzz.io/sign-in,your_username,your_password
```

**安全提示**：
- 凭据文件必须在项目外，避免误入版本控制
- 测试脚本只读取凭据，不会打印密码

### 3. 设置环境变量（可选）

```powershell
# 使用自定义凭据路径
$env:CHECKIN_CREDENTIALS_CSV = 'D:\secrets\passwords.csv'

# 浏览器保持打开（方便调试）
$env:SITE_E2E_KEEP_OPEN = 'true'

# 显示浏览器界面（默认无界面）
$env:SITE_SMOKE_HEADLESS = 'false'
```

---

## 测试流程

### 学习流程运行时防护（隔离验收）

此项不访问真实站点，不读取外部凭据；加载真实扩展，在 localhost 虚构站点先演示一次
「登录 → 资料页核对身份 → 打开面板 → 签到」，然后只在回放时加入未演示的干扰：

- 正确账号直接复用、未登录自动登录、错误账号退出重登；
- 登录页、资料页、签到页及操作后公告，以及临时算术验证；
- 进入签到页或步骤之间掉线，包括页面仍残留已登录标记但接口返回 401；
- 步骤之间串号，以及验证完成时 Cookie 串号但页面仍显示原账号；
- 点击后快照窗口结束才出现的算术验证，在等待元素/断言期间沿用原验证处理并自动接续，且不重放点击。

自动完成场景均断言只向目标账号提交一次签到、提交前最后一次服务端身份核对正确，
且任务结束后释放队列，运行期间没有被新增环境检查转成「需处理」。学习产物不能含
示范账密或临时干扰步骤。

~~~powershell
pnpm build
node tests/e2e/workflow-runtime-guards.mjs
~~~

可通过 EXTENSION_DIR 指定其它构建目录。浏览器配置放在 output/workflow-runtime-acceptance，
不使用日常浏览器资料。若本机 Playwright 浏览器损坏，可将 PLAYWRIGHT_BROWSERS_PATH
指向独立测试目录后运行 pnpm exec playwright install chromium，再执行验收脚本。

运行时公告、验证、身份核验与会话恢复独立于学习步骤。验证沿用原有自动求解和等待
机制，本次环境检查不新增「转人工即停止、需重新发起」策略；验证完成后仍在同一调用
中继续。原处理器返回失败时保留失败结果，不能将「点击过」「读到旧成功提示」视为成功。
保留晚挂载验证输入框的识别与滑块控件约 30 秒就绪等待；输入框自身不会新增人工接管
通知，验证结束后自动接续。环境无法恢复时结束本轮，仍禁止后置余额把中断改判成功。
单元回归还覆盖长验证后延迟挂载的指纹/滚动定位、独立滚动与固定等待被验证打断，
以及环境恢复不挤占业务等待预算。

### 抽奖站学习与回放（隔离验收）

此项同样只使用 localhost 虚构账号，不操作真实站点的抽奖或额度：

~~~powershell
pnpm build
node tests/e2e/learning-lottery.mjs
~~~

从已登录的抽奖页开始，先验证「只进入页面」不能存成登录即签到，且提示补演后仍能
继续录制；再真实点击抽奖，验证保存的是这次的点击而不是旧模板执行器。回放分别覆盖
正确账号、未登录、错误账号，并加入未演示的公告、加载期「今日已抽」占位和延迟开奖。
每个场景均断言只向目标账号抽奖一次、没有转人工、确实执行保存的点击步骤。
浏览器资料隔离保存在 output/learning-lottery-acceptance。

配套单元测试还覆盖 hash 抽奖路由、英文按钮、抽奖表单 submit、晚到结果补报、
加载占位不能当完成、当日已抽不重复点击，以及旧版误学 none 的定向修复与幂等。
旧错误配置恢复的是现有抽奖执行器，不是凭空补造丢失的学习动作；重新演示后以新流程为准。

### 阶段 1: 烟雾测试（只读）

**目的**：验证站点可访问性，检查选择器是否正确

```bash
pnpm test:real:smoke
```

**测试内容**：
- 访问登录页
- 检查 HTTP 状态码
- 验证最终 URL（重定向检测）
- 检查是否有 Cloudflare / Turnstile / CAPTCHA
- 统计配置的选择器在页面上的数量

**通过标准**：
- HTTP 200 响应
- 停留在同一主机
- 用户名输入框找到 ≥1 个
- 密码输入框找到 ≥1 个
- 提交按钮找到 ≥1 个

**不通过情况**：
- 5xx 服务器错误 → 站点暂时不可用
- 选择器找不到 → 需要更新配置

---

### 阶段 2: 完整自动化测试

**目的**：真实登录并签到，验证完整流程

```bash
# 使用真实 Chrome（推荐，避免 Turnstile 拒绝）
pnpm test:real:site --site api456 --real

# 测试后保持浏览器打开（方便人工检查）
pnpm test:real:site --site api456 --real --keep

# 使用 Playwright Chromium（可能被 Turnstile 拒绝）
pnpm test:real:site --site api456
```

**参数说明**：
- --site <关键词>: 匹配凭据 CSV 中的 name 或 url
- --real: 使用本机真实 Chrome（强烈推荐）
- --keep: 测试完成后不关闭浏览器

**测试内容**：
1. 加载扩展
2. 导入站点配置
3. 添加测试账号
4. 触发签到任务
5. 监控自动化流程
6. 验证签到结果

**验证点**：
- ✓ 扩展成功加载
- ✓ 打开登录页
- ✓ 自动关闭公告/弹窗
- ✓ 自动填充用户名和密码
- ✓ 提交登录表单
- ✓ 识别登录成功
- ✓ 验证账号身份（防止串签）
- ✓ 执行签到动作
- ✓ 检测签到成功或已签到
- ✓ 采集余额变化

---

## 按站点类型测试

### 测试 Sub2API 系站点

**特点**：
- Token 认证（localStorage）
- Cloudflare Turnstile 验证
- 需要先手动登录一次抓取 token

**测试步骤**：
1. 手动登录一次，扩展会自动捕获 auth_token
2. 之后每次自动注入 token，跳过登录表单
3. 验证身份读取 /api/v1/auth/me
4. 签到使用 /check-in 接口

**示例**：
```bash
pnpm test:real:site --site 100x --real --keep
```

---

### 测试 new-api / one-api 系站点

**特点**：
- 账密表单登录
- Semi UI 组件
- 支持 OAuth（GitHub/LinuxDO）
- 签到方式多样（button/api/auto）

**测试步骤**：
1. 自动填充用户名密码
2. 提交登录
3. 识别登录成功（URL 变化或元素出现）
4. 验证身份（匹配 username）
5. 根据配置执行签到

**示例**：
```bash
pnpm test:real:site --site api456 --real
```

---

### 测试 OAuth 站点

**特点**：
- 需要浏览器已登录 GitHub/LinuxDO
- 自动识别 OAuth 按钮
- 点击后等待授权回调

**测试步骤**：
1. 检测是否已登录
2. 未登录则点击 OAuth 按钮
3. 等待跳转回站点
4. 验证登录成功

**示例**：
```bash
pnpm test:real:site --site kid1412 --real
```

---

## 常见问题排查

### 1. Turnstile 验证失败

**原因**：Playwright Chromium 带 automation 标记

**解决**：使用 --real 参数，使用真实 Chrome

```bash
pnpm test:real:site --site <站点> --real
```

---

### 2. 选择器找不到

**症状**：日志显示"找不到用户名输入框"

**排查**：
1. 运行烟雾测试检查选择器
2. 手动打开登录页，F12 检查实际选择器
3. 更新 src/sites/index.ts 的模板
4. 或在界面上编辑站点配置

---

### 3. 登录后身份验证失败

**症状**：显示"当前登录的不是目标账号"

**原因**：浏览器残留其他账号的 cookie

**解决**：
- 测试脚本使用新的临时 profile
- 或手动清理浏览器 cookie

---

### 4. 签到按钮找不到

**排查**：
1. 检查签到方式配置（button/api/auto）
2. 确认签到页 URL 正确
3. 检查按钮选择器是否匹配

**解决**：
- 使用 uto 方式，自动寻找签到入口
- 或手动配置正确的按钮选择器

---

## 测试矩阵

为保证覆盖所有场景，建议按以下矩阵测试：

| 站点类型 | 登录方式 | 签到方式 | 挑战类型 | 测试状态 |
|---------|---------|---------|---------|---------|
| Sub2API | Token | API | Turnstile | ⬜ |
| new-api | Form | Button | 无 | ⬜ |
| new-api | OAuth | Auto | 无 | ⬜ |
| one-api | Form | API | Cloudflare | ⬜ |
| kid1412 | OAuth | Button | 无 | ⬜ |

---

## 测试报告模板

测试完成后，记录结果：

```
站点: <站点名>
日期: <测试日期>
版本: <扩展版本>

✓ 烟雾测试通过
✓ 登录流程通过
✓ 身份验证通过
✓ 签到执行通过
✓ 余额采集通过

问题:
- 无

备注:
- 测试使用真实 Chrome
- Turnstile 自动通过
- 签到成功，余额 +0.01
```

---

## 持续集成建议

### GitHub Actions 配置示例

```yaml
name: Real Site Smoke Tests
on:
  schedule:
    - cron: '0 2 * * *'  # 每天凌晨2点
  workflow_dispatch:

jobs:
  smoke:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'pnpm'
      - run: pnpm install
      - run: pnpm build
      - run: pnpm test:real:smoke
```

**注意**：不要在 CI 中运行完整测试（会泄露凭据）

---

## 安全提醒

1. **凭据管理**
   - 永不将凭据文件提交到版本控制
   - 使用项目外路径存储
   - 定期轮换测试账号密码

2. **测试账号**
   - 使用专门的测试账号
   - 不使用生产账号测试
   - 测试账号权限最小化

3. **日志脱敏**
   - 测试脚本已自动脱敏密码
   - 截图不包含敏感信息
   - 日志只输出域名和用户名

---

## 下一步

测试通过后：

1. ✓ 在真实浏览器中加载扩展
2. ✓ 导入生产站点
3. ✓ 添加真实账号
4. ✓ 配置定时任务或手动触发
5. ✓ 监控签到结果和余额变化

**项目已完全就绪，可以投入使用！**
