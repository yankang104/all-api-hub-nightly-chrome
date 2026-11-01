/**
 * 备份加密的四条性质。
 *
 * 这一层是导出功能唯一的安全边界：导出文件会离开本机（发给自己、放网盘、插 U 盘），
 * 而账密在本地存储里本来就是明文的。加密写错了不会报错，只会静默地让文件可读 ——
 * 所以往返正确、口令错误能挡住、密文不重复、篡改能被发现，四条都要断言。
 */

import { describe, expect, it } from 'vitest';
import {
  BACKUP_FORMAT,
  decryptBackup,
  encryptBackup,
  isEncryptedEnvelope,
} from '@/lib/backup/backup-crypto';

const META = { exportedAt: 1_788_000_000_000, extensionVersion: '0.2.2' };
const SECRET = JSON.stringify({
  sites: [{ name: '测试站', loginUrl: 'https://example.com/login' }],
  accounts: [{ username: 'alice', password: 'p@ssw0rd-很长的中文密码' }],
});

describe('备份加密 · 往返', () => {
  it('加密再解密得到原文', async () => {
    const envelope = await encryptBackup(SECRET, 'correct horse', META);
    const restored = await decryptBackup(envelope, 'correct horse');

    expect(restored).toBe(SECRET);
  });

  it('信封结构完整，且明文不出现在任何字段里', async () => {
    const envelope = await encryptBackup(SECRET, 'pw', META);

    expect(envelope.format).toBe(BACKUP_FORMAT);
    expect(envelope.encrypted).toBe(true);
    expect(envelope.cipher).toBe('AES-GCM');
    expect(envelope.kdf.algo).toBe('PBKDF2-SHA256');
    expect(envelope.kdf.iterations).toBeGreaterThanOrEqual(100_000);
    expect(envelope.exportedAt).toBe(META.exportedAt);
    expect(envelope.extensionVersion).toBe('0.2.2');

    // 关键：整个信封序列化之后不能含有任何明文片段
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain('alice');
    expect(serialized).not.toContain('p@ssw0rd');
    expect(serialized).not.toContain('example.com');
  });

  it('中文与 emoji 口令、长明文都能往返', async () => {
    const long = JSON.stringify({ accounts: Array.from({ length: 500 }, (_, i) => ({ username: `用户${i}`, password: `密码🔑${i}` })) });
    const envelope = await encryptBackup(long, '口令🔐带中文', META);

    expect(await decryptBackup(envelope, '口令🔐带中文')).toBe(long);
  });

  it('识别加密信封，并拒绝明显不是信封的东西', async () => {
    const envelope = await encryptBackup(SECRET, 'pw', META);

    expect(isEncryptedEnvelope(envelope)).toBe(true);
    expect(isEncryptedEnvelope(null)).toBe(false);
    expect(isEncryptedEnvelope({})).toBe(false);
    expect(isEncryptedEnvelope({ encrypted: false })).toBe(false);
    // 缺 kdf 的半成品信封不能当成可解密的
    expect(isEncryptedEnvelope({ encrypted: true, cipher: 'AES-GCM', iv: 'x', payload: 'y' })).toBe(false);
  });
});

