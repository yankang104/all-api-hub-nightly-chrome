import { describe, expect, it } from 'vitest';
import { buildUserIdHeaders, siteTypeFromErrorText } from '@/lib/site/compat-headers';
import { SITE_TYPES } from '@/types';

describe('buildUserIdHeaders', () => {
  it('把同一个 ID 扇出到全部兼容头名', () => {
    const headers = buildUserIdHeaders(4842);

    expect(headers['New-API-User']).toBe('4842');
    expect(headers['Veloera-User']).toBe('4842');
    expect(headers['X-Api-User']).toBe('4842');
    expect(headers['voapi-user']).toBe('4842');
    expect(headers['Rix-Api-User']).toBe('4842');
    expect(headers['neo-api-user']).toBe('4842');
  });

  it('数字和字符串 ID 结果一致', () => {
    expect(buildUserIdHeaders(42)).toEqual(buildUserIdHeaders('42'));
  });

  it.each([null, undefined, ''])('ID 缺失（%s）时返回空对象', (userId) => {
    expect(buildUserIdHeaders(userId)).toEqual({});
  });

  it('ID 为 0 时仍然发送', () => {
    // 0 是合法用户 ID，不能被当成"没填"
    expect(buildUserIdHeaders(0)['New-API-User']).toBe('0');
  });
});

describe('siteTypeFromErrorText', () => {
  it('从 401 文案里反查站点类型', () => {
    expect(siteTypeFromErrorText('无权进行此操作，未提供 New-API-User')).toBe(SITE_TYPES.NEW_API);
    expect(siteTypeFromErrorText('missing Veloera-User header')).toBe(SITE_TYPES.VELOERA);
  });

  it('大小写不敏感', () => {
    expect(siteTypeFromErrorText('missing new-api-user')).toBe(SITE_TYPES.NEW_API);
  });

  it('忽略过于通用的头名，避免误判', () => {
    // User-id 太常见，任何站点的报错都可能提到它
    expect(siteTypeFromErrorText('missing User-id')).toBeNull();
  });

  it('无法判断时返回 null', () => {
    expect(siteTypeFromErrorText('未登录')).toBeNull();
    expect(siteTypeFromErrorText('')).toBeNull();
  });
});
