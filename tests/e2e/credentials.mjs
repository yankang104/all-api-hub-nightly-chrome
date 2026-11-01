/**
 * 从 Chrome 导出的密码 CSV 里取指定域名的凭据。
 *
 * ⚠️ 安全约定：这个模块只把凭据交给需要它的自动化流程，
 * 绝不打印密码本身。所有日志只输出域名和用户名。
 *
 * CSV 刻意放在**项目目录之外**，避免误入库、也避免将来 WebDAV
 * 同步把明文推到远端。用 CHECKIN_CREDENTIALS_CSV 环境变量可覆盖路径。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_CSV = join(ROOT, '..', '_凭据_勿入库', 'Chrome 密码.csv');
const CSV = process.env.CHECKIN_CREDENTIALS_CSV ?? DEFAULT_CSV;

/** 解析一行 CSV，处理引号包裹和转义 */
function parseLine(line) {
  const out = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQuote = false;
      else cur += c;
    } else if (c === '"') inQuote = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/**
 * 取某域名下的所有凭据。
 * @param {string} domainPattern 域名关键词（如 'agentrouter'）
 * @returns {{name:string,url:string,username:string,password:string}[]}
 */
export function credentialsFor(domainPattern) {
  const re = new RegExp(domainPattern, 'i');
  const lines = readFileSync(CSV, 'utf8').split('\n').filter((l) => l.trim());
  const header = parseLine(lines[0]).map((h) => h.trim());
  const iName = header.indexOf('name');
  const iUrl = header.indexOf('url');
  const iUser = header.indexOf('username');
  const iPass = header.indexOf('password');

  return lines
    .slice(1)
    .map(parseLine)
    .filter((f) => re.test(f[iName] ?? '') || re.test(f[iUrl] ?? ''))
    .map((f) => ({
      name: f[iName],
      url: f[iUrl],
      username: f[iUser],
      password: f[iPass],
    }))
    .filter((c) => c.username && c.password);
}

/** 只输出域名和用户名，用于日志 */
export function describe(cred) {
  return `${cred.name} / ${cred.username}`;
}
