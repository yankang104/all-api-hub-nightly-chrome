import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SiteConfig } from '@/types';
import {
  findAccountOnPage,
  readPageIdentity,
  readVisibleIdentity,
  readVisibleIdentityFromText,
  verifyIdentity,
} from '@/automation/login/identity';

const site: SiteConfig = {
  id: 'leilei-identity',
  name: '一梦五千年',
  loginUrl: 'https://fapi.leileihog.top/sign-in',
  loginMethod: 'form',
  selectors: { username: '#username', password: '#password', submit: 'button' },
  closeModalSelectors: [],
};

// 复现用户截图：邮箱是右侧中奖名单的第四项，不是右上角当前账号。
function winners(name = 'sx5731@qq.com') {
  return `<aside class="lottery-sidebar">
    <h2>所有中奖名单</h2>
    <ul>
      <li>梦旅人 +$1</li>
      <li>晚舟 +$2</li>
      <li>暮云 +$1</li>
      <li>${name} +$2</li>
    </ul>
  </aside>`;
}

function render(html: string) {
  document.body.innerHTML = html;
  // jsdom 不实现 innerText；夹具显式分行，保留页面的文本区块边界。
  Object.defineProperty(document.body, 'innerText', {
    configurable: true,
    get: () => document.body.textContent ?? '',
  });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal('location', new URL('https://fapi.leileihog.top/lottery'));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
});

afterEach(() => {
  document.body.innerHTML = '';
  Reflect.deleteProperty(document.body, 'innerText');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('可见身份只来自当前账号区域', () => {
  it('抽奖页的单个中奖邮箱也不能冒充当前身份', async () => {
    render(`<header><button aria-haspopup="menu">Q</button></header>
      <main class="lottery-page">浮梦引光 今日已抽 ${winners()}</main>`);

    expect(readVisibleIdentity()).toBeNull();
    expect(await readPageIdentity(site)).toBeNull();
    expect(verifyIdentity(readVisibleIdentity(), 'qq3306').match).toBe('unknown');
  });

  it('名单中恰好出现本账号，也不能据此确认浏览器登录的是本账号', () => {
    render(winners('qq3306'));
    expect(findAccountOnPage('qq3306')).toBeNull();
  });

  it('名单列名含邮箱、用户名、用户 ID 时仍排除整个公共区块', () => {
    render(winners('邮箱 sx5731@qq.com 用户 ID 5544 @another-user'));
    expect(readVisibleIdentity()).toBeNull();
    expect(findAccountOnPage('sx5731@qq.com')).toBeNull();
  });

  it('后台纯文本读取同样不能把中奖名单当身份', () => {
    const text = '所有中奖名单\n邮箱 sx5731@qq.com\n用户 ID 5544\n@qq3306';
    expect(readVisibleIdentityFromText(text)).toBeNull();
    expect(findAccountOnPage('qq3306', text)).toBeNull();
  });

  it('无账号标签的正文邮箱、提及的 @句柄和联系邮箱不算当前身份', () => {
    expect(readVisibleIdentityFromText('sx5731@qq.com')).toBeNull();
    expect(readVisibleIdentityFromText('感谢 @other-user 的支持')).toBeNull();
    expect(readVisibleIdentityFromText('客服邮箱 support@example.com')).toBeNull();
  });

  it('公告中的账号信息不算当前账号', () => {
    const text = '系统公告\n测试账号\n邮箱 example@example.com\n用户 ID 123';
    expect(readVisibleIdentityFromText(text)).toBeNull();
    expect(findAccountOnPage('example@example.com', text)).toBeNull();
  });

  it('保留当前账号明确标注的邮箱', () => {
    render('<section>当前账号：alice@example.com</section>');
    expect(readVisibleIdentity()).toMatchObject({ email: 'alice@example.com', source: 'visible' });
    expect(findAccountOnPage('alice@example.com')).toMatchObject({ masked: false });
  });

  it('个人资料的 ID、GitHub 句柄和站点账号旁证仍可一起读取', () => {
    render(`${winners()}
      <section>
        <h2>个人资料</h2>
        <p>demo-user 用户 ID 436</p>
        <p>@demo-github · SVIP</p>
      </section>`);
    expect(readVisibleIdentity()).toMatchObject({ userId: '436', username: 'demo-github' });
    expect(readVisibleIdentity()?.email).toBeUndefined();
    expect(findAccountOnPage('demo-user')).toMatchObject({ matched: 'demo-user' });
  });

  it('标题栏账号菜单按钮可以显示无标签的邮箱或账号名', () => {
    render(`<header><button aria-haspopup="menu">alice@example.com</button></header>
      ${winners()}`);
    expect(readVisibleIdentity()?.email).toBe('alice@example.com');

    render(`<header><button aria-haspopup="menu">qq3306</button></header>${winners()}`);
    expect(findAccountOnPage('qq3306')).toMatchObject({ matched: 'qq3306' });
  });

  it('挂载在正文末尾的当前用户菜单优先于中奖名单', () => {
    render(`${winners()}
      <div role="menu">
        <div>alice@example.com</div>
        <button role="menuitem">退出登录</button>
      </div>`);
    expect(readVisibleIdentity()?.email).toBe('alice@example.com');
  });

  it('隐藏的旧用户菜单和公共列表里的弹出按钮不能提供身份', () => {
    render(`<div role="menu" hidden>
        <div>old@example.com</div><button role="menuitem">退出登录</button>
      </div>
      ${winners('<button aria-haspopup="menu">sx5731@qq.com</button>')}`);
    expect(readVisibleIdentity()).toBeNull();
  });

  it('多个不同邮箱或句柄同时出现在账号区时，不随手取第一个', () => {
    expect(readVisibleIdentityFromText('邮箱 alice@example.com bob@example.com')?.email).toBeUndefined();
    expect(readVisibleIdentityFromText('用户名 @alice @bobby')?.username).toBeUndefined();
  });

  it('真实账号菜单显示其他邮箱时仍然判不匹配', () => {
    render(`<header><button aria-haspopup="menu">other@example.com</button></header>
      ${winners('qq3306')}`);
    const identity = readVisibleIdentity();
    expect(identity?.email).toBe('other@example.com');
    expect(verifyIdentity(identity, 'qq3306').match).toBe('mismatch');
  });

  it('明确标注的其他登录用户名也必须阻断，不能被当作身份未知', () => {
    render('<section>当前账号：another-user</section>');
    const identity = readVisibleIdentity();
    expect(identity?.username).toBe('another-user');
    expect(verifyIdentity(identity, 'qq3306').match).toBe('mismatch');
  });

  it('明确的站点用户名优先于资料中另列的第三方句柄', () => {
    expect(readVisibleIdentityFromText('用户名 demo-user\n@demo-github · SVIP'))
      .toMatchObject({ username: 'demo-user' });
  });

  it('服务端返回其他账号时不能被公共名单或本轮目标名覆盖', async () => {
    render(winners('qq3306'));
    vi.mocked(fetch).mockImplementation(async () => new Response(
      JSON.stringify({ data: { id: 777, username: 'another-user' } }),
      { headers: { 'content-type': 'application/json' } },
    ));
    const identity = await readPageIdentity(site);
    expect(identity).toMatchObject({ userId: '777', username: 'another-user', source: 'api' });
    expect(verifyIdentity(identity, 'qq3306', '3306', {
      pageAccountMatch: findAccountOnPage('qq3306')?.matched,
    }).match).toBe('mismatch');
  });
});
