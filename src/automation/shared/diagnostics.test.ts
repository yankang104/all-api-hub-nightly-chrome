import { describe, expect, it } from 'vitest';
import { classifyFailure, DIAGNOSIS, isSymptom, planRetry } from '@/automation/shared/diagnostics';

describe('classifyFailure', () => {
  it('抽奖站被误存登录即签到时不能把证据不足报成会话失效', () => {
    expect(classifyFailure('当前页没有签到控件，且本轮没有发生登录动作：无法确认「登录即签到」已完成', [
      '命中登录成功证据，已处于登录状态',
      'form 登录：读不到可核对的身份，但本站只有该账号，继续签到',
    ])).toBe(DIAGNOSIS.CHECKIN_UNVERIFIED);
  });
  it('人机验证优先于其他症状', () => {
    // 验证码没过会连带导致「找不到元素」，但根因是验证码
    const code = classifyFailure('未找到签到按钮', [
      '检测到Turnstile交互式验证，等待你在当前标签页完成',
      '找不到签到按钮',
    ]);
    expect(code).toBe(DIAGNOSIS.MANUAL_REQUIRED);
  });

  it('识别站点不可用', () => {
    expect(classifyFailure('页面暂不可用，自动重试 3/3: 502 Bad Gateway')).toBe(
      DIAGNOSIS.SITE_UNAVAILABLE,
    );
  });

  it('识别网络失败', () => {
    expect(classifyFailure('签到请求失败: ERR_PROXY_CONNECTION_FAILED')).toBe(
      DIAGNOSIS.NETWORK_FAILURE,
    );
  });

  it('识别登录态失效', () => {
    expect(classifyFailure('签到接口返回 401')).toBe(DIAGNOSIS.AUTH_EXPIRED);
  });

  it('识别没有签到入口', () => {
    expect(classifyFailure('未自动发现同源签到入口')).toBe(DIAGNOSIS.NO_CHECKIN_ENTRY);
  });

  it('识别选择器不匹配', () => {
    expect(classifyFailure('找不到用户名输入框: #username')).toBe(
      DIAGNOSIS.SELECTOR_MISMATCH,
    );
  });

  it('会从步骤日志里找线索，而不只看结论', () => {
    // 结论笼统，但过程里写清楚了是选择器问题
    const code = classifyFailure('签到失败', ['配置的用户名选择器未命中，已兼容识别: #email']);
    expect(code).toBe(DIAGNOSIS.SELECTOR_MISMATCH);
  });

  it('登录成功后缺学习身份页是流程配置错误，不能用早先的重新登录日志诊断为会话过期', () => {
    expect(classifyFailure('学习签到路线缺少身份核验页', [
      '发现登录表单，需要重新登录',
      '已填写用户名',
      '已点击登录按钮',
      '命中登录成功标志',
      '表单登录成功，账号身份交由个人资料页统一核验',
      '学习签到路线缺少身份核验页',
    ])).toBe(DIAGNOSIS.WORKFLOW_CONFIG);
    expect(classifyFailure('签到页未找到明确按钮或已签到状态', [
      '发现登录表单，需要重新登录', '命中登录成功标志',
    ])).toBe(DIAGNOSIS.SELECTOR_MISMATCH);
  });

  it('无法归类时返回 unknown', () => {
    expect(classifyFailure('something went wrong')).toBe(DIAGNOSIS.UNKNOWN);
  });
});

