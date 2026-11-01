import { describe, expect, it } from 'vitest';
import { DIAGNOSIS, DIAGNOSIS_TABLE } from '@/lib/checkin/diagnosis';
import { classifyFailure, diagnoseFailure } from '@/automation/shared/diagnostics';

/**
 * 诊断分类矩阵。
 *
 * 用户抱怨「学不到、跑不通」时，界面唯一能做的补救就是给出正确的下一步。
 * 所以每一类都要同时锁两件事：
 *   1) 真实失败文案被归到正确的码（不然给的就是错的补救方向）；
 *   2) 这个码的下一步提示包含可照做的关键词（不然分类对了也白搭）。
 *
 * 关键词刻意选具体的操作对象（端口号、按钮名、页面名），不是「重试即可」
 * 这类没有信息量的话 —— 笼统的提示就是这次要修的问题本身。
 */
const CASES: ReadonlyArray<{
  label: string;
  code: string;
  message: string;
  steps?: string[];
  /** nextActions 拼起来必须包含的关键词 */
  expects: string[];
}> = [
  {
    label: '找不到控件（选择器失效 / 页面改版）',
    code: DIAGNOSIS.SELECTOR_MISMATCH,
    message: '签到页未找到明确按钮或已签到状态',
    steps: ['页面可点元素：登录 / 控制台 / 公告'],
    expects: ['学习本站流程', '重新演示'],
  },
  {
    label: '命中了错误的元素（指纹失配）',
    code: DIAGNOSIS.ELEMENT_MISMATCH,
    message: '工作流点击选择器命中了错误的元素: #claim',
    steps: ['工作流指纹失配: #claim 命中的元素不符（aria 期望 "签到" 实际 ""）'],
    expects: ['指纹', '重新演示'],
  },
  {
    label: '超时（页面没加载出来）',
    code: DIAGNOSIS.PAGE_TIMEOUT,
    message: '连接站点超时',
    expects: ['直接打开', '代理'],
  },
  {
    label: '被遮挡（公告弹窗没关掉）',
    code: DIAGNOSIS.OBSCURED,
    message: '签到按钮被div.ant-modal-mask遮挡，可能有未关闭的公告弹窗',
    expects: ['公告', '关闭弹窗选择器'],
  },
  {
    label: '未登录 / 登录态失效',
    code: DIAGNOSIS.AUTH_EXPIRED,
    message: '登录态无效（HTTP 401）',
    expects: ['重新', '密码'],
  },
  {
    label: '需要人工验证',
    code: DIAGNOSIS.MANUAL_REQUIRED,
    message: '检测到Turnstile交互式验证，等待你在当前标签页完成',
    expects: ['标签页', '验证'],
  },
  {
    label: '本地代理端口没人监听',
    code: DIAGNOSIS.PROXY_UNREACHABLE,
    message: '扩展代理连接失败：本机 127.0.0.1:7897 上没有程序在监听',
    expects: ['Clash Verge', '端口'],
  },
  {
    label: '访问被拒（403）',
    code: DIAGNOSIS.ACCESS_DENIED,
    message: '站点返回 403 Forbidden',
    expects: ['地区', '节点'],
  },
  {
    label: '出口不通（通用网络失败）',
    code: DIAGNOSIS.NETWORK_FAILURE,
    message: '签到请求失败: ERR_PROXY_CONNECTION_FAILED',
    steps: ['扩展代理连接失败，请检查代理协议、主机和端口'],
    expects: ['代理', '节点'],
  },
  {
    label: '站点不可用（5xx / 限流）',
    code: DIAGNOSIS.SITE_UNAVAILABLE,
    message: '站点源服务器返回 502（Cloudflare 显示 Host Error）',
    expects: ['稍后重试'],
  },
  {
    label: '站点业务规则拒绝',
    code: DIAGNOSIS.SITE_REJECTED,
    message: '签到请求被拒绝：领取理由与历史重复',
    expects: ['站点', '原因'],
  },
  {
    label: '登录即签到没拿到到账证据（拒绝记绿）',
    code: DIAGNOSIS.CHECKIN_UNVERIFIED,
    message: '已登录但没有签到动作可确认，未执行签到。当前页没有签到控件，且没有余额入账或页面证据可确认「登录即签到」，无法确认本次签到',
    steps: [
      '公告关闭按钮已收到浏览器可信点击：「今日关闭」（div.semi-modal-content.undefined，文字识别）',
      '已确认对应公告消失或目标遮挡解除：「今日关闭」（div.semi-modal-content.undefined，文字识别）',
      '遮挡已清除，继续点击',
    ],
    expects: ['额度', '退出再登录', '学习本站流程'],
  },
  {
    label: '多账号切换失败',
    code: DIAGNOSIS.SESSION_SWITCH_FAILED,
    message: '无法清除当前站点的浏览器 Cookie，为避免给错账号签到已停止',
    expects: ['Cookie', '账号'],
  },
  {
    label: '没有签到入口',
    code: DIAGNOSIS.NO_CHECKIN_ENTRY,
    message: '未自动发现同源签到入口',
    expects: ['登录即签到', '签到页'],
  },
  {
    label: '学习流程配置不完整',
    code: DIAGNOSIS.WORKFLOW_CONFIG,
    message: '学习签到路线缺少身份核验页',
    expects: ['个人资料页', '学习本站流程'],
  },
  {
    label: '当天已签到（不是失败）',
    code: DIAGNOSIS.ALREADY_DONE,
    message: '站点台账显示今日已签到',
    expects: ['今天已经签到', '无需'],
  },
  {
    label: '控件被禁用（状态没拉回来）',
    code: DIAGNOSIS.CONTROL_DISABLED,
    message: '签到按钮已禁用，但没有明确的已签到标志',
    expects: ['今日已签到', '再执行'],
  },
  {
    label: '归不了类',
    code: DIAGNOSIS.UNKNOWN,
    message: 'something went wrong',
    expects: ['展开账号详情'],
  },
];

