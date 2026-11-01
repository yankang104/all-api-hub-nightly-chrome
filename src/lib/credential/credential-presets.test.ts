import { describe, expect, it } from 'vitest';
import type { Account, SiteConfig } from '@/types';
import type { CredentialCandidate, CredentialPreset } from '@/types/credential';
import {
  MAX_PRESETS,
  collectAccountCandidates,
  credentialFingerprint,
  credentialFromAccount,
  markPresetUsed,
  mergeManualCandidates,
  normalizePresets,
  presetFromCandidate,
  rankCandidates,
  removePreset,
  sameHostSiteIds,
  upsertPreset,
  validatePresetInput,
} from './credential-presets';

function account(overrides: Partial<Account> & { id: string; siteId: string; username: string; password: string }): Account {
  return {
    label: undefined,
    ...overrides,
  };
}

const siteA: SiteConfig = {
  id: 'site-a',
  name: '站点A',
  loginUrl: 'https://a.example.com/login',
  selectors: { username: '#u', password: '#p', submit: 'button' },
  closeModalSelectors: [],
};

const siteB: SiteConfig = {
  id: 'site-b',
  name: '站点B',
  loginUrl: 'https://a.example.com/signin',
  selectors: { username: '#u', password: '#p', submit: 'button' },
  closeModalSelectors: [],
};

const siteC: SiteConfig = {
  id: 'site-c',
  name: '站点C',
  loginUrl: 'https://c.example.com/login',
  selectors: { username: '#u', password: '#p', submit: 'button' },
  closeModalSelectors: [],
};

describe('credentialFingerprint', () => {
  it('用户名忽略大小写与空白，密码精确比较', () => {
    expect(credentialFingerprint('github', ' User ', 'pass')).toBe(credentialFingerprint('github', 'user', 'pass'));
    expect(credentialFingerprint('github', 'user', 'pass')).not.toBe(credentialFingerprint('github', 'user', 'pass2'));
    expect(credentialFingerprint('site', 'user', 'pass')).not.toBe(credentialFingerprint('github', 'user', 'pass'));
  });
});

describe('credentialFromAccount', () => {
  it('github 凭据需要成对存在', () => {
    const a = account({ id: 'a1', siteId: 's', username: 'site-user', password: 'site-pass', githubUsername: 'gh', githubPassword: 'gh-pass' });
    expect(credentialFromAccount(a, 'github')).toEqual({ username: 'gh', password: 'gh-pass' });
    expect(credentialFromAccount({ ...a, githubPassword: '' }, 'github')).toBeNull();
    expect(credentialFromAccount({ ...a, githubUsername: '  ' }, 'github')).toBeNull();
  });

  it('site 凭据来自账号用户名密码，空密码跳过', () => {
    const a = account({ id: 'a2', siteId: 's', username: ' site-user ', password: 'site-pass' });
    expect(credentialFromAccount(a, 'site')).toEqual({ username: 'site-user', password: 'site-pass' });
    expect(credentialFromAccount({ ...a, password: '' }, 'site')).toBeNull();
  });
});

describe('validatePresetInput', () => {
  it('非法类型 / 空用户名 / 空密码分别报错', () => {
    expect(validatePresetInput({ kind: 'site', username: 'u', password: 'p' })).toBeNull();
    expect(validatePresetInput({ kind: 'bad' as 'site', username: 'u', password: 'p' })).toBe('凭据类型无效');
    expect(validatePresetInput({ kind: 'github', username: '  ', password: 'p' })).toBe('用户名不能为空');
    expect(validatePresetInput({ kind: 'github', username: 'u', password: '' })).toBe('密码不能为空');
  });
});

describe('sameHostSiteIds', () => {
  it('返回同主机站点并保证当前站点在列', () => {
    const ids = sameHostSiteIds([siteA, siteB, siteC], 'site-a');
    expect(ids).toContain('site-a');
    expect(ids).toContain('site-b');
    expect(ids).not.toContain('site-c');
  });

  it('找不到当前站点时只返回自身', () => {
    expect(sameHostSiteIds([siteB, siteC], 'site-a')).toEqual(['site-a']);
  });
});