describe('站点说出的故障原因参与重试判定', () => {
  it('「服务暂不可用」归类为站点暂不可用（→ 值得重试）', () => {
    // 真实形态：站点把后端错误渲染到页面上时常常省略主语、也不一定带状态码。
    // 必须能只凭「服务暂不可用」这四个字就归类 —— 漏掉这条规则，一次偶发
    // 5xx 会被归成「未知失败」，于是当天永久失败、永不重试。
    const code = classifyFailure('站点确认签到失败：签到失败：服务暂不可用');
    expect(code).toBe(DIAGNOSIS.SITE_UNAVAILABLE);
    expect(planRetry(code, 0).retry).toBe(true);
  });

  it('「本次没有发现安全验证」这句自述不把站点故障染成「需要人工验证」', () => {
    // 引擎每次点击后都会写一行「签到点击后未发现安全验证证据」——那是在说
    // **没有**验证，不是在说验证失败了。若它参与判定，「类排除」就没生效：
    // 一次偶发 5xx 会被归成「需要人工验证」（不可重试），用户看到的就是
    // 当天永久失败，而站点其实只是抖了一下。
    const steps = [
      '签到点击后未发现安全验证证据，继续核对本次签到结果',
      '额度无变化，当前余额 $500000.00',
    ];
    const code = classifyFailure('站点确认签到失败：签到失败：服务暂不可用（HTTP 503）', steps);
    expect(code).toBe(DIAGNOSIS.SITE_UNAVAILABLE);
    expect(planRetry(code, 0).retry).toBe(true);
  });

  it('响应未知（页面什么都没说）不归到站点暂不可用', () => {
    // 与上一条成对：没有站点明确说出的失败原因时，写请求可能已经落库，
    // 归到可重试类别就等于允许重复提交。
    const code = classifyFailure('点击自动识别的签到按钮后缺少明确结果');
    expect(code).not.toBe(DIAGNOSIS.SITE_UNAVAILABLE);
    expect(planRetry(code, 0).retry).toBe(false);
  });

  it('页面上的裸三位数字不当成 5xx：业务数字不能把失败染成「站点暂时不可用」', () => {
    // 旧规则是裸的 `\b5\d{2}\b`：页面候选里写着「领取500积分」、余额 $500000.00、
    // 或日志里出现「共 500 条记录」时，任何失败都会被判成站点故障并退避到 5 分钟。
    // 收紧后只有带 HTTP/状态码/返回 等语境的 5xx 才算。
    const steps = ['页面可点元素：立即签到 / 领取500积分', '额度无变化，当前余额 $500000.00'];
    const code = classifyFailure('工作流找不到可点击元素: text=立即签到', steps);
    expect(code).not.toBe(DIAGNOSIS.SITE_UNAVAILABLE);
    expect(classifyFailure('站点返回 502（Cloudflare）')).toBe(DIAGNOSIS.SITE_UNAVAILABLE);
  });
});

describe('弹窗保留相关的日志不制造误诊', () => {
  // 这些是新加的日志措辞。它们会进入步骤日志参与分类，
  // 措辞里一旦带上「未找到 / 选择器 / 网络」之类的词，就会把用户
  // 指向完全错误的排查方向 —— 这是最容易在后续改文案时被破坏的约束。
  it('「疑似误关功能弹窗」不被归成选择器或网络问题', () => {
    const code = classifyFailure('签到页未找到明确按钮或已签到状态', [
      '关闭弹窗后页面失去签到线索，疑似误关功能弹窗',
    ]);
    // 允许它按 message 本身归类，但这条日志自己不该引入网络/登录态误判
    expect(code).not.toBe(DIAGNOSIS.NETWORK_FAILURE);
    expect(code).not.toBe(DIAGNOSIS.AUTH_EXPIRED);
  });

  it('「保留了 N 个含签到控件的弹窗」单独出现时不硬凑分类', () => {
    expect(classifyFailure('签到任务已中断', ['保留了 2 个含签到控件的弹窗，未作为公告关闭']))
      .toBe(DIAGNOSIS.UNKNOWN);
  });
});

describe('开头的环境说明不参与判定', () => {
  // 每次任务的前两步都是 background 写的环境说明。它们必须被排除，
  // 否则「使用 Chrome/系统网络设置（扩展未覆盖代理）」里的「网络」「代理」
  // 会命中 NETWORK_FAILURE，而它的优先级高于选择器/登录态类规则 ——
  // 结果是**任何**失败都被报成「网络请求失败，检查代理节点」。
  const PREAMBLE_DIRECT = [
    '扩展版本 0.2.2-nightly-20260810',
    '使用 Chrome/系统网络设置（扩展未覆盖代理）',
  ];
  const PREAMBLE_PROXIED = [
    '扩展版本 0.2.2-nightly-20260810',
    '已启用扩展代理「香港节点」(http://127.0.0.1:7890)，来自账号配置',
  ];

  it('找不到密码框仍判为选择器问题，而不是网络失败', () => {
    const steps = [
      ...PREAMBLE_DIRECT,
      '开始处理站点「百倍」账号 330627052@qq.com',
      '未发现公告弹窗',
      '命中登录成功证据，已处于登录状态',
      '无法确认当前登录身份（读不到当前登录身份），按切换账号处理',
      '已清除 4 项本地登录态',
      '找不到密码输入框: input[type="password"]；通用规则也未命中',
    ];
    expect(classifyFailure('找不到密码输入框: input[type="password"]；通用规则也未命中', steps))
      .toBe(DIAGNOSIS.SELECTOR_MISMATCH);
  });

  it('走扩展代理时同样不会把失败误判成网络问题', () => {
    const code = classifyFailure('未找到签到按钮', [...PREAMBLE_PROXIED, '当前页没有可点的签到元素']);
    expect(code).toBe(DIAGNOSIS.SELECTOR_MISMATCH);
  });

  it('真的网络失败还是能识别出来', () => {
    // 排除环境说明不能把真实的网络症状一起排掉
    const code = classifyFailure('扩展代理连接失败，请检查代理协议、主机和端口', PREAMBLE_PROXIED);
    expect(code).toBe(DIAGNOSIS.NETWORK_FAILURE);
  });

  it('只有环境说明时不硬凑分类', () => {
    expect(classifyFailure('签到任务已中断', PREAMBLE_DIRECT)).toBe(DIAGNOSIS.UNKNOWN);
  });
});

