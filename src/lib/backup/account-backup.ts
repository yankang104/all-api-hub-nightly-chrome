/**
 * 账号备份的序列化与导入规划。
 *
 * 只做数据变形，不碰加密（`backup-crypto.ts`）也不碰存储（`app-repository.ts`）。
 *
 * ## 为什么账号要按 loginUrl 重挂而不是照搬 siteId
 *
 * `Account.siteId` 指向 `SiteConfig.id`，而它是 `uid('st')` 随机生成的 —— 新电脑上
 * 导入同一个站点必然得到不同的 id。照搬 siteId 会让每个账号都变成孤儿（落进
 * `OrphanAccountsPanel`），用户看到的是「账号全都导进来了但一个都不能用」。
 *
 * 所以导出时给每个账号带上所属站点的 `loginUrl`，导入时按**归一化后的 URL** 重新
 * 匹配站点。附带好处是「新电脑上已经手动配过同一个站点」会自然合并，而不是重复建站。
 */

import type { Account, ProxyConfig, SiteConfig } from '@/types';
import { normalizedLoginUrl } from '@/sites';
import { normalizeProxyName, proxyEndpointKey } from '@/lib/proxy/proxy-upgrade';
import { BACKUP_FORMAT } from '@/lib/backup/backup-crypto';

/**
 * 导出的账号：去掉本机专属字段，换成按 loginUrl 定位站点。
 *
 * `proxyId` 换成 `proxyName` —— 代理 id 与站点 id 一样是随机生成的，跨机器无意义。
 */
export interface BackupAccount extends Omit<Account, 'id' | 'siteId' | 'proxyId' | 'migrationSourceId'> {
  /** 账号在导出来源中的稳定标识，用于重复迁移时只跳过真正的同一条记录。 */
  backupAccountKey?: string;
  /** 所属站点在导出来源中的稳定标识，同 URL 的重复站点靠它区分。 */
  backupSiteKey?: string;
  /** 所属站点的登录页地址，导入时用它重新匹配 siteId。 */
  siteLoginUrl: string;
  /** proxyMode='pool' 时绑定的代理节点名，导入时按名字重新匹配 proxyId。 */
  proxyName?: string;
}

/** 导出的站点：同样把 proxyId 换成节点名。 */
export interface BackupSite extends Omit<SiteConfig, 'id' | 'proxyId' | 'migrationSourceId'> {
  /** 站点在导出来源中的稳定标识；不是目标电脑上的 siteId。 */
  backupSiteKey?: string;
  proxyName?: string;
}

export interface BackupPayload {
  format: typeof BACKUP_FORMAT;
  /** 用户自建站点，以及对内置站点的覆盖。 */
  sites: BackupSite[];
  accounts: BackupAccount[];
  /**
   * 代理池。
   *
   * 端口是**本机** Clash 的，新电脑上很可能不同 —— 导入后必须重新「同步配置」
   * 并测活。但节点名是稳定的，所以账号/站点的绑定能按名字恢复：用户重新同步
   * 一份 listener 配置之后，同名节点会被 `planProxyUpgrade` 原地补上真实端口，
   * 绑定自动复活。这正是不导出代理池时做不到的事 —— 那样几十个账号的代理绑定
   * 全部丢失，要手工重配。
   */
  proxies: Omit<ProxyConfig, 'id'>[];
  /**
   * 端口映射与订阅源。跨机器恢复的关键:
   * 新电脑导入备份后,只要粘一次 Script,端口与节点名的对应关系与旧机完全一致,
   * 账号绑定(按名字恢复)也就跟着成立 —— 不需要在新机器上重新分配。
   */
  listenerPlan?: { nodeName: string; port: number; listenerName: string }[];
  subscriptionUrl?: string;
}

