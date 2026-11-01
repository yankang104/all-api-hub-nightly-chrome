/**
 * 有限 CBOR → JS 解码器（RFC 8949 子集）。
 *
 * 为什么需要它：orevx 这类站点的真实 API 在跨域 `server.orevx.ai`，且服务端
 * **只接受 `Accept: application/cbor`**（用 JSON 协商直接 406 拒绝），响应体是
 * CBOR。扩展只想从响应里拿 id/username/email 这几个身份字段，为此引入一个
 * 完整 CBOR 库既不划算也没必要。
 *
 * 支持范围刻意收窄（够读身份就停）：
 *   map / array / 文本字符串 / 整数 / 布尔 / null / 浮点（float16/32/64）。
 *
 * 一律拒绝（宁可整份放弃，也不做「尽量解析」）：
 *   - 不定长度（含 break 字节）—— 无法在读到结尾前设上界；
 *   - 标签（major 6）—— 语义由应用决定，身份字段不需要；
 *   - 超出 ±(2^53-1) 的 64 位整数 —— 转成 JS number 会静默丢精度，
 *     userId 这种标识一旦被改掉比读不到更糟；
 *   - 字节串（major 2）—— 身份字段用不到；
 *   - 非法 UTF-8 文本、截断的数据、根值之后的多余字节。
 *
 * 另有四道上限（可用第二参数在测试里收紧）：输入 1 MiB、深度 64 层、
 * 单容器 65536 项、单文本 256 KiB，以及一个解码总量上限。
 *
 * 输出 map 用 null 原型对象：响应里的 `__proto__` 键只会成为普通属性，
 * 不会顺着赋值路径改掉 JS 原型链。
 *
 * 解析失败一律抛 Error；调用方（identity.ts）把它当作「读不到身份」，绝不
 * 影响签到主流程。
 */

export interface CborDecodeLimits {
  /** 输入字节数上限 */
  maxInputBytes?: number;
  /** 嵌套深度上限（根值深度为 0） */
  maxDepth?: number;
  /** 单个 array/map 的条目数上限 */
  maxContainerLength?: number;
  /** 单个文本字符串的 UTF-8 字节上限 */
  maxTextLength?: number;
  /** 整份文档解码出的值（含键）总数上限 */
  maxTotalItems?: number;
}

const DEFAULT_LIMITS: Required<CborDecodeLimits> = {
  maxInputBytes: 1_048_576,
  maxDepth: 64,
  maxContainerLength: 65_536,
  maxTextLength: 262_144,
  maxTotalItems: 100_000,
};

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

function fail(reason: string): never {
  throw new Error(`CBOR 解码失败: ${reason}`);
}