describe('collectAccountCandidates', () => {
  it('按种类提取并跳过空凭据', () => {
    const accounts = [
      account({ id: 'a1', siteId: 's1', username: 'u1', password: 'p1', githubUsername: 'gh', githubPassword: 'ghp' }),
      account({ id: 'a2', siteId: 's1', username: 'u2', password: '' }),
    ];
    const siteCandidates = collectAccountCandidates(accounts, 'site');
    expect(siteCandidates).toHaveLength(1);
    expect(siteCandidates[0]?.username).toBe('u1');

    const githubCandidates = collectAccountCandidates(accounts, 'github');
    expect(githubCandidates).toHaveLength(1);
    expect(githubCandidates[0]?.username).toBe('gh');
  });

  it('同指纹去重：保留最新账号，累计 accountCount', () => {
    const accounts = [
      account({ id: 'old', siteId: 's1', username: 'same', password: 'p', label: '旧备注' }),
      account({ id: 'new', siteId: 's2', username: 'same', password: 'p' }),
    ];
    const [candidate] = collectAccountCandidates(accounts, 'site');
    expect(candidate?.accountId).toBe('new');
    expect(candidate?.accountCount).toBe(2);
    // 最新账号无备注时借用旧账号的备注
    expect(candidate?.label).toBe('旧备注');
  });

  it('最新账号无备注时借用旧账号的备注', () => {
    const accounts = [
      account({ id: 'old', siteId: 's1', username: 'same', password: 'p', label: '主号' }),
      account({ id: 'new', siteId: 's2', username: 'same', password: 'p' }),
    ];
    const [candidate] = collectAccountCandidates(accounts, 'site');
    expect(candidate?.label).toBe('主号');
  });

  it('同名不同密码算两条候选', () => {
    const accounts = [
      account({ id: 'a', siteId: 's1', username: 'same', password: 'p1' }),
      account({ id: 'b', siteId: 's2', username: 'same', password: 'p2' }),
    ];
    expect(collectAccountCandidates(accounts, 'site')).toHaveLength(2);
  });

  it('excludeAccountId 排除自身、allowedSiteIds 过滤站点', () => {
    const accounts = [
      account({ id: 'me', siteId: 's1', username: 'u1', password: 'p1' }),
      account({ id: 'other', siteId: 's2', username: 'u2', password: 'p2' }),
    ];
    const filtered = collectAccountCandidates(accounts, 'site', {
      excludeAccountId: 'me',
      allowedSiteIds: new Set(['s2']),
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.accountId).toBe('other');
  });

  it('siteNameOf 填充站点名', () => {
    const accounts = [account({ id: 'a', siteId: 's1', username: 'u', password: 'p' })];
    const [candidate] = collectAccountCandidates(accounts, 'site', {
      siteNameOf: (siteId) => (siteId === 's1' ? '示例站' : undefined),
    });
    expect(candidate?.siteName).toBe('示例站');
  });
});

describe('mergeManualCandidates', () => {
  it('同指纹预设补充元信息而不新增条目', () => {
    const candidate: CredentialCandidate = {
      id: 'account:a:site',
      kind: 'site',
      username: 'u',
      password: 'p',
      label: 'u',
      origin: 'account',
      accountId: 'a',
      siteId: 's1',
      updatedAt: 0,
      accountCount: 1,
    };
    const preset: CredentialPreset = {
      id: 'cp1',
      kind: 'site',
      username: 'u',
      password: 'p',
      label: '主号',
      updatedAt: 100,
      lastUsedAt: 90,
      useCount: 3,
    };
    const merged = mergeManualCandidates([candidate], [preset]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      presetId: 'cp1',
      label: '主号',
      updatedAt: 100,
      lastUsedAt: 90,
      useCount: 3,
      origin: 'account',
      accountCount: 1,
    });
  });

  it('独有预设追加为 manual 候选', () => {
    const preset: CredentialPreset = {
      id: 'cp2',
      kind: 'github',
      username: 'gh',
      password: 'ghp',
      label: '小号',
      updatedAt: 50,
    };
    const merged = mergeManualCandidates([], [preset]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ origin: 'manual', id: 'cp2', label: '小号', presetId: 'cp2' });
  });
});

