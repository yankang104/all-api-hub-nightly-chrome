import { describe, expect, it, vi } from 'vitest';
import { ADAPTER_FAMILIES, SITE_TYPES, type SiteConfig } from '@/types';
import { isLearnedLoginAsCheckin, usesLearnedCheckin } from '@/lib/checkin/learned-checkin';
import { BUILTIN_SITES, mergeBuiltinSite } from '@/sites';
import { migrateLegacySiteDefault } from '@/data/app-repository';
import { tryHeadlessCheckin, type HeadlessDeps } from '@/background/checkin/headless-checkin';
import { verifyLearnedLoginAsCheckinStored } from '@/automation/learning/learning';

/**
 * 学到的「登录即签到」必须一路保留到运行时：
 * 保存 → 内置合并 → 旧模板迁移 → API 直连 都不能把它换回旧签到流程。
 */
const learnedNone = (extra: Partial<NonNullable<SiteConfig['checkin']>> = {}): NonNullable<SiteConfig['checkin']> => ({
  method: 'none',
  learnedLoginAsCheckin: true,
  ...extra,
});

function userSite(loginUrl: string, checkin: SiteConfig['checkin']): SiteConfig {
  return {
    id: `user-${new URL(loginUrl).hostname}`,
    name: 'learned',
    loginUrl,
    loginMethod: 'form',
    selectors: { username: '#email', password: '#password', submit: 'button[type="submit"]' },
    closeModalSelectors: [],
    checkin,
    adapter: { family: ADAPTER_FAMILIES.NEW_API, checkinPath: '/console/personal', quotaPerUnit: 500_000 },
  };
}

describe('学到的登录即签到标记', () => {
  it('只在 method 仍为 none 时生效', () => {
    expect(isLearnedLoginAsCheckin({ checkin: learnedNone() })).toBe(true);
    expect(isLearnedLoginAsCheckin({ checkin: { method: 'none' } })).toBe(false);
    expect(isLearnedLoginAsCheckin({ checkin: { method: 'auto', learnedLoginAsCheckin: true } })).toBe(false);
    expect(isLearnedLoginAsCheckin({})).toBe(false);
  });

  it('学到的流程（回放或登录即签到）都算学习拥有签到', () => {
    expect(usesLearnedCheckin({ checkin: { method: 'workflow' } })).toBe(true);
    expect(usesLearnedCheckin({ checkin: learnedNone() })).toBe(true);
    expect(usesLearnedCheckin({ checkin: { method: 'none' } })).toBe(false);
    expect(usesLearnedCheckin({ checkin: { method: 'button', buttonSelector: '#c' } })).toBe(false);
  });
});

describe('内置站点合并', () => {
  it.each(['builtin-kid1412', 'builtin-futurehub'])('%s 按钮模板不会把 url/buttonSelector 带回学到的登录即签到', (id) => {
    const builtin = BUILTIN_SITES.find((site) => site.id === id)!;
    expect(builtin.checkin?.method).toBe('button');
    const checkin = learnedNone({ workflow: { steps: [], route: ['/dashboard', '/profile'], identityPath: '/profile' } });

    const merged = mergeBuiltinSite(builtin, { ...builtin, checkin });

    expect(merged.checkin).toEqual(checkin);
    // 与 background 保存后的读回核对同一份判据：之前这里会报「仍保留旧签到入口配置」。
    expect(verifyLearnedLoginAsCheckinStored(merged.checkin)).toEqual({ ok: true });
    // 后台读回还会再过一遍迁移，结果必须不变。
    expect(isLearnedLoginAsCheckin(migrateLegacySiteDefault(merged))).toBe(true);
  });

  it('未标记的 none 覆盖仍按原来的逐字段合并', () => {
    const builtin = BUILTIN_SITES.find((site) => site.id === 'builtin-kid1412')!;
    const merged = mergeBuiltinSite(builtin, { ...builtin, checkin: { method: 'none' } });
    expect(merged.checkin).toMatchObject({ method: 'none', url: '/profile' });
  });
});

describe('旧模板迁移不改写学到的登录即签到', () => {
  it.each([
    ['林夕', 'https://k40.shengqainbang.cn/login'],
    ['登仙公益站', 'https://api.denxio.top/login'],
    ['百倍', 'https://sub.100xlabs.space/login'],
    ['Future Hub', 'https://api.futureppo.top/login'],
    ['AnyRouter', 'https://anyrouter.top/login'],
  ])('%s 保留学到的 none 与身份路线', (_name, loginUrl) => {
    const checkin = learnedNone({ workflow: { steps: [], route: ['/console'], identityPath: '/console' } });
    const site = userSite(loginUrl, checkin);

    const migrated = migrateLegacySiteDefault(site);

    expect(migrated.checkin).toEqual(checkin);
    expect(migrateLegacySiteDefault(migrated)).toBe(migrated);
  });

  it.each([
    ['Orbelis', 'https://nova.vcrauo.com/sign-in'],
    ['SeekAI', 'https://seekai.cc/sign-in'],
  ])('%s 不把学到的 none 换成 /profile 按钮流程', (_name, loginUrl) => {
    const site = userSite(loginUrl, learnedNone());
    const migrated = migrateLegacySiteDefault(site);
    expect(migrated.checkin).toEqual(learnedNone());
  });

  it('未标记的旧 none 默认值照旧迁移（保持原有修正）', () => {
    const legacy = userSite('https://k40.shengqainbang.cn/login', { method: 'none' });
    expect(migrateLegacySiteDefault(legacy).checkin?.method).toBe('button');
  });
});

describe('API 直连签到', () => {
  const site: SiteConfig = {
    ...userSite('https://relay.example.com/login', learnedNone()),
    adapter: { siteType: SITE_TYPES.NEW_API, family: ADAPTER_FAMILIES.NEW_API },
  };

  it('学到的登录即签到不发任何接口请求，交给浏览器登录确认', async () => {
    const deps: HeadlessDeps = {
      now: vi.fn(() => 1_700_000_000_000),
      sleep: vi.fn(async () => undefined),
      fetch: vi.fn(async () => { throw new Error('should not fetch'); }) as typeof fetch,
    };
    const result = await tryHeadlessCheckin({
      id: 'account-1',
      siteId: site.id,
      username: 'user@example.com',
      password: 'password',
    }, site, deps);

    expect(result.verdict).toBe('inconclusive');
    expect(deps.fetch).not.toHaveBeenCalled();
  });
});
