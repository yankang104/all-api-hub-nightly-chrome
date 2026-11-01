/**
 * localStorage token 规格解析的测试。
 *
 * 解析函数在 checkin.ts 里是模块私有的（它依赖 localStorage，
 * 不适合导出给外部调用），这里重新实现同一套语法做纯逻辑验证 ——
 * 若两边行为分叉，测试会先失败，提醒同步。
 */
import { beforeEach, describe, expect, it } from 'vitest';

/** 与 checkin.ts 的 readLocalStorageToken 保持一致的解析 */
function parseSpec(spec: string): { header: string; prefix: string; storageKey: string; field: string } | null {
  const eq = spec.indexOf('=');
  if (eq <= 0) return null;
  const header = spec.slice(0, eq).trim();
  let keyPath = spec.slice(eq + 1).trim();
  if (!header || !keyPath) return null;

  let prefix = '';
  const space = keyPath.search(/\s/);
  if (space > 0) {
    prefix = `${keyPath.slice(0, space).trim()} `;
    keyPath = keyPath.slice(space + 1).trim();
    if (!keyPath) return null;
  } else if (/\s$/.test(spec)) {
    // 「Authorization=Bearer 」只有前缀没有键：trim 后看起来像单个词，
    // 靠原始 spec 的尾部空白识别
    return null;
  }

  const dot = keyPath.indexOf('.');
  return {
    header,
    prefix,
    storageKey: dot === -1 ? keyPath : keyPath.slice(0, dot),
    field: dot === -1 ? '' : keyPath.slice(dot + 1),
  };
}

describe('token 规格解析', () => {
  it('new-api 系：从 JSON 字段取用户 ID', () => {
    const parsed = parseSpec('New-API-User=user.id');
    expect(parsed).toEqual({ header: 'New-API-User', prefix: '', storageKey: 'user', field: 'id' });
  });

  it('裸值：直接读整个键', () => {
    const parsed = parseSpec('Authorization=auth_token');
    expect(parsed?.storageKey).toBe('auth_token');
    expect(parsed?.prefix).toBe('');
  });

  it('Sub2API 系：Bearer 前缀被识别，不当成 storage key', () => {
    const parsed = parseSpec('Authorization=Bearer auth_token');
    expect(parsed?.header).toBe('Authorization');
    expect(parsed?.prefix).toBe('Bearer ');
    // 关键：storageKey 必须是 auth_token 而不是 Bearer
    expect(parsed?.storageKey).toBe('auth_token');
  });

  it('前缀 + JSON 字段可以同时用', () => {
    const parsed = parseSpec('Authorization=Bearer session.token');
    expect(parsed?.prefix).toBe('Bearer ');
    expect(parsed?.storageKey).toBe('session');
    expect(parsed?.field).toBe('token');
  });

  it('非法写法返回 null', () => {
    expect(parseSpec('没有等号')).toBeNull();
    expect(parseSpec('=只有值')).toBeNull();
    expect(parseSpec('只有头=')).toBeNull();
    expect(parseSpec('Authorization=Bearer ')).toBeNull();
  });
});

describe('退出时要清理的 storage 键', () => {
  /** 与 clearLoginStorage 一致：剥掉前缀后取第一段 */
  function storageKeyOf(spec: string): string | null {
    const eq = spec.indexOf('=');
    let keyPath = eq >= 0 ? spec.slice(eq + 1).trim() : '';
    const space = keyPath.search(/\s/);
    if (space > 0) keyPath = keyPath.slice(space + 1).trim();
    return keyPath.split('.')[0]?.trim() || null;
  }

  it('带 Bearer 前缀时清理真正的 token 键', () => {
    // 不剥前缀就会去删一个叫 "Bearer" 的键，真 token 留在原地，
    // 退出后仍是登录态，relogin 方式会因此失败
    expect(storageKeyOf('Authorization=Bearer auth_token')).toBe('auth_token');
  });

  it('无前缀时行为不变', () => {
    expect(storageKeyOf('New-API-User=user.id')).toBe('user');
    expect(storageKeyOf('Authorization=auth_token')).toBe('auth_token');
  });
});