describe('rankCandidates', () => {
  function candidate(id: string, overrides: Partial<CredentialCandidate>): CredentialCandidate {
    return {
      id,
      kind: 'github',
      username: id,
      password: 'p',
      label: id,
      origin: 'manual',
      updatedAt: 0,
      ...overrides,
    };
  }

  it('当前站点优先，其次最近使用，再按名称', () => {
    const ranked = rankCandidates([
      candidate('old', { label: 'b-user', updatedAt: 10 }),
      candidate('same-site', { siteId: 'cur', label: 'z-user', updatedAt: 1 }),
      candidate('recent', { label: 'a-user', lastUsedAt: 99 }),
    ], 'cur');
    expect(ranked.map((item) => item.id)).toEqual(['same-site', 'recent', 'old']);
  });

  it('无当前站点时只按最近使用与名称排序', () => {
    const ranked = rankCandidates([
      candidate('b', { label: 'b', updatedAt: 10 }),
      candidate('a', { label: 'a', lastUsedAt: 99 }),
      candidate('c', { label: 'c', updatedAt: 5 }),
    ]);
    expect(ranked.map((item) => item.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('presetFromCandidate', () => {
  it('复用 presetId，名称与用户名一致时不写 label', () => {
    const candidate: CredentialCandidate = {
      id: 'cp1',
      kind: 'github',
      username: 'gh',
      password: 'ghp',
      label: 'gh',
      origin: 'manual',
      presetId: 'cp1',
      updatedAt: 5,
      lastUsedAt: 3,
      useCount: 2,
    };
    const preset = presetFromCandidate(candidate, 123);
    expect(preset.id).toBe('cp1');
    expect(preset.label).toBeUndefined();
    expect(preset.updatedAt).toBe(123);
    expect(preset.lastUsedAt).toBe(3);
    expect(preset.useCount).toBe(2);
  });

  it('账号候选生成新 id 并带上备注', () => {
    const candidate: CredentialCandidate = {
      id: 'account:a:site',
      kind: 'site',
      username: 'u',
      password: 'p',
      label: '主号',
      origin: 'account',
      accountId: 'a',
      siteId: 's1',
      updatedAt: 0,
    };
    const preset = presetFromCandidate(candidate, 456);
    expect(preset.id).toMatch(/^cp-/);
    expect(preset.label).toBe('主号');
    expect(preset.siteId).toBe('s1');
  });
});

describe('upsertPreset / markPresetUsed / removePreset', () => {
  const base: CredentialPreset[] = [
    { id: 'cp1', kind: 'github', username: 'u1', password: 'p1', updatedAt: 1 },
    { id: 'cp2', kind: 'github', username: 'u2', password: 'p2', updatedAt: 2 },
  ];

  it('按 id 替换并合并同指纹旧条目', () => {
    const next = upsertPreset(base, { id: 'cp3', kind: 'github', username: 'u1', password: 'p1', updatedAt: 9 });
    expect(next).toHaveLength(2);
    expect(next.find((item) => item.id === 'cp1')).toBeUndefined();
    expect(next.find((item) => item.id === 'cp3')).toBeDefined();
  });

  it('markPresetUsed 累加使用次数', () => {
    const next = markPresetUsed(base, 'cp2', 100);
    expect(next[1]).toMatchObject({ lastUsedAt: 100, useCount: 1 });
    const again = markPresetUsed(next, 'cp2', 200);
    expect(again[1]).toMatchObject({ lastUsedAt: 200, useCount: 2 });
    expect(next[0]).toBe(base[0]);
  });

  it('removePreset 只删指定条目', () => {
    const next = removePreset(base, 'cp1');
    expect(next.map((item) => item.id)).toEqual(['cp2']);
  });
});

describe('normalizePresets', () => {
  it('非数组与坏条目安全丢弃', () => {
    expect(normalizePresets(null)).toEqual([]);
    expect(normalizePresets('x')).toEqual([]);
    expect(normalizePresets([null, 1, { id: 'cp', kind: 'nope', username: 'u', password: 'p' }])).toEqual([]);
    expect(normalizePresets([{ id: 'cp', kind: 'site', username: 'u', password: '' }])).toEqual([]);
  });

  it('规范化字段：修剪用户名、丢弃空备注、校正计数与时间', () => {
    const normalized = normalizePresets([{
      id: 'cp1',
      kind: 'github',
      username: ' gh ',
      password: 'p',
      label: '  主号 ',
      updatedAt: -5,
      lastUsedAt: 'x',
      useCount: 2.7,
      siteId: 's1',
    }]);
    expect(normalized).toEqual([{
      id: 'cp1',
      kind: 'github',
      username: 'gh',
      password: 'p',
      label: '主号',
      updatedAt: 0,
      siteId: 's1',
      useCount: 2,
    }]);
  });

  it('同 id 去重、同指纹保留更新者、按时间倒序', () => {
    const normalized = normalizePresets([
      { id: 'cp1', kind: 'github', username: 'u', password: 'p', updatedAt: 1 },
      { id: 'cp1', kind: 'github', username: 'u', password: 'p', updatedAt: 2 },
      { id: 'cp2', kind: 'github', username: 'u', password: 'p', updatedAt: 5 },
      { id: 'cp3', kind: 'github', username: 'v', password: 'q', updatedAt: 3 },
    ]);
    expect(normalized.map((item) => item.id)).toEqual(['cp2', 'cp3']);
  });

  it('超过上限时裁剪到 MAX_PRESETS', () => {
    const raw = Array.from({ length: MAX_PRESETS + 20 }, (_, index) => ({
      id: `cp${index}`,
      kind: 'github' as const,
      username: `user${index}`,
      password: 'p',
      updatedAt: index,
    }));
    expect(normalizePresets(raw)).toHaveLength(MAX_PRESETS);
  });
});
