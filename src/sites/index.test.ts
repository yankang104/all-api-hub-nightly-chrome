import { describe, expect, it } from 'vitest';
import { BUILTIN_SITES, matchTemplateByName, mergeBuiltinSite, normalizedLoginUrl } from './index';

describe('站点模板与内置站点策略', () => {
  it('内置用户要求的站点，首次加载直接显示但不含任何账号', () => {
    expect(BUILTIN_SITES.map((site) => site.id)).toEqual([
      'builtin-anyrouter',
      'builtin-futurehub',
      'builtin-kid1412',
    ]);
    expect(BUILTIN_SITES.every((site) => site.builtin)).toBe(true);
  });

  it('Agent Router 仍可按地址自动识别为退出重登 + GitHub OAuth 配置', () => {
    const template = matchTemplateByName('https://agentrouter.org/login');
    expect(template?.id).toBe('agentrouter');
    expect(template?.preset).toMatchObject({
      pointerMode: 'trusted',
      loginMethod: 'github',
      oauthButtonSelector: 'text=GitHub',
      checkin: {
        method: 'relogin',
        logoutApiUrl: '/api/user/logout',
        logoutSelector: 'text=退出',
        logoutStorageKeys: ['user', 'token', 'access_token'],
      },
      adapter: { family: 'new-api', quotaPerUnit: 500_000 },
    });
    expect(template?.preset.successIndicator).toContain('text=账户数据');
    expect(normalizedLoginUrl('https://agentrouter.org/', template ?? null))
      .toBe('https://agentrouter.org/login');
  });

  it('一梦五千年的登录成功标志覆盖新版抽奖页（不再只认 /keys、/wallet）', () => {
    const template = matchTemplateByName('https://fapi.leileihog.top/sign-in');
    expect(template?.id).toBe('leilei');
    expect(template?.preset.successIndicator).toContain('text=浮梦引光');
    expect(template?.preset.successIndicator).toContain('a[href="/lottery"]');
  });
  it('按站点名和官方备用域名都能命中同一模板', () => {
    // Agent Router 在公告中公布 ps.air-outer.com 为官方备用域名；两域名必须走
    // 同一退出重登 + GitHub 登录配置，不能落到普通 new-api 模板。
    expect(matchTemplateByName('Agent Router')?.id).toBe('agentrouter');
    expect(matchTemplateByName('https://ps.air-outer.com/login')?.id).toBe('agentrouter');
  });

  it('1412 与 ChatAI 保留为导入时自动填充的模板，不自动显示卡片', () => {
    const kid = matchTemplateByName('https://napi.kid1412.qzz.io/sign-in');
    expect(kid?.id).toBe('kid1412');
    // github 而非 oauth：跳到 github.com 登录页时会自动填账号里保存的 GitHub 账密
    expect(kid?.preset).toMatchObject({ loginMethod: 'github', oauthButtonSelector: 'text=GitHub' });
    // 该站输入框 id 由 React 运行时生成，只能按 name 选，不能写死动态 id
    expect(kid?.preset.selectors).toMatchObject({
      username: 'input[name="username"]',
      password: 'input[name="password"]',
    });

    const chatAi = matchTemplateByName('https://new.sharedchat.cc/list/#/login');
    expect(chatAi?.id).toBe('sharedchat');
    expect(chatAi?.preset.checkin).toMatchObject({ method: 'claim', claimUniqueText: true });
  });

  it("1412's API 内置卡片使用 GitHub 授权与稳定的 name 选择器", () => {
    const site = BUILTIN_SITES.find((item) => item.id === 'builtin-kid1412');
    expect(site).toMatchObject({
      name: "1412's API",
      loginUrl: 'https://napi.kid1412.qzz.io/sign-in',
      loginMethod: 'github',
      oauthButtonSelector: 'text=GitHub',
      builtin: true,
    });
    expect(site?.selectors).toMatchObject({
      username: 'input[name="username"]',
      password: 'input[name="password"]',
    });
    /**
     * 实测 /profile 页「每日签到」卡片：动作按钮是「立即签到」，已签到变为「已签到」。
     *
     * 「立即签到」必须排在前面 —— 卡片标题「每日签到」本身是可折叠 button，
     * 两者都含「签到」且都是 4 个字，只写 `text=签到` 会点到折叠开关上。
     */
    expect(site?.checkin).toMatchObject({
      method: 'button',
      url: '/profile',
      buttonSelector: 'button >> text=立即签到, button >> text=签到',
      alreadySelector: 'button >> text=已签到',
    });
  });

  it('Future Hub 使用明确的每日签到点击流程，而非通用自动识别', () => {
    const template = matchTemplateByName('https://api.futureppo.top/login');
    expect(template?.id).toBe('futurehub');
    expect(template?.preset.checkin).toMatchObject({
      method: 'button',
      url: '/console/personal',
      buttonSelector: 'button >> text=立即签到',
      alreadySelector: 'button >> text=今日已签到',
      alreadyText: ['今日已签到'],
    });
    expect(normalizedLoginUrl('https://api.futureppo.top/console/personal', template ?? null)).toBe(
      'https://api.futureppo.top/console/personal',
    );
  });

  it('Future Hub 的旧 auto 覆盖记录升级为明确的按钮签到配置', () => {
    const builtin = BUILTIN_SITES.find((site) => site.id === 'builtin-futurehub')!;
    const merged = mergeBuiltinSite(builtin, {
      ...builtin,
      checkin: { method: 'auto', url: '/console/personal' },
    });

    expect(merged.checkin).toMatchObject({
      method: 'button',
      buttonSelector: 'button >> text=立即签到',
      alreadySelector: 'button >> text=今日已签到',
    });
  });

  it('用户自定义的 Future Hub 签到覆盖记录仍保持优先', () => {
    const builtin = BUILTIN_SITES.find((site) => site.id === 'builtin-futurehub')!;
    const merged = mergeBuiltinSite(builtin, {
      ...builtin,
      checkin: { method: 'button', url: '/custom-checkin', buttonSelector: '#custom-checkin' },
    });

    expect(merged.checkin).toMatchObject({ method: 'button', url: '/custom-checkin', buttonSelector: '#custom-checkin' });
  });

  /**
   * AnyRouter 登录即签到：实测控制台上没有任何签到控件（可点元素只有导航和
   * 头像）。用通用 new-api 的 auto 会跳去 /console/personal 等满 12 秒，
   * 然后把一次成功的签到判成「签到页未找到明确按钮或已签到状态」。
   */
  describe('AnyRouter 登录即签到', () => {
    it('用独立模板而不是通用 new-api 白标配置', () => {
      const template = matchTemplateByName('https://anyrouter.top/login');
      expect(template?.id).toBe('anyrouter');
      expect(template?.preset.checkin).toEqual({ method: 'none' });
      // 站点名也要能命中，用户手输「AnyRouter」时不该落到通用模板
      expect(matchTemplateByName('AnyRouter')?.id).toBe('anyrouter');
    });

    it('不配签到页地址 —— 填了 none 方式仍会先跳过去白跑一趟', () => {
      const template = matchTemplateByName('https://anyrouter.top/login');
      expect(template?.preset.checkin).not.toHaveProperty('url');
      // 空 checkinPath 关掉 new-api 家族默认的 /console/personal 兜底
      expect(template?.preset.adapter?.checkinPath).toBe('');
      // 余额读取与美元换算仍走 new-api 这一族
      expect(template?.preset.adapter).toMatchObject({ family: 'new-api', quotaPerUnit: 500_000 });
    });

    it('落地页归一到登录入口', () => {
      const template = matchTemplateByName('https://anyrouter.top/console/personal');
      expect(normalizedLoginUrl('https://anyrouter.top/console/personal', template ?? null))
        .toBe('https://anyrouter.top/login');
    });

    it('内置卡片跟着模板走登录即签到', () => {
      const site = BUILTIN_SITES.find((item) => item.id === 'builtin-anyrouter');
      expect(site?.checkin).toEqual({ method: 'none' });
      expect(site?.adapter?.checkinPath).toBe('');
    });

    it('旧的 auto + /console/personal 覆盖记录整块换回内置默认', () => {
      const builtin = BUILTIN_SITES.find((site) => site.id === 'builtin-anyrouter')!;
      const merged = mergeBuiltinSite(builtin, {
        ...builtin,
        checkin: { method: 'auto', url: '/console/personal' },
      });

      expect(merged.checkin).toEqual({ method: 'none' });
      // 逐字段合并会把旧 url 留下来，那就还会跳转
      expect(merged.checkin).not.toHaveProperty('url');
    });

    it('用户自定义的 AnyRouter 签到配置仍保持优先', () => {
      const builtin = BUILTIN_SITES.find((site) => site.id === 'builtin-anyrouter')!;
      const merged = mergeBuiltinSite(builtin, {
        ...builtin,
        checkin: { method: 'relogin', logoutApiUrl: '/api/user/logout' },
      });

      expect(merged.checkin).toMatchObject({ method: 'relogin', logoutApiUrl: '/api/user/logout' });
    });
  });

  describe('登仙公益站真实签到页', () => {
    it('登录页与站点名都命中专用 Sub2API 模板', () => {
      const template = matchTemplateByName('https://api.denxio.top/checkin');
      expect(template?.id).toBe('denxio');
      expect(matchTemplateByName('登仙公益站')?.id).toBe('denxio');
      expect(normalizedLoginUrl('https://api.denxio.top/checkin', template ?? null))
        .toBe('https://api.denxio.top/login');
    });

    it('登录后进入 /checkin，并保留 Sub2API 余额协议', () => {
      const template = matchTemplateByName('https://api.denxio.top/login');
      expect(template?.preset).toMatchObject({
        loginMethod: 'form',
        checkin: {
          method: 'auto',
          url: '/checkin',
          buttonSelector: 'button >> text=立即签到',
          alreadySelector: 'button >> text=今日已签到, button >> text=今天已签到, button >> text=已签到',
          claimConfirmSelector: 'button >> text=领取奖励',
          successText: ['签到成功', '领取成功', '领取完成'],
          alreadyText: ['今日已签到', '今天已签到', '已签到'],
        },
        adapter: {
          family: 'sub2api',
          checkinPath: '/checkin',
          checkin: { pathPatterns: ['/checkin*'] },
          quotaPerUnit: 1,
        },
      });
      // 用户已有卡片由存储迁移修复；模板不应再额外生成一张重复的内置卡片。
      expect(BUILTIN_SITES.some((site) => site.id === 'builtin-denxio')).toBe(false);
    });
  });

  describe('Linux.SB 登录页与固定签到入口', () => {
    it('只按精确 linux.sb 主机名命中专用模板，并把登录地址归一到 /login', () => {
      const template = matchTemplateByName('https://linux.sb/some/landing?page=1#login');
      expect(template?.id).toBe('linux-sb');
      expect(normalizedLoginUrl('https://linux.sb/some/landing?page=1#login', template ?? null))
        .toBe('https://linux.sb/login');

      expect(matchTemplateByName('https://www.linux.sb/')).toBeNull();
      expect(matchTemplateByName('https://notlinux.sb/')).toBeNull();
    });

    it('使用可信表单登录，并固定进入 /daily_checkin 点击立即签到', () => {
      const template = matchTemplateByName('https://linux.sb/');
      expect(template?.preset).toMatchObject({
        pointerMode: 'trusted',
        loginMethod: 'form',
        selectors: {
          username: expect.stringContaining('input[name="username"]'),
          password: expect.stringContaining('input[type="password"]'),
          submit: expect.stringContaining('text=登录'),
        },
        checkin: {
          method: 'button',
          url: '/daily_checkin',
          buttonSelector: expect.stringContaining('text=立即签到'),
          alreadySelector: expect.stringContaining('.daily-checkin-done'),
          successText: ['签到成功', '签到完成', '今天已签到', '今日已签到', '已完成'],
          alreadyText: ['今天已签到', '今日已签到', '已完成'],
        },
        adapter: {
          siteType: 'unknown',
          family: 'unsupported',
          checkinPath: '/daily_checkin',
          checkin: { pathPatterns: ['/daily_checkin*'], titleWords: ['每日签到'] },
        },
      });
      expect(template?.preset.checkin?.buttonSelector)
        .toContain('.daily-checkin-page-action button:not([disabled])');
      expect(template?.preset.checkin?.alreadySelector)
        .toContain('text=今天已签到');
    });

    it('保持为识别模板，不额外生成重复的内置站点卡片', () => {
      expect(BUILTIN_SITES.some((site) => site.id === 'builtin-linux-sb')).toBe(false);
      expect(BUILTIN_SITES.some((site) => new URL(site.loginUrl).hostname === 'linux.sb')).toBe(false);
    });
  });

  it('林夕固定使用 Sub2API 的 /check-in 按钮签到策略', () => {
    const template = matchTemplateByName('https://k40.shengqainbang.cn/check-in');
    expect(template?.id).toBe('linxi');
    expect(matchTemplateByName('林夕')?.id).toBe('linxi');
    expect(normalizedLoginUrl('https://k40.shengqainbang.cn/check-in', template ?? null))
      .toBe('https://k40.shengqainbang.cn/login');
    expect(template?.preset).toMatchObject({
      loginMethod: 'form',
      tokenConfig: {
        storageKey: 'auth_token',
        identityEndpoint: '/api/v1/auth/me',
      },
      checkin: {
        method: 'button',
        url: '/check-in',
        buttonSelector: 'button >> text=立即签到, button >> text=Check in',
        alreadySelector: 'button >> text=今日已签到, button >> text=Already checked in today',
        successText: ['签到成功', 'Checked in — got'],
        alreadyText: ['今日已签到', '今天已经签过了', 'Already checked in today'],
      },
      adapter: {
        siteType: 'sub2api',
        family: 'sub2api',
        checkinPath: '/check-in',
        quotaPerUnit: 1,
      },
    });
  });

  it('百倍精确复用林夕的 /check-in 按钮流程，不再保存成登录即签到', () => {
    const template = matchTemplateByName('https://sub.100xlabs.space/check-in');
    expect(template?.id).toBe('baibei');
    expect(normalizedLoginUrl('https://sub.100xlabs.space/check-in', template ?? null))
      .toBe('https://sub.100xlabs.space/login');
    expect(template?.preset).toMatchObject({
      loginMethod: 'form',
      checkin: {
        method: 'button',
        url: '/check-in',
        buttonSelector: 'button >> text=立即签到, button >> text=Check in',
        alreadySelector: 'button >> text=今日已签到, button >> text=Already checked in today',
      },
      adapter: { family: 'sub2api', checkinPath: '/check-in', quotaPerUnit: 1 },
    });
  });

  it('gy.leyanshi.me 属于新版 new-api，不再误识别为林夕', () => {
    const template = matchTemplateByName('https://gy.leyanshi.me/profile');
    expect(template?.id).toBe('new-api-next');
    expect(normalizedLoginUrl('https://gy.leyanshi.me/profile', template ?? null))
      .toBe('https://gy.leyanshi.me/sign-in');
    expect(template?.preset.checkin).toMatchObject({ method: 'button', url: '/profile' });
  });

  it('VSLLM 使用普通按钮签到并归一到登录页', () => {
    const template = matchTemplateByName('https://vsllm.com/console/topup');
    expect(template?.id).toBe('vsllm');
    expect(normalizedLoginUrl('https://vsllm.com/console/topup', template ?? null))
      .toBe('https://vsllm.com/login');
    // 折叠面板由通用扫描展开，签到本身是普通按钮；不再需要专用执行器。
    expect(template?.preset.checkin).toMatchObject({
      method: 'button',
      url: '/console/personal',
    });
    expect(template?.preset.checkin?.buttonSelector).toContain('立即签到');
    expect(template?.preset.pointerMode).toBe('trusted');
  });

  it('Hvoy 使用账密登录、首页签到与两次点击后滑块流程', () => {
    const url = 'https://www.hvoy.ai/';
    const template = matchTemplateByName(url);
    expect(template?.id).toBe('hvoy');
    expect(normalizedLoginUrl(url, template ?? null)).toBe('https://www.hvoy.ai/');
    expect(matchTemplateByName('https://api.hvoy.ai/')).toBeNull();
    expect(template?.preset).toMatchObject({
      pointerMode: 'trusted',
      loginMethod: 'form',
      selectors: {
        username: expect.stringContaining('input[type="email"]'),
        password: expect.stringContaining('input[type="password"]'),
        submit: expect.stringContaining('text=登录'),
      },
      preLoginClickSelector: expect.stringContaining('header a[href="/login"]'),
      checkin: {
        method: 'button',
        url: '/',
        buttonSelector: 'button >> text=每日签到, a >> text=每日签到',
        successText: ['签到成功', '恭喜获取', '恭喜获得'],
      },
      adapter: {
        siteType: 'unknown',
        family: 'unsupported',
        checkinPath: '/',
        quotaPerUnit: 1,
      },
    });
  });

  /**
   * 新版界面没有 /login 这条路由（实测返回站点 404 页，0 个输入框），
   * 归一错了自动登录第一步就找不到用户名框 —— 这是「卡皮巴拉没实现自动签到」
   * 的根因，所以必须锁住。
   */
  it('TaBiAI 使用头像菜单入口的专用模板', () => {
    const template = matchTemplateByName('https://tabitoken.com/wallet');
    expect(template?.id).toBe('tabiai');
    expect(normalizedLoginUrl('https://tabitoken.com/wallet', template ?? null))
      .toBe('https://tabitoken.com/sign-in');
    expect(template?.preset.checkin).toMatchObject({
      method: 'button',
      url: '/profile',
      entry: {
        readySelector: expect.stringContaining('立即签到'),
        steps: expect.arrayContaining([
          expect.objectContaining({ selector: expect.stringContaining('aria-haspopup') }),
          expect.objectContaining({ selector: expect.stringContaining('个人资料'), mayNavigate: true }),
        ]),
      },
    });
  });

  it('其它新版 new-api 落地页归一到 /sign-in，且不继承 TaBiAI 头像入口', () => {
    for (const url of [
      'https://kapibala.asia/dashboard/overview',
      'https://nova.vcrauo.com/keys',
      'https://api.gemai.cc/keys',
      'https://seekai.cc/profile',
    ]) {
      const template = matchTemplateByName(url);
      expect(template?.id).toBe('new-api-next');
      expect(normalizedLoginUrl(url, template ?? null)).toMatch(/\/sign-in$/);
      expect(template?.preset.checkin?.url).toBe('/profile');
      expect(template?.preset.checkin?.method).toBe('button');
      expect(template?.preset.checkin?.entry).toBeUndefined();
    }
  });

  it('MonkeyCode 使用独立模板，不能误判为 new-api', () => {
    const template = matchTemplateByName('https://monkeycode-ai.com/console/tasks');
    expect(template?.id).toBe('monkeycode');
    expect(normalizedLoginUrl('https://monkeycode-ai.com/console/tasks', template ?? null)).toBe('https://monkeycode-ai.com/login');
  });
});