class Reader {
  private pos = 0;
  private items = 0;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly limits: Required<CborDecodeLimits>,
  ) {}

  done(): boolean {
    return this.pos >= this.bytes.length;
  }

  readItem(depth: number): unknown {
    if (depth > this.limits.maxDepth) fail('超出深度上限');
    this.items += 1;
    if (this.items > this.limits.maxTotalItems) fail('超出解码总量上限');

    const initial = this.readByte();
    const major = initial >> 5;
    const info = initial & 0x1f;

    if (info === 31) fail('不支持不定长度');
    if (info > 27) fail('非法的类型字节（保留的 additional info）');
    if (major === 7) return this.readSimpleOrFloat(info);

    const arg = info < 24 ? info : this.readUintArgument(info);

    switch (major) {
      case 0:
        if (arg > MAX_SAFE) fail('整数超出安全范围');
        return arg;
      case 1:
        // -1 - arg 要落在 ±(2^53-1) 内：arg = 2^53-1 时结果是 -2^53，超界
        if (arg >= MAX_SAFE) fail('整数超出安全范围');
        return -1 - arg;
      case 2:
        fail('不支持字节串');
      // eslint-disable-next-line no-fallthrough -- fail() 一定抛出
      case 3:
        return this.readText(arg);
      case 4:
        return this.readArray(arg, depth);
      case 5:
        return this.readMap(arg, depth);
      default:
        fail('不支持标签');
    }
  }

  /** major 7：布尔、null、浮点；其余简单值不支持 */
  private readSimpleOrFloat(info: number): unknown {
    switch (info) {
      case 20:
        return false;
      case 21:
        return true;
      case 22:
        return null;
      case 25:
        return decodeFloat16(this.readRaw16());
      case 26: {
        const bits = this.readRaw32();
        const view = new DataView(new ArrayBuffer(4));
        view.setUint32(0, bits);
        return view.getFloat32(0);
      }
      case 27: {
        const high = this.readRaw32();
        const low = this.readRaw32();
        const view = new DataView(new ArrayBuffer(8));
        view.setUint32(0, high);
        view.setUint32(4, low);
        return view.getFloat64(0);
      }
      default:
        // 23 = undefined、24 = 两字节简单值、0-19 = 未分配简单值
        fail('不支持的简单值');
    }
  }

  private readArray(length: number, depth: number): unknown[] {
    this.checkContainerLength(length);
    const out: unknown[] = [];
    for (let i = 0; i < length; i += 1) out.push(this.readItem(depth + 1));
    return out;
  }

  private readMap(length: number, depth: number): Record<string, unknown> {
    this.checkContainerLength(length);
    // null 原型：响应里的 "__proto__" 键不会碰到 Object.prototype
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (let i = 0; i < length; i += 1) {
      const key = this.readItem(depth + 1);
      const value = this.readItem(depth + 1);
      // 身份字段都是文本键；其它键型跳过（值仍解码，保证流位置正确）
      if (typeof key === 'string') out[key] = value;
    }
    return out;
  }

  private readText(length: number): string {
    if (length > this.limits.maxTextLength) fail('超出文本长度上限');
    const slice = this.readBytes(length);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(slice);
    } catch {
      fail('文本不是合法 UTF-8');
    }
  }

  private checkContainerLength(length: number): void {
    if (length > this.limits.maxContainerLength) fail('超出容器长度上限');
    if (length > this.bytes.length - this.pos) fail('数据不完整（容器长度超出剩余字节）');
  }

  private readUintArgument(info: number): number {
    switch (info) {
      case 24:
        return this.readByte();
      case 25:
        return this.readRaw16();
      case 26:
        return this.readRaw32();
      case 27: {
        // 64 位：高低两个 32 位先各自拼装，再合成（避免 32 位移位溢出）
        const high = this.readRaw32();
        const low = this.readRaw32();
        const value = high * 0x100000000 + low;
        if (value > MAX_SAFE) fail('整数超出安全范围');
        return value;
      }
      default:
        fail('非法的类型字节（保留的 additional info）');
    }
  }

  private readByte(): number {
    if (this.pos >= this.bytes.length) fail('数据不完整');
    return this.bytes[this.pos++]!;
  }

  private readRaw16(): number {
    return (this.readByte() << 8) | this.readByte();
  }

  private readRaw32(): number {
    return this.readByte() * 0x1000000
      + (this.readByte() << 16)
      + (this.readByte() << 8)
      + this.readByte();
  }

  private readBytes(length: number): Uint8Array {
    if (length > this.bytes.length - this.pos) fail('数据不完整');
    const slice = this.bytes.subarray(this.pos, this.pos + length);
    this.pos += length;
    return slice;
  }
}

/** IEEE 754 半精度（不用 DataView.getFloat16，避免依赖运行时版本） */
function decodeFloat16(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * fraction * 2 ** -24;
  if (exponent === 31) return fraction ? Number.NaN : sign * Number.POSITIVE_INFINITY;
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}

/**
 * 解码一份 CBOR 文档。
 *
 * @throws 输入为空/超限、含不支持的结构（不定长度、标签、字节串、超界整数、
 *         非法 UTF-8）、数据截断或尾部有多余字节时抛 Error。
 */
export function decodeLimitedCbor(bytes: Uint8Array, limits?: CborDecodeLimits): unknown {
  if (!(bytes instanceof Uint8Array)) fail('输入必须是 Uint8Array');
  if (bytes.byteLength === 0) fail('数据为空');

  const effective: Required<CborDecodeLimits> = { ...DEFAULT_LIMITS, ...limits };
  if (bytes.byteLength > effective.maxInputBytes) fail('超出输入长度上限');

  const reader = new Reader(bytes, effective);
  const value = reader.readItem(0);
  if (!reader.done()) fail('数据尾部有多余字节');
  return value;
}