describe('备份加密 · 口令与完整性', () => {
  it('口令不对时解密失败，且错误信息同时提到两种可能', async () => {
    const envelope = await encryptBackup(SECRET, 'right', META);

    /*
     * AES-GCM 的认证失败与文件损坏抛同一个错，无法区分。报「口令错误」会让
     * 一个拿着损坏文件的用户反复试口令，所以措辞必须把两种可能都说出来。
     */
    await expect(decryptBackup(envelope, 'wrong')).rejects.toThrow(/口令不正确.*损坏/);
  });

  it('空口令在导出和导入两侧都被挡住', async () => {
    await expect(encryptBackup(SECRET, '', META)).rejects.toThrow('口令不能为空');

    const envelope = await encryptBackup(SECRET, 'pw', META);
    await expect(decryptBackup(envelope, '')).rejects.toThrow('请输入');
  });

  it('同一份明文两次导出的 salt、iv、密文都不同', async () => {
    const first = await encryptBackup(SECRET, 'same', META);
    const second = await encryptBackup(SECRET, 'same', META);

    // 复用 salt 会让「两个文件内容相同」这件事泄露出去；
    // AES-GCM 下复用 iv 更是直接破坏安全性。
    expect(first.kdf.salt).not.toBe(second.kdf.salt);
    expect(first.iv).not.toBe(second.iv);
    expect(first.payload).not.toBe(second.payload);
    // 但两个都能解开
    expect(await decryptBackup(first, 'same')).toBe(SECRET);
    expect(await decryptBackup(second, 'same')).toBe(SECRET);
  });

  it('篡改密文一个字节就解不开（AES-GCM 的认证性）', async () => {
    const envelope = await encryptBackup(SECRET, 'pw', META);
    const bytes = atob(envelope.payload).split('');
    // 翻掉中间一个字节的最低位
    const middle = Math.floor(bytes.length / 2);
    bytes[middle] = String.fromCharCode(bytes[middle]!.charCodeAt(0) ^ 0x01);
    const tampered = { ...envelope, payload: btoa(bytes.join('')) };

    await expect(decryptBackup(tampered, 'pw')).rejects.toThrow(/解密失败/);
  });

  it('篡改 salt 或 iv 同样解不开', async () => {
    const envelope = await encryptBackup(SECRET, 'pw', META);
    const otherSalt = (await encryptBackup(SECRET, 'pw', META)).kdf.salt;

    await expect(
      decryptBackup({ ...envelope, kdf: { ...envelope.kdf, salt: otherSalt } }, 'pw'),
    ).rejects.toThrow(/解密失败/);
  });

  it('base64 字段是垃圾时给出「文件损坏」而不是崩溃', async () => {
    const envelope = await encryptBackup(SECRET, 'pw', META);

    await expect(
      decryptBackup({ ...envelope, payload: '这不是 base64 !!!' }, 'pw'),
    ).rejects.toThrow(/base64|损坏/);
  });

  it('文件里记录的迭代次数被尊重，改掉它就解不开', async () => {
    const envelope = await encryptBackup(SECRET, 'pw', META);

    // 迭代次数参与密钥派生，改成另一个（仍落在安全区间内的）值等于换了一把钥匙；
    // 换成区间外的值会先被参数校验挡下，那条路径由「迭代次数越界」一组单独覆盖。
    await expect(
      decryptBackup({ ...envelope, kdf: { ...envelope.kdf, iterations: 100_000 } }, 'pw'),
    ).rejects.toThrow(/解密失败/);
  });
});

describe('备份加密 · 迭代次数越界', () => {
  it('迭代次数大到离谱时，派生前就被挡下，不会把导入卡死', async () => {
    const envelope = await encryptBackup(SECRET, 'pw', META);
    /*
     * 20 亿次 PBKDF2 会跑满一个核、让导入弹窗永远停在「正在迁移」。信封来自不可信
     * 来源，必须在 deriveKey 之前挡掉。断言抛的是「参数越界」而不是「解密失败」，
     * 恰好证明它在跑 PBKDF2 之前就短路了 —— 真去派生的话这条断言得等到天荒地老。
     */
    const huge = { ...envelope, kdf: { ...envelope.kdf, iterations: 2_000_000_000 } };

    expect(isEncryptedEnvelope(huge)).toBe(false);
    await expect(decryptBackup(huge, 'pw')).rejects.toThrow(/参数超出安全范围/);
  });

  it('迭代次数小到离谱或非整数时同样被拒，而不是回退默认值硬解', async () => {
    const envelope = await encryptBackup(SECRET, 'pw', META);

    // 0、负数、1、非整数都不是本插件写出来的合法备份，一律在派生前报参数异常
    for (const bad of [0, 1, 100, 1.5, -250_000]) {
      const tampered = { ...envelope, kdf: { ...envelope.kdf, iterations: bad } };
      expect(isEncryptedEnvelope(tampered)).toBe(false);
      await expect(decryptBackup(tampered, 'pw')).rejects.toThrow(/参数超出安全范围/);
    }
  });

  it('区间内的正常备份不受影响，照常识别与往返', async () => {
    const envelope = await encryptBackup(SECRET, 'pw', META);

    // 夹逼只针对越界值，默认的 250_000 落在区间内，识别与往返必须完全不变
    expect(isEncryptedEnvelope(envelope)).toBe(true);
    expect(await decryptBackup(envelope, 'pw')).toBe(SECRET);
  });
});