export interface ImportPlan {
  /** 需要新建的站点（新电脑上没有匹配的 loginUrl）。 */
  newSites: Omit<SiteConfig, 'id'>[];
  /** 与 newSites 同下标的迁移来源标识。 */
  newSiteKeys: string[];
  /** 已存在、直接复用的站点数。 */
  reusedSiteCount: number;
  /** 可以导入的账号，siteId 已按 loginUrl 解析到本机的实际站点。 */
  accounts: Omit<Account, 'id'>[];
  /** 根据来源 id 判断为已经导入过的账号数；同站同名但来源不同不会计入。 */
  duplicateCount: number;
  /**
   * 找不到对应站点的账号。
   *
   * 出现在「导出文件里的站点被用户在新电脑上删过」这类情况。必须报出来而不是
   * 静默丢弃 —— 否则用户以为全导进来了，实际少了几个。
   */
  unmatched: Array<{ username: string; siteLoginUrl: string }>;
  /**
   * 备份里携带的端口映射与订阅源（跨机器恢复用）。
   * 落地时写回 storage,新机器上粘一次 Script 即可复现同样的「节点→端口」。
   */
  listenerPlan?: { nodeName: string; port: number; listenerName: string }[];
  subscriptionUrl?: string;
  /** 需要新建的代理节点（本机没有同名、也没有同端口的）。 */
  newProxies: Omit<ProxyConfig, 'id'>[];
  /** 本机已有、直接复用的代理数。 */
  reusedProxyCount: number;
  /**
   * 新建站点的代理绑定：归一化 loginUrl → 代理节点名。
   *
   * 站点是 `addSites` 之后才有 id 的，所以它的 proxyId 只能在落地后补 ——
   * 见 `resolveSiteProxyBindings`。
   */
  siteProxyNames: Array<{ siteSourceId?: string; siteId?: string; loginUrlKey: string; proxyName: string }>;
  /**
   * 备份里带代理绑定、但本次导入后仍找不到对应节点的账号数。
   *
   * 这些账号会以 `proxyMode: 'inherit'`（跟随站点）落地，而不是留一个指向不存在
   * 节点的 id —— 后者会让签到直接失败在「账号配置的代理已不存在」。
   */
  unresolvedProxyBindings: number;
}

/**
 * 剥掉不该跨机器带走的字段。
 *
 *  - `identity.session`：抓取的登录会话与原浏览器绑定，access token 只活几分钟，
 *    refresh token 也大概率已失效。带过去只会让用户以为还能用，跳过「抓取登录态」
 *    这一步，然后签到失败在一个看不懂的地方。
 *  - `proxyId` → `proxyName`：代理 id 是随机生成的，跨机器无意义；节点名才是稳定的。
 *  - `customProxy.password`：代理认证密码不进备份文件。地址本身保留 —— 那是用户
 *    手填的配置，丢了要重新查；密码则可以在新电脑上补填。
 */
function stripAccount(
  account: Account,
  siteLoginUrl: string,
  backupSiteKey: string,
  proxyNameById: ReadonlyMap<string, string>,
): BackupAccount {
  const {
    id: _id,
    siteId: _siteId,
    migrationSourceId,
    proxyId,
    identity,
    customProxy,
    ...rest
  } = account;

  const cleanIdentity = identity ? { ...identity } : undefined;
  if (cleanIdentity) delete cleanIdentity.session;

  const proxyName = proxyId ? proxyNameById.get(proxyId) : undefined;

  return {
    ...rest,
    backupAccountKey: migrationSourceId ?? account.id,
    backupSiteKey,
    siteLoginUrl,
    ...(proxyName ? { proxyName } : {}),
    ...(customProxy
      ? { customProxy: { ...customProxy, password: undefined } as Account['customProxy'] }
      : {}),
    ...(cleanIdentity && Object.keys(cleanIdentity).length > 0 ? { identity: cleanIdentity } : {}),
  };
}

