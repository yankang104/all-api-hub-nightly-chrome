import { describe, expect, it } from 'vitest';
import { ADAPTER_FAMILIES } from '@/types';
import {
  checkinStatusMonth,
  looksLikeHtml,
  readCheckinResponse,
  readCheckinStats,
  resolveCheckinEndpoints,
  rewardFromStats,
} from '@/lib/checkin/checkin-endpoints';

const WORDS = {
  success: ['签到成功', 'check-in success'],
  already: ['已签到', '今日已', 'already checked'],
};

const read = (status: number, body: string, contentType = 'application/json') =>
  readCheckinResponse(status, contentType, body, WORDS);

describe('resolveCheckinEndpoints 端点选取', () => {
  it('new-api 家族给出签到与余额端点，走 user-id 头', () => {
    const resolved = resolveCheckinEndpoints(ADAPTER_FAMILIES.NEW_API);
    expect(resolved?.checkin).toContain('/api/user/checkin');
    expect(resolved?.balance).toContain('/api/user/self');
    expect(resolved?.auth).toBe('userIdHeaders');
    expect(resolved?.method).toBe('POST');
  });

  it('Sub2API 家族走 Bearer', () => {
    const resolved = resolveCheckinEndpoints(ADAPTER_FAMILIES.SUB2API);
    expect(resolved?.checkin).toContain('/api/v1/check-in');
    expect(resolved?.auth).toBe('bearer');
  });

  it('赞助签到的多步端点不在目录里（那条路要回退浏览器）', () => {
    const resolved = resolveCheckinEndpoints(ADAPTER_FAMILIES.SUB2API);
    expect(resolved?.checkin.some((path) => path.includes('tbe-sponsor'))).toBe(false);
  });

  it('站点显式 apiUrl 优先于家族目录', () => {
    const resolved = resolveCheckinEndpoints(ADAPTER_FAMILIES.NEW_API, '/custom/checkin');
    expect(resolved?.checkin).toEqual(['/custom/checkin']);
    expect(resolved?.explicit).toBe(true);
    // 认证协议仍按家族，地址是用户给的、协议不是
    expect(resolved?.auth).toBe('userIdHeaders');
  });

  it('显式 apiUrl 可覆盖请求方法', () => {
    expect(resolveCheckinEndpoints(ADAPTER_FAMILIES.NEW_API, '/x', 'GET')?.method).toBe('GET');
  });

  it('未知家族且无显式地址判不支持，不盲试', () => {
    expect(resolveCheckinEndpoints(ADAPTER_FAMILIES.UNSUPPORTED)).toBeNull();
  });

  it('未知家族但有显式地址时仍可直连，余额端点两族都试', () => {
    const resolved = resolveCheckinEndpoints(ADAPTER_FAMILIES.UNSUPPORTED, '/api/checkin');
    expect(resolved?.checkin).toEqual(['/api/checkin']);
    expect(resolved?.balance).toContain('/api/user/self');
    expect(resolved?.balance).toContain('/api/v1/auth/me');
  });

  it('空白 apiUrl 按没配处理', () => {
    const resolved = resolveCheckinEndpoints(ADAPTER_FAMILIES.NEW_API, '   ');
    expect(resolved?.explicit).toBe(false);
    expect(resolved?.checkin).toContain('/api/user/checkin');
  });
});

describe('looksLikeHtml', () => {
  it('按 content-type 识别', () => {
    expect(looksLikeHtml('text/html; charset=utf-8', '{}')).toBe(true);
  });

  it('content-type 撒谎时按正文识别（SPA 兜底 index.html）', () => {
    expect(looksLikeHtml('application/json', '<!DOCTYPE html><html><body>')).toBe(true);
  });

  it('正常 JSON 不误判', () => {
    expect(looksLikeHtml('application/json', '{"success":true}')).toBe(false);
  });
});