describe('失败诊断矩阵', () => {
  it.each(CASES)('$label → $code', ({ code, message, steps, expects }) => {
    expect(classifyFailure(message, steps ?? [])).toBe(code);

    const diagnosis = diagnoseFailure(message, steps ?? []);
    expect(diagnosis.code).toBe(code);
    // 结构必须是三件套，UI 才能渲染成标题 + 说明 + 下一步
    expect(diagnosis.title.trim().length).toBeGreaterThan(0);
    expect(diagnosis.detail.trim().length).toBeGreaterThan(0);
    expect(diagnosis.nextActions.length).toBeGreaterThan(0);
    expect(diagnosis.message).toBe(message);

    const actions = diagnosis.nextActions.join('\n');
    for (const keyword of expects) {
      expect(actions, `${code} 的下一步应包含「${keyword}」`).toContain(keyword);
    }
  });

  it('每一类都在码表里有结构化条目，没有半成品', () => {
    for (const code of Object.values(DIAGNOSIS)) {
      const entry = DIAGNOSIS_TABLE[code];
      expect(entry, code).toBeDefined();
      expect(entry.title.trim().length, code).toBeGreaterThan(0);
      expect(entry.detail.trim().length, code).toBeGreaterThan(0);
      expect(entry.nextActions.length, code).toBeGreaterThan(0);
      for (const action of entry.nextActions) {
        // 「稍后重试」「重新执行」这类空话不算下一步：每一条都要有具体的操作对象,
        // 至少 8 个字才能承载「去哪 / 做什么」。
        expect(action.trim().length, `${code}: ${action}`).toBeGreaterThanOrEqual(8);
      }
    }
  });

  it('已签到不是失败：明确写着已签到的证据绝不能判成准备操作的选择器问题', () => {
    for (const message of [
      '站点台账显示今日已签到',
      '页面显示今日已签到',
      '签到按钮已变为今日已签到',
      '接口提示今日已签到',
    ]) {
      expect(classifyFailure(message), message).toBe(DIAGNOSIS.ALREADY_DONE);
    }
  });

  it('否定句里的「已签到」不算已签到，否则用户会带着没签的状态被放行', () => {
    // 这两句是真实失败文案：说的是「没有已签到标志」，
    // 一旦被判成 ALREADY_DONE，账号会被误标成今日完成。
    expect(classifyFailure('签到页未找到明确按钮或已签到状态')).toBe(DIAGNOSIS.SELECTOR_MISMATCH);
    expect(classifyFailure('签到按钮已禁用，但没有明确的已签到标志')).toBe(DIAGNOSIS.CONTROL_DISABLED);
  });

  it('指纹失配优先于普通选择器问题（两者的补救动作不同）', () => {
    expect(classifyFailure('工作流找不到可点击元素: #claim', [
      '工作流指纹失配: #claim 命中的元素不符（text 期望 "签到" 实际 "每日签到记录"）',
    ])).toBe(DIAGNOSIS.ELEMENT_MISMATCH);
  });

  it('本地端口没人监听优先于通用网络失败（下一步是启动内核，不是换节点）', () => {
    expect(classifyFailure('扩展代理连接失败', [
      '本机 127.0.0.1:7897 上没有程序在监听 —— 内核（Clash Verge / mihomo 等）没启动',
    ])).toBe(DIAGNOSIS.PROXY_UNREACHABLE);
  });

  it('403 判成访问被拒，而不是登录态失效或业务拒绝', () => {
    expect(classifyFailure('站点返回 HTTP 403 Forbidden')).toBe(DIAGNOSIS.ACCESS_DENIED);
    expect(classifyFailure('不支持当前地区访问')).toBe(DIAGNOSIS.ACCESS_DENIED);
    // 接口对未认证会话返回 403 时仍按登录态处理 —— 那时确实该重新登录
    expect(classifyFailure('登录态无效（HTTP 403）')).toBe(DIAGNOSIS.AUTH_EXPIRED);
  });

  it('遮挡优先于选择器与网络（日志里常同时出现这几个词）', () => {
    expect(classifyFailure('签到按钮被div.ant-modal-mask遮挡，可能有未关闭的公告弹窗')).toBe(DIAGNOSIS.OBSCURED);
  });
});

