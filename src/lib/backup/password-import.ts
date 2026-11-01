import type { Account, SiteConfig } from '@/types';

export interface ChromePasswordCredential {
  id: string;
  name: string;
  url: string;
  username: string;
  password: string;
  host: string;
}

export type PasswordMatchKind =
  | 'matched'
  | 'manual'
  | 'ambiguous'
  | 'unmatched'
  | 'existing'
  | 'duplicate'
  | 'invalid';

export interface PasswordMatch {
  credential: ChromePasswordCredential;
  kind: PasswordMatchKind;
  siteId?: string;
  candidateSiteIds: string[];
}

export function parseChromePasswordCsv(text: string): ChromePasswordCredential[] {
  const table = parseCsv(text);
  if (table.length < 2) throw new Error('CSV 中没有可导入的密码记录');

  const headerRow = table[0];
  if (!headerRow) throw new Error('CSV 缺少表头');
  const headers = headerRow.map((value, index) =>
    (index === 0 ? value.replace(/^\uFEFF/, '') : value).trim().toLowerCase(),
  );
  const required = ['name', 'url', 'username', 'password'] as const;
  const indexes = Object.fromEntries(required.map((name) => [name, headers.indexOf(name)])) as Record<
    (typeof required)[number],
    number
  >;
  const missing = required.filter((name) => indexes[name] < 0);
  if (missing.length > 0) throw new Error(`不是 Chrome 密码 CSV，缺少列：${missing.join(', ')}`);

  return table
    .slice(1)
    .filter((row) => row.some((value) => value.trim().length > 0))
    .map((row, index) => {
      const url = row[indexes.url]?.trim() ?? '';
      return {
        id: `password-${index + 1}`,
        name: row[indexes.name]?.trim() ?? '',
        url,
        username: row[indexes.username]?.trim() ?? '',
        password: row[indexes.password] ?? '',
        host: hostOfPasswordUrl(url),
      };
    });
}

export function matchChromePasswords(
  credentials: ChromePasswordCredential[],
  sites: SiteConfig[],
  accounts: Account[],
): PasswordMatch[] {
  const sitesByHost = new Map<string, SiteConfig[]>();
  for (const site of sites) {
    const host = hostOfPasswordUrl(site.loginUrl);
    if (!host) continue;
    sitesByHost.set(host, [...(sitesByHost.get(host) ?? []), site]);
  }

  const existing = new Set(accounts.map((account) => passwordAccountKey(account.siteId, account.username)));
  const seen = new Set<string>();

  return credentials.map((credential) => {
    if (!credential.host || !credential.username || !credential.password) {
      return { credential, kind: 'invalid', candidateSiteIds: [] };
    }

    const candidates = sitesByHost.get(credential.host) ?? [];
    const candidateSiteIds = candidates.map((site) => site.id);
    if (candidates.length === 0) {
      return { credential, kind: 'unmatched', candidateSiteIds };
    }
    if (candidates.length > 1) {
      return { credential, kind: 'ambiguous', candidateSiteIds };
    }

    const [candidate] = candidates;
    if (!candidate) return { credential, kind: 'unmatched', candidateSiteIds };
    const siteId = candidate.id;
    const key = passwordAccountKey(siteId, credential.username);
    if (existing.has(key)) {
      return { credential, siteId, kind: 'existing', candidateSiteIds };
    }
    if (seen.has(key)) {
      return { credential, siteId, kind: 'duplicate', candidateSiteIds };
    }
    seen.add(key);
    return { credential, siteId, kind: 'matched', candidateSiteIds };
  });
}

export function passwordAccountKey(siteId: string, username: string): string {
  return `${siteId}\u0000${username.trim().toLowerCase()}`;
}

export function hostOfPasswordUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    return host.startsWith('www.') ? host.slice(4) : host;
  } catch {
    return '';
  }
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && field.length === 0) {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      if (char === '\r' && text[index + 1] === '\n') index += 1;
    } else {
      field += char;
    }
  }

  if (quoted) throw new Error('CSV 中存在未闭合的引号');
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