describe('readCheckinResponse 结构优先于文案', () => {
  it('success:false 但文案说已签到 → 判已签（New API 的返回形式）', () => {
    const reading = read(200, JSON.stringify({ success: false, message: '今日已签到' }));
    expect(reading.verdict).toBe('claims-already');
  });

  it('success:false 且文案不提已签 → 判失败', () => {
    const reading = read(200, JSON.stringify({ success: false, message: '账户异常' }));
    expect(reading.verdict).toBe('claims-failure');
    expect(reading.message).toBe('账户异常');
  });

  it('success:true 但文案说已签到 → 判已签而非成功', () => {
    // 关键回归：这种响应没有发新额度，若判成功，随后守恒差分的
    // unchanged 会被误读成"假成功"而白白回退一次浏览器
    const reading = read(200, JSON.stringify({ success: true, message: '今日已签到' }));
    expect(reading.verdict).toBe('claims-already');
  });

  it('success:true 判声称成功', () => {
    expect(read(200, JSON.stringify({ success: true, message: '签到成功' })).verdict)
      .toBe('claims-success');
  });

  it('code:0 判声称成功（Sub2API 形式）', () => {
    expect(read(200, JSON.stringify({ code: 0, data: { amount: 1 } })).verdict)
      .toBe('claims-success');
  });

  it('ret:1 判声称成功', () => {
    expect(read(200, JSON.stringify({ ret: 1 })).verdict).toBe('claims-success');
  });

  it('data.success 嵌套也能读到', () => {
    expect(read(200, JSON.stringify({ data: { success: true } })).verdict).toBe('claims-success');
  });

  it('already:true 判已签', () => {
    expect(read(200, JSON.stringify({ already: true })).verdict).toBe('claims-already');
  });

  it('{"success":false} 不会因为含 false 就被文案匹配误判', () => {
    // 结构信号必须先于文案：这条响应没有任何文案，只有结构
    expect(read(200, JSON.stringify({ success: false })).verdict).toBe('claims-failure');
  });
});

describe('readCheckinResponse 状态码与非 JSON', () => {
  it('401 判登录态失效', () => {
    expect(read(401, '{}').verdict).toBe('auth-expired');
  });

  it('403 判登录态失效', () => {
    expect(read(403, '{}').verdict).toBe('auth-expired');
  });

  it('404 判不支持', () => {
    expect(read(404, 'Not Found').verdict).toBe('unsupported');
  });

  it('405 判不支持（方法不对，等于没这个接口）', () => {
    expect(read(405, '').verdict).toBe('unsupported');
  });

  it('HTML 响应判不支持', () => {
    expect(read(200, '<!doctype html><html>', 'text/html').verdict).toBe('unsupported');
  });

  it('纯文本含成功词判声称成功', () => {
    expect(read(200, '签到成功', 'text/plain').verdict).toBe('claims-success');
  });

  it('纯文本含已签词判已签', () => {
    expect(read(200, '已签到', 'text/plain').verdict).toBe('claims-already');
  });

  it('读不出语义时如实返回 unreadable，不猜', () => {
    expect(read(200, JSON.stringify({ foo: 'bar' })).verdict).toBe('unreadable');
  });

  it('500 且非 JSON 判不支持', () => {
    expect(read(500, 'Internal Server Error', 'text/plain').verdict).toBe('unsupported');
  });

  it('HTTP 错误码 + JSON 失败体，文案透传出来', () => {
    const reading = read(400, JSON.stringify({ message: '参数错误' }));
    expect(reading.verdict).toBe('claims-failure');
    expect(reading.message).toBe('参数错误');
  });
});

/** 实测形状：GET /api/user/checkin?month=YYYY-MM 的返回 */
const STATS_BODY = {
  success: true,
  data: {
    enabled: true,
    max_quota: 6_900_000,
    min_quota: 2_780_000,
    stats: {
      checked_in_today: true,
      checkin_count: 14,
      total_checkins: 18,
      total_quota: 82_656_457,
      records: [{ checkin_date: '2026-08-18', quota_awarded: 2_973_248 }],
    },
  },
};

const stats = (body: unknown, status = 200, contentType = 'application/json') =>
  readCheckinStats(status, contentType, typeof body === 'string' ? body : JSON.stringify(body));

