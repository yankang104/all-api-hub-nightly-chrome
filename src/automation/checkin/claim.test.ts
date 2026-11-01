import { describe, expect, it } from 'vitest';
import type { SiteConfig } from '@/types';
import { validateSiteConfig } from '@/lib/site/site-security';
import { CHECKIN_ACTION, NON_ACTION_WORDS } from '@/automation/checkin/checkin-vocab';

/**
 * claim 方式的纯逻辑测试。
 *
 * DOM 交互（点入口、等弹窗、setNativeValue 填值、判成功）不在这里测：
 * vitest 跑 node 环境、没有 jsdom，而这条路的风险全在真实 SPA 的时序上 ——
 * 用打桩 DOM 测出来的「通过」说明不了任何事。那部分交给 tests/ 下的
 * Playwright 脚本，跑真实浏览器 + 真实扩展。
 *
 * 这里锁住的是能脱离 DOM 判定的三件事：配置校验、字数门槛、词表命中。
 */

const claimSite = (checkin: Partial<SiteConfig['checkin']> = {}): SiteConfig => ({
  id: 'chaiai',
  name: 'chaiai',
  loginUrl: 'https://chaiai.example.com/login',
  loginMethod: 'form',
  selectors: { username: '#email', password: 'input[type="password"]', submit: '.btn-primary' },
  closeModalSelectors: [],
  checkin: {
    method: 'claim',
    claimEntrySelector: 'text=领取权益',
    claimInputSelector: '.claim-modal textarea',
    claimSubmitSelector: '.claim-modal button.primary',
    ...checkin,
  } as SiteConfig['checkin'],
});

describe('claim 站点配置校验', () => {
  it('三个选择器齐备时通过', () => {
    expect(validateSiteConfig(claimSite())).toEqual([]);
  });

  it('缺输入框选择器时报错', () => {
    const errors = validateSiteConfig(claimSite({ claimInputSelector: undefined }));
    expect(errors.join('\n')).toContain('输入框选择器');
  });

  it('缺领取入口选择器时报错', () => {
    const errors = validateSiteConfig(claimSite({ claimEntrySelector: undefined }));
    expect(errors.join('\n')).toContain('领取入口选择器');
  });

  it('缺提交按钮选择器时报错', () => {
    const errors = validateSiteConfig(claimSite({ claimSubmitSelector: undefined }));
    expect(errors.join('\n')).toContain('提交按钮选择器');
  });

  it('空白字符串不算填了选择器', () => {
    // trim 后为空的配置比缺字段更隐蔽：界面上看着像填了
    const errors = validateSiteConfig(claimSite({ claimInputSelector: '   ' }));
    expect(errors.join('\n')).toContain('输入框选择器');
  });

  it('领取页面必须同源 —— 提交动作带着登录 cookie', () => {
    const errors = validateSiteConfig(claimSite({ url: 'https://evil.example/claim' }));
    expect(errors.join('\n')).toContain('同源');
  });

  it('同站相对地址不算跨站', () => {
    expect(validateSiteConfig(claimSite({ url: '/console' }))).toEqual([]);
  });
});

describe('领取文本的字数门槛', () => {
  it('默认下限是 10 字', () => {
    // 9 字被拦、10 字放过，等于把默认值钉在 10
    expect(validateSiteConfig(claimSite({ claimText: '一二三四五六七八九' })).join('\n')).toContain('至少需要 10 字');
    expect(validateSiteConfig(claimSite({ claimText: '一二三四五六七八九十' }))).toEqual([]);
  });

  it('报错同时给出要求字数和实际字数', () => {
    // 只说「太短」用户无从下手，必须两个数都在
    const message = validateSiteConfig(claimSite({ claimText: '太短了', claimMinLength: 20 })).join('\n');
    expect(message).toContain('20');
    expect(message).toContain('3');
  });

  it('站点要求更高时按站点的下限判', () => {
    const text = '一二三四五六七八九十一二';
    expect(validateSiteConfig(claimSite({ claimText: text, claimMinLength: 30 })).join('\n')).toContain('至少需要 30 字');
    expect(validateSiteConfig(claimSite({ claimText: text, claimMinLength: 12 }))).toEqual([]);
  });

  it('没配 claimText 时不报字数错 —— 运行时用内置默认值', () => {
    expect(validateSiteConfig(claimSite({ claimText: undefined }))).toEqual([]);
  });

  it('前后空白不算字数', () => {
    // 站点也会 trim，这里跟着 trim 才不会「本地通过、提交被拒」
    expect(validateSiteConfig(claimSite({ claimText: '  短  ' })).join('\n')).toContain('至少需要 10 字');
  });
});

describe('领取按钮的词表命中', () => {
  it('「领取」系文案都算签到动作', () => {
    for (const text of ['领取', '领取权益', '立即领取', '确认领取']) {
      expect(CHECKIN_ACTION.test(text)).toBe(true);
      expect(NON_ACTION_WORDS.test(text)).toBe(false);
    }
  });

  it('「领取记录」「领取规则」不算动作 —— 点了只会跳走', () => {
    for (const text of ['领取记录', '领取规则', '领取明细']) {
      expect(NON_ACTION_WORDS.test(text)).toBe(true);
    }
  });
});
