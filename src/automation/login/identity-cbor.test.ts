/**
 * 有限 CBOR 解码器的单元测试。
 *
 * 所有 fixture 字节都由**本文件内的最小编码器**或手写十六进制产生，与被测
 * 解码器相互独立：断言的输入是开发者按 RFC 8949 手工拿捏的字节，而不是
 * 「用实现验证实现」。
 *
 * 覆盖三类真实来源：
 *  - orevx 的 /user/me 用户对象（map/array/文本/整数，偶发 float）；
 *  - problem+cbor 错误体（code/title/detail/errors/status，status 可能是 float16，
 *    服务端实测把 401 编成 f9 5e44）；
 *  - 恶意或损坏的字节流：不定长度、标签、超界 64 位整数、字节串、坏 UTF-8、
 *    截断、尾部垃圾、超深嵌套 —— 一律拒绝而不是尽量解析。
 */
import { describe, expect, it } from 'vitest';
import { decodeLimitedCbor } from '@/automation/login/identity-cbor';
import { extractIdentityFromPayload } from '@/automation/login/identity';

type BytePart = number | number[] | Uint8Array;

function bytes(...parts: BytePart[]): Uint8Array {
  const out: number[] = [];
  for (const part of parts) {
    if (typeof part === 'number') out.push(part);
    else for (const byte of part) out.push(byte);
  }
  return new Uint8Array(out);
}