describe('readCheckinStats 台账解读', () => {
  it('读出启用状态、今日已签与记录', () => {
    const reading = stats(STATS_BODY);
    expect(reading).not.toBeNull();
    expect(reading?.enabled).toBe(true);
    expect(reading?.checkedInToday).toBe(true);
    expect(reading?.records).toEqual([{ date: '2026-08-18', quotaAwarded: 2_973_248 }]);
  });

  it('没有 data.stats 就不是兼容站点，返回 null', () => {
    expect(stats({ success: true, data: { enabled: true } })).toBeNull();
    expect(stats({ success: true })).toBeNull();
  });

  it('SPA 兜底的 HTML 不会被当成台账', () => {
    expect(stats('<!doctype html><html><body>app</body></html>', 200, 'text/html')).toBeNull();
  });

  it('非 200 一律不读', () => {
    expect(stats(STATS_BODY, 404)).toBeNull();
    expect(stats(STATS_BODY, 401)).toBeNull();
  });

  it('enabled:false 如实读出，调用方据此判不支持', () => {
    const reading = stats({ ...STATS_BODY, data: { ...STATS_BODY.data, enabled: false } });
    expect(reading?.enabled).toBe(false);
  });

  it('缺 enabled 字段按开着处理（少数分叉不吐这个字段）', () => {
    const reading = stats({ success: true, data: { stats: { records: [] } } });
    expect(reading?.enabled).toBe(true);
    expect(reading?.checkedInToday).toBe(false);
  });

  it('字符串数字的额度也能读', () => {
    const reading = stats({
      success: true,
      data: { stats: { records: [{ checkin_date: '2026-08-18', quota_awarded: '2973248' }] } },
    });
    expect(reading?.records[0]?.quotaAwarded).toBe(2_973_248);
  });

  it('残缺记录被跳过，不污染台账', () => {
    const reading = stats({
      success: true,
      data: { stats: { records: [{ checkin_date: '2026-08-18' }, null, { quota_awarded: 1 }, 'x'] } },
    });
    expect(reading?.records).toEqual([]);
  });

  it('records 不是数组时按空台账处理', () => {
    expect(stats({ success: true, data: { stats: { records: 'nope' } } })?.records).toEqual([]);
  });

  it('非 JSON 正文返回 null', () => {
    expect(stats('not json at all', 200, 'application/json')).toBeNull();
  });
});

describe('rewardFromStats 认本次奖励', () => {
  const reading = (dates: Array<[string, number]>, checkedInToday = false) => ({
    enabled: true,
    checkedInToday,
    records: dates.map(([date, quotaAwarded]) => ({ date, quotaAwarded })),
  });

  it('多出来的那条就是本次奖励', () => {
    const before = reading([['2026-08-18', 2_973_248]]);
    const after = reading([['2026-08-18', 2_973_248], ['2026-08-19', 3_100_000]], true);
    expect(rewardFromStats(before, after)).toBe(3_100_000);
  });

  it('台账没变说明这次没记账，返回 null 交给余额差分', () => {
    const same = reading([['2026-08-18', 2_973_248]]);
    expect(rewardFromStats(same, same)).toBeNull();
  });

  it('读不到签到后台账返回 null', () => {
    expect(rewardFromStats(reading([]), null)).toBeNull();
  });

  it('签到前台账缺失时返回 null，不把整月记录算成本次所得', () => {
    // 少了 before 就无从判断哪条是新的。若在这里求和，一个月签了十几天的
    // 账号会报出十几天的总额 —— 虚高一个量级，比读不到更糟。
    const after = reading([['2026-08-17', 1], ['2026-08-18', 2]], true);
    expect(rewardFromStats(null, after)).toBeNull();
  });

  it('新记录金额为 0 时返回 null，不谎报到账', () => {
    const before = reading([]);
    const after = reading([['2026-08-19', 0]], true);
    expect(rewardFromStats(before, after)).toBeNull();
  });
});

describe('checkinStatusMonth', () => {
  it('按本地时间给出 YYYY-MM', () => {
    const date = new Date(2026, 7, 19, 12, 0, 0);
    expect(checkinStatusMonth(date.getTime())).toBe('2026-08');
  });

  it('月份补零', () => {
    expect(checkinStatusMonth(new Date(2026, 0, 5, 12, 0, 0).getTime())).toBe('2026-01');
  });

  it('月末深夜仍算当月（UTC 会偏到上个月）', () => {
    expect(checkinStatusMonth(new Date(2026, 7, 31, 23, 30, 0).getTime())).toBe('2026-08');
  });
});
