/**
 * 备份文件的口令加密。
 *
 * 账密在 `chrome.storage.local` 里是明文的（见 storage.ts 的加密 TODO），但导出
 * 文件会离开本机 —— 发给自己、放网盘、插 U 盘，每一步都可能被别人读到。所以导出
 * 这一层必须自己加密，不能等本地存储加密做完。两件事没有依赖关系。
 *
 * PBKDF2-SHA256 派生密钥 + AES-GCM 加密。AES-GCM 自带认证，文件被改过一个字节
 * 解密就会失败，不需要另外存校验和。
 */

/** 密钥派生的迭代次数。写进文件，将来调高不会让旧备份读不出来。 */
const PBKDF2_ITERATIONS = 250_000;
/**
 * 迭代次数是唯一「写进文件、又要在解密前喂给 PBKDF2」的数字，而信封来自不可信来源
 * （备份就是拿来互相传的）。攻击者把它填成 20 亿甚至 1e21，deriveKey 会在任何解密
 * 之前先按这个次数跑满一个 CPU 核，导入弹窗就永远停在「正在迁移」。所以派生前必须
 * 先把它夹在合理区间里：
 * - 上限取默认值的小倍数，默认将来调高时上限自动跟着放宽，不会把新备份挡在外面；
 * - 下限用固定地板、不跟着默认值走 —— 默认只会往上调，老备份记录的次数只会更低，
 *   下限跟着涨反而会把合法老备份读不出来；地板只需挡住 0、负数、1 这类明显不是本
 *   插件写出来的垃圾值。
 */
const MAX_PBKDF2_ITERATIONS = PBKDF2_ITERATIONS * 10;
const MIN_PBKDF2_ITERATIONS = 10_000;
const SALT_BYTES = 16;
/** AES-GCM 的 IV 规范推荐 96 位。 */
const IV_BYTES = 12;

export const BACKUP_FORMAT = 'aah-backup-v1';

export interface BackupKdfParams {
  algo: 'PBKDF2-SHA256';
  iterations: number;
  salt: string;
}

export interface EncryptedEnvelope {
  format: typeof BACKUP_FORMAT;
  exportedAt: number;
  extensionVersion?: string;
  encrypted: true;
  kdf: BackupKdfParams;
  cipher: 'AES-GCM';
  iv: string;
  payload: string;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  // 分块避免 String.fromCharCode 在大数组上爆栈；备份文件可能有几百 KB。
  const CHUNK = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as unknown as BufferSource,
      iterations,
      hash: 'SHA-256',
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * 迭代次数必须是落在安全区间内的整数，否则要么是拖垮 CPU 的 DoS 载荷、要么根本不是
 * 本插件写出来的备份。isEncryptedEnvelope 与 decryptBackup 都靠它在 deriveKey 之前把关。
 */
function isSaneIterations(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= MIN_PBKDF2_ITERATIONS
    && value <= MAX_PBKDF2_ITERATIONS;
}

export function isEncryptedEnvelope(value: unknown): value is EncryptedEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<EncryptedEnvelope>;
  return candidate.encrypted === true
    && candidate.cipher === 'AES-GCM'
    && typeof candidate.iv === 'string'
    && typeof candidate.payload === 'string'
    && typeof candidate.kdf === 'object'
    && candidate.kdf !== null
    && candidate.kdf.algo === 'PBKDF2-SHA256'
    && isSaneIterations(candidate.kdf.iterations)
    && typeof candidate.kdf.salt === 'string';
}

export async function encryptBackup(
  plaintext: string,
  passphrase: string,
  meta: { exportedAt: number; extensionVersion?: string },
): Promise<EncryptedEnvelope> {
  if (!passphrase) throw new Error('导出口令不能为空');
  // salt 与 iv 每次都重新随机：复用会让同一份数据两次导出的密文相同，
  // 泄露「这两个文件内容一样」这个信息，AES-GCM 下复用 iv 更是直接破坏安全性。
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
  const cipherText = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    key,
    new TextEncoder().encode(plaintext),
  );

  return {
    format: BACKUP_FORMAT,
    exportedAt: meta.exportedAt,
    ...(meta.extensionVersion ? { extensionVersion: meta.extensionVersion } : {}),
    encrypted: true,
    kdf: { algo: 'PBKDF2-SHA256', iterations: PBKDF2_ITERATIONS, salt: toBase64(salt) },
    cipher: 'AES-GCM',
    iv: toBase64(iv),
    payload: toBase64(new Uint8Array(cipherText)),
  };
}

export async function decryptBackup(
  envelope: EncryptedEnvelope,
  passphrase: string,
): Promise<string> {
  if (!passphrase) throw new Error('请输入导出时设置的口令');
  // 越界的迭代次数必须在 deriveKey 之前挡掉：太大的会让 PBKDF2 跑满一个核、把导入
  // 卡死在「正在迁移」，太小或非整数则不是本插件写出来的合法备份。这里不再回退到默认
  // 值硬解（那会白跑一次派生还给不出有用的错），直接报参数异常。
  if (!isSaneIterations(envelope.kdf.iterations)) {
    throw new Error('备份文件参数超出安全范围，可能不是本插件导出的文件或已被篡改');
  }
  const iterations = envelope.kdf.iterations;

  let salt: Uint8Array;
  let iv: Uint8Array;
  let payload: Uint8Array;
  try {
    salt = fromBase64(envelope.kdf.salt);
    iv = fromBase64(envelope.iv);
    payload = fromBase64(envelope.payload);
  } catch {
    throw new Error('备份文件的加密字段不是有效的 base64，文件可能已损坏');
  }

  const key = await deriveKey(passphrase, salt, iterations);
  let plainBuffer: ArrayBuffer;
  try {
    plainBuffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource },
      key,
      payload as unknown as BufferSource,
    );
  } catch {
    /*
     * AES-GCM 的认证失败与「文件被改坏」抛的是同一个 OperationError，
     * 无法区分。措辞上必须把两种可能都说出来，不能假装知道是哪一种 ——
     * 报「口令错误」会让一个损坏文件的用户反复试口令。
     */
    throw new Error('解密失败：口令不正确，或备份文件已损坏');
  }
  return new TextDecoder().decode(plainBuffer);
}