/** 十六进制字符串 → 字节数组；空白忽略，便于手写边界样本 */
function hex(text: string): Uint8Array {
  const clean = text.replace(/\s+/g, '');
  if (clean.length % 2) throw new Error(`hex 长度必须是偶数: ${text}`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** 测试专用最小编码器：把 JS 值编成确定长度的 CBOR 字节（独立于被测解码器） */
function encUint(major: number, n: number): number[] {
  const head = major << 5;
  if (n < 24) return [head | n];
  if (n < 0x100) return [head | 24, n];
  if (n < 0x10000) return [head | 25, (n >> 8) & 0xff, n & 0xff];
  if (n < 0x100000000) {
    return [head | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  }
  const hi = Math.floor(n / 0x100000000);
  const lo = n >>> 0;
  return [
    head | 27,
    (hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff,
    (lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff,
  ];
}

function tstr(value: string): number[] {
  const utf8 = Array.from(new TextEncoder().encode(value));
  return [...encUint(3, utf8.length), ...utf8];
}

function cbor(value: unknown): number[] {
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new Error(`测试编码器不支持非整数数字: ${value}`);
    return value >= 0 ? encUint(0, value) : encUint(1, -1 - value);
  }
  if (typeof value === 'string') return tstr(value);
  if (typeof value === 'boolean') return [value ? 0xf5 : 0xf4];
  if (value === null) return [0xf6];
  if (Array.isArray(value)) return [...encUint(4, value.length), ...value.flatMap((item) => cbor(item))];
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    return [...encUint(5, entries.length), ...entries.flatMap(([key, item]) => [...tstr(key), ...cbor(item)])];
  }
  throw new Error(`测试编码器不支持: ${String(value)}`);
}

function fixture(value: unknown): Uint8Array {
  return bytes(cbor(value));
}

describe('decodeLimitedCbor 支持的类型', () => {
  it('无符号整数：短编码与 1/2/4 字节边界', () => {
    const cases: Array<[number, Uint8Array]> = [
      [0, bytes(0x00)],
      [23, bytes(0x17)],
      [24, bytes(0x18, 24)],
      [255, bytes(0x18, 0xff)],
      [256, bytes(0x19, 0x01, 0x00)],
      [65535, bytes(0x19, 0xff, 0xff)],
      [65536, bytes(0x1a, 0x00, 0x01, 0x00, 0x00)],
      [4294967295, hex('1a ffffffff')],
      [4294967296, hex('1b 0000000100000000')],
      [Number.MAX_SAFE_INTEGER, hex('1b 001fffffffffffff')],
    ];
    for (const [expected, input] of cases) {
      expect(decodeLimitedCbor(input)).toBe(expected);
    }
  });

  it('负整数：-1 / -24 / -1000', () => {
    expect(decodeLimitedCbor(bytes(0x20))).toBe(-1);
    expect(decodeLimitedCbor(bytes(0x37))).toBe(-24);
    expect(decodeLimitedCbor(hex('39 03e7'))).toBe(-1000);
  });

  it('文本字符串按 UTF-8 解码（含中文与多字节）', () => {
    expect(decodeLimitedCbor(fixture('alice'))).toBe('alice');
    expect(decodeLimitedCbor(fixture('用户名密码'))).toBe('用户名密码');
    expect(decodeLimitedCbor(fixture('sentinel-哨兵'))).toBe('sentinel-哨兵');
    expect(decodeLimitedCbor(fixture(''))).toBe('');
  });

  it('布尔与 null', () => {
    expect(decodeLimitedCbor(bytes(0xf5))).toBe(true);
    expect(decodeLimitedCbor(bytes(0xf4))).toBe(false);
    expect(decodeLimitedCbor(bytes(0xf6))).toBe(null);
  });

  it('数组（含嵌套与混合类型）', () => {
    expect(decodeLimitedCbor(fixture([1, 'a', true, null]))).toEqual([1, 'a', true, null]);
    expect(decodeLimitedCbor(fixture([[1], [2, [3]]]))).toEqual([[1], [2, [3]]]);
    expect(decodeLimitedCbor(fixture([]))).toEqual([]);
  });

  it('map 与嵌套 map', () => {
    const decoded = decodeLimitedCbor(fixture({ id: 42, username: 'alice', email: 'a@example.com' })) as Record<string, unknown>;
    expect({ ...decoded }).toEqual({ id: 42, username: 'alice', email: 'a@example.com' });

    const nested = decodeLimitedCbor(fixture({ data: { id: 7, name: '哨兵' }, success: true })) as Record<string, unknown>;
    expect({ ...nested }).toEqual({ data: { id: 7, name: '哨兵' }, success: true });
  });

  it('浮点：float16 / float32 / float64', () => {
    // 服务端实测把 401 编成 float16（0x5e44 = 401）
    expect(decodeLimitedCbor(hex('f9 5e44'))).toBe(401);
    // float16 1.5（0x3e00）
    expect(decodeLimitedCbor(hex('f9 3e00'))).toBe(1.5);
    // float16 -0 与普通数字的区分：-0 也是合法浮点
    expect(Object.is(decodeLimitedCbor(hex('f9 8000')), -0)).toBe(true);
    // float32 1.5
    expect(decodeLimitedCbor(hex('fa 3fc00000'))).toBe(1.5);
    // float64 1.1（IEEE 754 双精度）
    expect(decodeLimitedCbor(hex('fb 3ff199999999999a'))).toBeCloseTo(1.1, 10);
    // float16 NaN / Infinity 也按数字返回，交给上层按需处理
    expect(Number.isNaN(decodeLimitedCbor(hex('f9 7e00')))).toBe(true);
    expect(decodeLimitedCbor(hex('f9 7c00'))).toBe(Number.POSITIVE_INFINITY);
  });

  it('map 里非字符串键的项被跳过，不污染结果', () => {
    // {1: 'x', 'id': 9} —— 整数键不是身份字段，跳过即可
    const decoded = decodeLimitedCbor(hex('a2 01 6178 62 6964 09')) as Record<string, unknown>;
    expect({ ...decoded }).toEqual({ id: 9 });
  });

  it('"__proto__" 键不会污染全局原型', () => {
    // 计算属性写法才能构造自己的 __proto__ 键（对象字面量的 __proto__: 会改原型）
    const decoded = decodeLimitedCbor(fixture({ ['__proto__']: { polluted: true }, id: 1 })) as Record<string, unknown>;
    expect(Object.getPrototypeOf(decoded)).toBeNull();
    expect(decoded.id).toBe(1);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('decodeLimitedCbor 拒绝不支持的编码', () => {
  it('空输入', () => {
    expect(() => decodeLimitedCbor(new Uint8Array(0))).toThrow(/空/);
  });

  it('非 Uint8Array 输入', () => {
    expect(() => decodeLimitedCbor('cbor' as unknown as Uint8Array)).toThrow(/Uint8Array/);
  });

  it('不定长度：数组 / map / 文本 / break 字节', () => {
    expect(() => decodeLimitedCbor(hex('9f ff'))).toThrow(/不定长度/);
    expect(() => decodeLimitedCbor(hex('bf ff'))).toThrow(/不定长度/);
    expect(() => decodeLimitedCbor(hex('7f 61 61 ff'))).toThrow(/不定长度/);
    expect(() => decodeLimitedCbor(hex('ff'))).toThrow(/不定长度/);
  });

  it('标签（major 6）一律拒绝', () => {
    expect(() => decodeLimitedCbor(hex('c1 1a 514b67b0'))).toThrow(/标签/);
    expect(() => decodeLimitedCbor(hex('d8 20 61 61'))).toThrow(/标签/);
  });

  it('超出安全整数范围的 64 位整数', () => {
    // 2^53 已经超出 Number.MAX_SAFE_INTEGER
    expect(() => decodeLimitedCbor(hex('1b 0020000000000000'))).toThrow(/安全/);
    // -1 - (2^53-1) = -(2^53)，同样超出安全范围
    expect(() => decodeLimitedCbor(hex('3b 001fffffffffffff'))).toThrow(/安全/);
    // 2^64-1 编码
    expect(() => decodeLimitedCbor(hex('1b ffffffffffffffff'))).toThrow(/安全/);
  });

  it('字节串（major 2）不在支持范围内', () => {
    expect(() => decodeLimitedCbor(hex('43 010203'))).toThrow(/字节串/);
  });

  it('非法 UTF-8 的文本', () => {
    expect(() => decodeLimitedCbor(hex('62 c3 28'))).toThrow(/UTF-8/);
  });

  it('截断的数据', () => {
    expect(() => decodeLimitedCbor(hex('1a 0000'))).toThrow(/不完整/);
    expect(() => decodeLimitedCbor(hex('62 61'))).toThrow(/不完整/);
    expect(() => decodeLimitedCbor(hex('82 01'))).toThrow(/不完整/);
  });

  it('根值之后有多余字节', () => {
    expect(() => decodeLimitedCbor(hex('01 01'))).toThrow(/尾部|多余/);
    expect(() => decodeLimitedCbor(hex('a0 00'))).toThrow(/尾部|多余/);
  });

  it('保留的类型字节（additional info 28-30）', () => {
    expect(() => decodeLimitedCbor(hex('1c'))).toThrow(/非法|保留/);
    expect(() => decodeLimitedCbor(hex('3d'))).toThrow(/非法|保留/);
  });

  it('不支持的简单值（undefined、两字节简单值）', () => {
    expect(() => decodeLimitedCbor(hex('f7'))).toThrow(/简单值|不支持/);
    expect(() => decodeLimitedCbor(hex('f8 18'))).toThrow(/简单值|不支持/);
  });

  it('超出各项长度上限时拒绝（可用 limits 收紧）', () => {
    expect(() => decodeLimitedCbor(fixture({ a: { b: { c: 1 } } }), { maxDepth: 2 })).toThrow(/深度/);
    expect(() => decodeLimitedCbor(fixture([1, 2, 3]), { maxContainerLength: 2 })).toThrow(/容器/);
    expect(() => decodeLimitedCbor(fixture('hello'), { maxTextLength: 2 })).toThrow(/文本长度/);
    expect(() => decodeLimitedCbor(fixture([1, 2, 3]), { maxTotalItems: 3 })).toThrow(/总量/);
    expect(() => decodeLimitedCbor(fixture(1), { maxInputBytes: 0 })).toThrow(/输入长度/);
  });
});

describe('合成 CBOR 身份响应（丢给 extractIdentityFromPayload）', () => {
  it('orevx /user/me 形态的用户对象能解出身份字段', () => {
    const decoded = decodeLimitedCbor(fixture({
      id: 42,
      username: 'sentinel-user',
      email: 'sentinel@example.com',
      phone: '13800000000',
      status: 'active',
      roleKind: 'user',
    }));
    expect(extractIdentityFromPayload(decoded)).toMatchObject({
      userId: '42',
      username: 'sentinel-user',
      email: 'sentinel@example.com',
    });
  });

  it('problem+cbor 错误体解出对象但没有身份字段', () => {
    const decoded = decodeLimitedCbor(fixture({
      code: 'AUTH_MISSING_CREDENTIALS',
      title: '未授权',
      detail: '缺少认证凭据',
      errors: [{ message: 'missing credentials' }],
      status: 401,
    })) as Record<string, unknown>;
    expect(decoded.code).toBe('AUTH_MISSING_CREDENTIALS');
    expect(decoded.status).toBe(401);
    expect(extractIdentityFromPayload(decoded)).toBeNull();
  });

  it('float16 编码的 status 不会让整个响应解析失败', () => {
    // {"status": float16(401)} = a1 66 737461747573 f9 5e44
    const decoded = decodeLimitedCbor(hex('a1 66 737461747573 f9 5e44')) as Record<string, unknown>;
    expect(decoded.status).toBe(401);
  });
});