export function buildBackupPayload(
  sites: readonly SiteConfig[],
  accounts: readonly Account[],
  proxies: readonly ProxyConfig[] = [],
  listenerPlan: readonly { nodeName: string; port: number; listenerName: string }[] = [],
  subscriptionUrl?: string,
): BackupPayload {
  const siteById = new Map(sites.map((site) => [site.id, site]));
  const proxyNameById = new Map(proxies.map((proxy) => [proxy.id, proxy.name]));

  const exportedSites: BackupSite[] = sites.map((site) => {
    const { id: _id, migrationSourceId, proxyId, ...rest } = site;
    const proxyName = proxyId ? proxyNameById.get(proxyId) : undefined;
    return {
      ...rest,
      backupSiteKey: migrationSourceId ?? site.id,
      ...(proxyName ? { proxyName } : {}),
    };
  });

  const exportedAccounts: BackupAccount[] = [];
  for (const account of accounts) {
    const site = siteById.get(account.siteId);
    // 孤儿账号（站点已删）没有可用的定位键，导出它无法在对面重挂
    if (!site) continue;
    exportedAccounts.push(stripAccount(
      account,
      site.loginUrl,
      site.migrationSourceId ?? site.id,
      proxyNameById,
    ));
  }

  /*
   * 代理凭据不进备份文件，但节点名、地址、端口要留 —— 它们是恢复绑定的键，
   * 也是用户判断「这批出口对不对」的依据。认证密码在新电脑上补填即可。
   */
  const exportedProxies = proxies.map((proxy) => {
    const { id: _id, password: _password, ...rest } = proxy;
    return rest;
  });

  return {
    format: BACKUP_FORMAT,
    sites: exportedSites,
    accounts: exportedAccounts,
    proxies: exportedProxies,
    ...(listenerPlan.length ? { listenerPlan: [...listenerPlan] } : {}),
    ...(subscriptionUrl ? { subscriptionUrl } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 结构校验。
 *
 * 不认识的 `format` 直接拒绝，不做猜测解析 —— 一个字段含义变了的旧文件被当成新格式
 * 读进来，产生的是看起来正常的错数据，比读不出来难查得多。
 */
export function parseBackupPayload(raw: unknown): BackupPayload {
  if (!isRecord(raw)) throw new Error('备份内容不是一个对象');
  if (raw.format !== BACKUP_FORMAT) {
    throw new Error(
      typeof raw.format === 'string'
        ? `不支持的备份格式「${raw.format}」，当前扩展只能读取 ${BACKUP_FORMAT}`
        : `备份文件缺少 format 标记，无法确认它是 ${BACKUP_FORMAT} 格式`,
    );
  }
  if (!Array.isArray(raw.sites) || !Array.isArray(raw.accounts)) {
    throw new Error('备份内容缺少 sites 或 accounts 列表');
  }

  const sites = raw.sites.filter((site): site is BackupSite => (
    isRecord(site) && typeof site.loginUrl === 'string' && typeof site.name === 'string'
  ));
  const accounts = raw.accounts.filter((account): account is BackupAccount => (
    isRecord(account)
    && typeof account.siteLoginUrl === 'string'
    && typeof account.username === 'string'
  ));
  // proxies 是后加的字段，旧备份没有 —— 缺失按空数组处理，不能因此拒绝整个文件
  const proxies: Omit<ProxyConfig, 'id'>[] = Array.isArray(raw.proxies)
    ? raw.proxies.flatMap((proxy) => {
        if (!isRecord(proxy)
          || typeof proxy.name !== 'string'
          || typeof proxy.host !== 'string'
          || typeof proxy.scheme !== 'string') return [];
        const rawScheme = proxy.scheme.trim().toLowerCase();
        const scheme: ProxyConfig['scheme'] | undefined = rawScheme === 'socks'
          ? 'socks5'
          : rawScheme === 'mixed'
            ? 'http'
            : rawScheme === 'http' || rawScheme === 'https' || rawScheme === 'socks4' || rawScheme === 'socks5'
              ? rawScheme
              : undefined;
        const port = Number(proxy.port);
        const nameOnly = proxy.nameOnly === true;
        if (!scheme || (!nameOnly && (!Number.isInteger(port) || port < 1 || port > 65535))) return [];
        return [{
          ...proxy,
          name: proxy.name,
          host: proxy.host.trim().replace(/^\[|\]$/g, ''),
          scheme,
          port: nameOnly ? 0 : port,
        } as Omit<ProxyConfig, 'id'>];
      })
    : [];

  /*
   * 空备份判定。listenerPlan / subscriptionUrl 也算「有内容」：
   * 用户可能只配好了端口映射与订阅源就导出（还没入池或池子被清空），
   * 这份文件在新机器上依然是有价值的配置，不该被当成空文件拒收。
   * 下面 parse 出来的 listenerPlan/subscriptionUrl 变量在守卫之前已就绪。
   */
  const hasPlan = Array.isArray((raw as { listenerPlan?: unknown }).listenerPlan)
    && ((raw as { listenerPlan: unknown[] }).listenerPlan.length > 0);
  const hasSource = typeof (raw as { subscriptionUrl?: unknown }).subscriptionUrl === 'string'
    && Boolean((raw as { subscriptionUrl: string }).subscriptionUrl.trim());
  if (!sites.length && !accounts.length && !proxies.length && !hasPlan && !hasSource) {
    throw new Error('备份文件里没有可导入的站点、账号或代理');
  }
  // listenerPlan / subscriptionUrl 是后加字段：旧备份没有，缺失即省略，
  // 不能因此拒绝整个文件(否则老用户的备份突然导不进来)。
  const listenerPlan = Array.isArray((raw as { listenerPlan?: unknown }).listenerPlan)
    ? ((raw as { listenerPlan: unknown[] }).listenerPlan.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const record = item as { nodeName?: unknown; port?: unknown };
        const nodeName = typeof record.nodeName === 'string' ? record.nodeName.trim() : '';
        const port = Number(record.port);
        if (!nodeName || !Number.isInteger(port) || port < 1 || port > 65535) return [];
        return [{ nodeName, port, listenerName: `hub-${port}` }];
      }))
    : undefined;
  const subscriptionUrl = typeof (raw as { subscriptionUrl?: unknown }).subscriptionUrl === 'string'
    ? (raw as { subscriptionUrl: string }).subscriptionUrl.trim() || undefined
    : undefined;

  return {
    format: BACKUP_FORMAT,
    sites,
    accounts,
    proxies,
    ...(listenerPlan?.length ? { listenerPlan } : {}),
    ...(subscriptionUrl ? { subscriptionUrl } : {}),
  };
}

/**
 * 规划一次导入：算出要新建哪些站点、哪些账号能挂上、哪些挂不上。
 *
 * 只计算不写入 —— 界面要先把结果给用户看，确认后才落地。
 */
export function planBackupImport(
  payload: BackupPayload,
  existingSites: readonly SiteConfig[],
  existingAccounts: readonly Account[],
  existingProxies: readonly ProxyConfig[] = [],
): ImportPlan {
  // 新备份优先按来源 id 一一对应；旧备份没有来源 id 时，再按 URL 和出现顺序配对。
  // 这样同一个 URL 的两张站点卡不会被压成一张。
  const siteIdBySource = new Map<string, string>();
  const siteIdsByUrl = new Map<string, string[]>();
  for (const site of existingSites) {
    siteIdBySource.set(site.migrationSourceId ?? site.id, site.id);
    const key = normalizedLoginUrl(site.loginUrl);
    siteIdsByUrl.set(key, [...(siteIdsByUrl.get(key) ?? []), site.id]);
  }

  const newSites: Omit<SiteConfig, 'id'>[] = [];
  const newSiteKeys: string[] = [];
  const claimedSiteIds = new Set<string>();
  const siteTargetBySource = new Map<string, string>();
  const siteTargetsByUrl = new Map<string, string[]>();
  const legacySiteOccurrences = new Map<string, number>();
  const siteProxyNames: ImportPlan['siteProxyNames'] = [];
  let reusedSiteCount = 0;
  for (const site of payload.sites) {
    const key = normalizedLoginUrl(site.loginUrl);
    const occurrence = legacySiteOccurrences.get(key) ?? 0;
    legacySiteOccurrences.set(key, occurrence + 1);
    const sourceId = site.backupSiteKey?.trim() || `legacy-site:${key}:${occurrence}`;
    let targetSiteId = siteIdBySource.get(sourceId);
    if (targetSiteId) claimedSiteIds.add(targetSiteId);

    if (!targetSiteId) {
      targetSiteId = (siteIdsByUrl.get(key) ?? []).find((siteId) => !claimedSiteIds.has(siteId));
      if (targetSiteId) claimedSiteIds.add(targetSiteId);
    }

    const { backupSiteKey: _backupSiteKey, proxyName, ...siteFields } = site;
    if (targetSiteId) {
      reusedSiteCount += 1;
      siteTargetBySource.set(sourceId, targetSiteId);
    } else {
      targetSiteId = `pending-site:${sourceId}`;
      siteTargetBySource.set(sourceId, targetSiteId);
      newSiteKeys.push(sourceId);
      newSites.push({ ...siteFields, migrationSourceId: sourceId });
    }
    siteTargetsByUrl.set(key, [...(siteTargetsByUrl.get(key) ?? []), targetSiteId]);
    if (proxyName) {
      siteProxyNames.push({
        ...(targetSiteId.startsWith('pending-site:')
          ? { siteSourceId: sourceId }
          : { siteId: targetSiteId }),
        loginUrlKey: key,
        proxyName,
      });
    }
  }

  /*
   * 代理按**名字**和**出口端点**双键匹配。
   *
   * 名字是跨机器唯一稳定的键（Clash 节点名来自订阅，两台电脑一样）。端点键
   * 用现成的 `proxyEndpointKey` —— 它把本机回环出口按端口归一（localhost /
   * 127.0.0.1 / ::1 视为同一个，协议差异也忽略），正是「同一个 listener 端口
   * 被两次导入记成不同 scheme」这种情况需要的。
   *
   * 两个键都查是因为它们各自会漏：用户可能重命名过节点（名字变、端口没变），
   * 也可能重新同步过配置（名字没变、端口重排）。
   */
  const proxyIdByName = new Map<string, string>();
  const proxyIdByEndpoint = new Map<string, string>();
  /** 只有真实出口可以被账号/站点绑定，见 app-repository 的 assertUsableProxyId。 */
  const usableProxyIdByName = new Map<string, string>();
  for (const proxy of existingProxies) {
    proxyIdByName.set(normalizeProxyName(proxy.name), proxy.id);
    if (proxy.nameOnly !== true) {
      proxyIdByEndpoint.set(proxyEndpointKey(proxy), proxy.id);
      usableProxyIdByName.set(normalizeProxyName(proxy.name), proxy.id);
    }
  }

  const newProxies: Omit<ProxyConfig, 'id'>[] = [];
  /** 本次会新建的、且可被绑定（非 nameOnly）的节点名。 */
  const plannedUsableProxyNames = new Set<string>();
  const plannedProxyNames = new Set<string>();
  let reusedProxyCount = 0;
  for (const proxy of payload.proxies) {
    const nameKey = normalizeProxyName(proxy.name);
    const endpointKey = proxy.nameOnly !== true ? proxyEndpointKey(proxy) : undefined;
    if (proxyIdByName.has(nameKey) || (endpointKey && proxyIdByEndpoint.has(endpointKey))) {
      reusedProxyCount += 1;
      continue;
    }
    if (plannedProxyNames.has(nameKey)) continue; // 备份文件内部重复
    plannedProxyNames.add(nameKey);
    if (proxy.nameOnly !== true) plannedUsableProxyNames.add(nameKey);
    newProxies.push(proxy);
  }

  // 只按稳定来源 id 判定“已经导入过”。用户名相同不等于同一条账号记录；
  // 迁移必须宁可多保留一条，也不能因为同站同名就扔掉凭据。
  const existingAccountSources = new Set(
    existingAccounts.map((account) => account.migrationSourceId ?? account.id),
  );

  const accounts: Omit<Account, 'id'>[] = [];
  const unmatched: ImportPlan['unmatched'] = [];
  let duplicateCount = 0;
  let unresolvedProxyBindings = 0;
  const legacyAccountOccurrences = new Map<string, number>();
  for (const backup of payload.accounts) {
    const {
      siteLoginUrl,
      proxyName,
      backupAccountKey,
      backupSiteKey,
      ...fields
    } = backup;

    if (backupAccountKey && existingAccountSources.has(backupAccountKey)) {
      duplicateCount += 1;
      continue;
    }

    /*
     * 代理绑定：本机已有同名节点就直接挂上，本次会新建的则留占位符等落地。
     * 两者都不成立时**回落到 inherit**，绝不留一个指向不存在节点的 id ——
     * 那会让签到直接失败在「账号配置的代理已不存在」。
     */
    const proxyFields: Pick<Account, 'proxyMode' | 'proxyId'> = {};
    if (backup.proxyMode === 'pool' && proxyName) {
      const nameKey = normalizeProxyName(proxyName);
      // 只认真实出口：nameOnly 条目没有可用地址，写进去会被
      // assertUsableProxyId 拒绝，整批导入失败。
      const existingId = usableProxyIdByName.get(nameKey);
      if (existingId) {
        proxyFields.proxyMode = 'pool';
        proxyFields.proxyId = existingId;
      } else if (plannedUsableProxyNames.has(nameKey)) {
        proxyFields.proxyMode = 'pool';
        proxyFields.proxyId = `pending-proxy:${nameKey}`;
      } else {
        unresolvedProxyBindings += 1;
        proxyFields.proxyMode = 'inherit';
      }
    } else if (backup.proxyMode) {
      proxyFields.proxyMode = backup.proxyMode;
    }

    const key = normalizedLoginUrl(siteLoginUrl);
    const legacyOccurrence = legacyAccountOccurrences.get(key) ?? 0;
    legacyAccountOccurrences.set(key, legacyOccurrence + 1);
    const sourceTarget = backupSiteKey ? siteTargetBySource.get(backupSiteKey) : undefined;
    const siteId = sourceTarget
      ?? siteTargetsByUrl.get(key)?.[legacyOccurrence % Math.max(1, siteTargetsByUrl.get(key)?.length ?? 1)]
      ?? siteIdsByUrl.get(key)?.[0];
    if (!siteId) {
      unmatched.push({ username: backup.username, siteLoginUrl });
      continue;
    }
    accounts.push({
      ...fields,
      ...proxyFields,
      ...(backupAccountKey ? { migrationSourceId: backupAccountKey } : {}),
      siteId,
    });
  }

  return {
    newSites,
    newSiteKeys,
    reusedSiteCount,
    accounts,
    duplicateCount,
    unmatched,
    newProxies,
    reusedProxyCount,
    unresolvedProxyBindings,
    siteProxyNames,
    ...(payload.listenerPlan?.length ? { listenerPlan: payload.listenerPlan } : {}),
    ...(payload.subscriptionUrl ? { subscriptionUrl: payload.subscriptionUrl } : {}),
  };
}

/**
 * 站点与代理都落地之后，算出每个站点该绑哪个代理。
 *
 * 返回 `siteId → proxyId` 的补丁列表，交给调用方逐个 `updateSite`。找不到对应节点的
 * 直接跳过（站点保持不绑代理），不写一个坏 id 进去。
 */
export function resolveSiteProxyBindings(
  siteProxyNames: ImportPlan['siteProxyNames'],
  sites: readonly SiteConfig[],
  proxies: readonly ProxyConfig[],
): Array<{ siteId: string; proxyId: string }> {
  if (!siteProxyNames.length) return [];
  const siteIdByUrl = new Map<string, string>();
  const siteIdBySource = new Map<string, string>();
  for (const site of sites) {
    siteIdByUrl.set(normalizedLoginUrl(site.loginUrl), site.id);
    if (site.migrationSourceId) siteIdBySource.set(site.migrationSourceId, site.id);
  }
  const proxyIdByName = new Map<string, string>();
  for (const proxy of proxies) {
    // 只有真实出口能被绑定：nameOnly 条目没有可用地址，
    // assertUsableProxyId 会在写入时抛错。
    if (proxy.nameOnly !== true) proxyIdByName.set(normalizeProxyName(proxy.name), proxy.id);
  }

  const patches: Array<{ siteId: string; proxyId: string }> = [];
  for (const { siteSourceId, siteId: plannedSiteId, loginUrlKey, proxyName } of siteProxyNames) {
    const siteId = plannedSiteId
      ?? (siteSourceId ? siteIdBySource.get(siteSourceId) : undefined)
      ?? siteIdByUrl.get(loginUrlKey);
    const proxyId = proxyIdByName.get(normalizeProxyName(proxyName));
    if (siteId && proxyId) patches.push({ siteId, proxyId });
  }
  return patches;
}

/**
 * 站点与代理落地之后，把占位符换成真实 id。
 *
 * 分两步是因为 `addSites` / `addProxies` 都不返回新建条目的 id 映射 —— 只能落地后
 * 重新读一遍。顺带在这里做第二次账号判重：新建站点上可能已经有同名账号
 * （用户在新电脑上手工加过）。
 *
 * 代理占位符解析不出来时**回落到 inherit**，而不是丢掉账号 —— 账号本身是用户要的，
 * 代理绑定丢了可以重新分配；反过来把账号丢掉才是真的损失。
 */
export function resolvePendingIds(
  accounts: readonly Omit<Account, 'id'>[],
  sites: readonly SiteConfig[],
  existingAccounts: readonly Account[],
  proxies: readonly ProxyConfig[] = [],
): {
  resolved: Omit<Account, 'id'>[];
  unresolved: number;
  duplicateCount: number;
  /** 代理占位符没解析出来、已回落到 inherit 的账号数。 */
  droppedProxyBindings: number;
} {
  const siteIdByUrl = new Map<string, string>();
  const siteIdBySource = new Map<string, string>();
  for (const site of sites) {
    siteIdByUrl.set(normalizedLoginUrl(site.loginUrl), site.id);
    if (site.migrationSourceId) siteIdBySource.set(site.migrationSourceId, site.id);
  }
  const proxyIdByName = new Map<string, string>();
  for (const proxy of proxies) {
    // 与 planBackupImport 一致：只有真实出口能被绑定。
    if (proxy.nameOnly !== true) proxyIdByName.set(normalizeProxyName(proxy.name), proxy.id);
  }
  const existingSources = new Set(
    existingAccounts.map((account) => account.migrationSourceId ?? account.id),
  );

  const resolved: Omit<Account, 'id'>[] = [];
  let unresolved = 0;
  let duplicateCount = 0;
  let droppedProxyBindings = 0;
  for (const account of accounts) {
    let siteId = account.siteId;
    if (siteId.startsWith('pending-site:')) {
      const found = siteIdBySource.get(siteId.slice('pending-site:'.length));
      if (!found) {
        unresolved += 1;
        continue;
      }
      siteId = found;
    } else if (siteId.startsWith('pending:')) {
      // 兼容早期导入计划里的 URL 占位符。
      const found = siteIdByUrl.get(siteId.slice('pending:'.length));
      if (!found) {
        unresolved += 1;
        continue;
      }
      siteId = found;
    }
    if (account.migrationSourceId && existingSources.has(account.migrationSourceId)) {
      duplicateCount += 1;
      continue;
    }

    const next: Omit<Account, 'id'> = { ...account, siteId };
    if (next.proxyId?.startsWith('pending-proxy:')) {
      const found = proxyIdByName.get(next.proxyId.slice('pending-proxy:'.length));
      if (found) {
        next.proxyId = found;
      } else {
        // 绝不留一个指向不存在节点的 id：签到会直接失败在
        // 「账号配置的代理已不存在」。回落到跟随站点。
        droppedProxyBindings += 1;
        delete next.proxyId;
        next.proxyMode = 'inherit';
      }
    }
    if (next.migrationSourceId) existingSources.add(next.migrationSourceId);
    resolved.push(next);
  }
  return { resolved, unresolved, duplicateCount, droppedProxyBindings };
}

/** 导出文件名：`aah-backup-20260902-1430.json` */
export function backupFileName(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `aah-backup-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}.json`;
}