describe('公告已成功关闭的那一轮：最终结论不再被「遮挡」回执染成 OBSCURED', () => {
  /**
   * 真实运行（AnyRouter 账号 fzy520，扩展 0.2.2-build-20261016-1734）：
   * 公告其实关成功了 —— 日志里明明写着「遮挡已清除，继续点击」—— 但因为
   * NON_SYMPTOM_PATTERNS 没排除成功回执，/遮挡/ 把这些行捞进了判定，
   * 最终结论被报成「控件被弹窗挡住了 / 先手动把站点的公告/弹窗关掉」。
   * 用户去关一个早就不存在的弹窗，而真正的原因（登录即签到没拿到到账证据）
   * 一个字都没出现。
   */
  const CLOSE_SUCCESS_LINES = [
    '公告关闭按钮已收到浏览器可信点击：「今日关闭」（div.semi-modal-content.undefined，文字识别）',
    '已确认对应公告消失或目标遮挡解除：「今日关闭」（div.semi-modal-content.undefined，文字识别）',
    '关闭了 1 个公告/弹窗',
    '遮挡已清除，继续点击',
    '公告关闭点击回执未确认，但已确认对应弹窗消失或目标遮挡解除：「button.semi-button.semi-button-tertiary」（button.semi-button.semi-button-tertiary，[aria-label="close" i]）',
    '未发现公告弹窗',
  ];

  const UNVERIFIED_MESSAGE = '已登录但没有签到动作可确认，未执行签到。当前页没有签到控件，且没有余额入账或页面证据可确认「登录即签到」，无法确认本次签到';

  it('成功关闭公告 + 登录即签到未确认 → CHECKIN_UNVERIFIED，而不是 OBSCURED', () => {
    const steps = [
      '扩展版本 0.2.2-build-20261016-1734',
      '使用 Chrome/系统网络设置（扩展未覆盖代理）',
      '登录方式：form（账号级）；签到方式：none（站点配置）',
      '开始处理站点「AnyRouter」账号 fzy520',
      '未发现公告弹窗',
      '未发现足够的登录成功证据',
      '账密表单入口被 p 遮挡，尝试关闭遮挡的公告',
      ...CLOSE_SUCCESS_LINES,
      '已点击「使用 邮箱或用户名 登录」展开账密表单',
      '已填写用户名',
      '已填写密码',
      '已点击登录按钮',
      '登录页面反馈：登录成功！',
      '站点身份接口确认登录成功',
      '已读取额度快照（剩余 $1423.79，累计已用 $1022.28）',
      '当前页没有签到控件，且没有余额入账或页面证据可确认「登录即签到」，无法确认本次签到',
      '额度无变化，当前余额 $1423.79',
    ];
    const code = classifyFailure(UNVERIFIED_MESSAGE, steps);
    expect(code).toBe(DIAGNOSIS.CHECKIN_UNVERIFIED);
    // 这条断言就是这次修复的核心：公告早已关掉，不能再报「控件被弹窗挡住了」。
    expect(code).not.toBe(DIAGNOSIS.OBSCURED);
    expect(planRetry(code, 0).retry).toBe(false);
  });

  it.each(CLOSE_SUCCESS_LINES)('成功回执行不参与判定：%s', (line) => {
    expect(isSymptom(line), line).toBe(false);
  });

  it('「共用同一域名站点的流程」是环境说明，不参与失败判定', () => {
    expect(isSymptom('本站卡片还没学过签到流程，共用同一域名站点「主卡」上学到的流程')).toBe(false);
  });

  it('没有成功回执、只剩「未确认」的失败行时，仍然如实参与判定', () => {
    // 与上一条成对：只排除断言成功的回执，不能把「关不掉」也一起排除。
    expect(isSymptom('公告关闭按钮未能解除遮挡，未对归属不明的浮层继续按 Esc')).toBe(true);
    expect(isSymptom('已尝试的公告关闭按钮未生效，Esc 也未解除遮挡，后续操作仍被挡住')).toBe(true);
  });
});


describe('身份确认不了时不能被报成「站点弹出了验证码」', () => {
  /** CottonAPI 实测日志（节选）：Turnstile 早已自动通过，停机原因是身份。 */
  const COTTON_STEPS = [
    '扩展版本 0.2.2-build-20261022-1247',
    '登录方式：github（账号级）；签到方式：workflow（站点配置）',
    '使用 Chrome/系统网络设置（扩展未覆盖代理）',
    '开始处理站点「CottonAPI」账号 demo104',
    '未发现公告弹窗',
    '发现登录表单，需要重新登录',
    '验证控件布局已稳定（416×72，响应字段已挂载）',
    'Turnstile首次点击保护：再等待 9s，执行通用 10s 最低成熟策略',
    'Turnstile宿主已出现 10s，进入内部就绪检查',
    '第 1 次点击前已定位Turnstile控件 div',
    '第 1 次可信点击已发出：坐标 (274, 541)，目标区域 left=250 top=506 416×72，命中=Turnstile目标范围（内部验证帧已稳定）',
    '等待Turnstile验证完成中... (0s)',
    'Turnstile验证已自动完成（检测到当前控件的 token 或已验证状态）',
    'Turnstile已通过验证信号确认完成，继续执行',
    '已点击 OAuth 按钮: GitHub使用 GitHub 继续',
    'OAuth 授权完成，已跳回本站(/dashboard/overview)',
    '个人资料页只读到第三方句柄，不能据此判定 GitHub 凭据错误或自动切换账号',
    '身份页诊断：URL https://api.cottonapi.cloud/profile；来源 visible；userId 940；username demo-github',
  ];

  it('CottonAPI 形态：归到「无法确认当前登录的是这个账号」', () => {
    const message = '身份核验页仍未显示可核对的账号身份（资料页目前只显示第三方身份 demo-github，尚未显示站点账号 demo104）。已停止签到和奖励读取';
    expect(classifyFailure(message, COTTON_STEPS)).toBe(DIAGNOSIS.IDENTITY_UNCONFIRMED);
  });

  it.each([
    'Turnstile验证已自动完成（检测到当前控件的 token 或已验证状态）',
    'Turnstile已通过验证信号确认完成，继续执行',
    '第 1 次可信点击已发出：坐标 (274, 541)',
    '等待Turnstile验证完成中... (0s)',
  ])('已经自动通过的验证记录不参与判定：%s', (line) => {
    expect(isSymptom(line)).toBe(false);
  });

  it('真正没通过的验证仍然报「需要你在页面上完成一步」', () => {
    expect(classifyFailure('安全验证超时，请完成后重新签到', ['已重试 3 次仍未完成Turnstile验证，需要人工介入']))
      .toBe(DIAGNOSIS.MANUAL_REQUIRED);
  });

  it('「退出再登录」时退出没生效：归到无法切换会话，而不是「找不到控件」', () => {
    const message = '本站的退出操作没有真正结束会话（退出接口返回成功，但站点仍保持登录），无法完成「退出再登录」。'
      + '请在站点设置里补充退出按钮选择器（或退出前要先点开的头像菜单），或改用「登录即签到」。';
    const steps = ['开始第二次登录以完成签到', '站点退出后会话仍然有效（身份接口还能读到当前账号），退出没有生效'];
    expect(classifyFailure(message, steps)).toBe(DIAGNOSIS.SESSION_SWITCH_FAILED);
  });

  it('接口仍报有会话、但照常第二次登录后真找不到按钮：仍报找不到控件', () => {
    const steps = ['开始第二次登录以完成签到', '站点接口仍返回登录身份，但页面上已没有站内证据，照常进行第二次登录'];
    expect(classifyFailure('未找到 OAuth 按钮，无法完成第二次登录', steps)).toBe(DIAGNOSIS.SELECTOR_MISMATCH);
  });
});
