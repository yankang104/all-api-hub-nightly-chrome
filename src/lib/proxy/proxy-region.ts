/**
 * 从节点名认出国家/地区，用于把几十个节点折叠成可管理的分组。
 *
 * 为什么要做这件事：机场订阅动辄三四十个节点，名字形如
 * 「香港HK-HY2」「日本-优化2」「美国LA-优化-GPT」。平铺成一个列表时
 * 用户要一个个点，想「只要日本的」根本没法批量操作。
 *
 * 只按名字猜，不做 IP 归属查询 —— 名称条目没有出口，查不了；
 * 而且用户要的就是「和 Clash Verge 里显示的一样」，那就以名字为准。
 */

/** 有序表：先匹配中文名，再匹配国家代码 */
const REGION_RULES: { key: string; label: string; patterns: RegExp[] }[] = [
  { key: 'hk', label: '香港', patterns: [/香港/, /\bHK[A-Z0-9-]*/i] },
  { key: 'tw', label: '台湾', patterns: [/台湾|台灣/, /\bTW\b/i] },
  { key: 'jp', label: '日本', patterns: [/日本/, /\bJP[A-Z0-9-]*/i] },
  { key: 'kr', label: '韩国', patterns: [/韩国|韓國/, /\bKR\b/i] },
  { key: 'sg', label: '新加坡', patterns: [/新加坡|狮城/, /\bSG[A-Z0-9-]*/i] },
  { key: 'us', label: '美国', patterns: [/美国|美國/, /\bUS[A-Z0-9-]*/i, /\bLA\b/] },
  { key: 'ca', label: '加拿大', patterns: [/加拿大/, /\bCA\b/i] },
  { key: 'gb', label: '英国', patterns: [/英国|英國/, /\bUK\b|\bGB\b/i] },
  { key: 'de', label: '德国', patterns: [/德国|德國/, /\bDE\b/i] },
  { key: 'fr', label: '法国', patterns: [/法国|法國/, /\bFR\b/i] },
  { key: 'nl', label: '荷兰', patterns: [/荷兰|荷蘭/, /\bNL\b/i] },
  { key: 'ru', label: '俄罗斯', patterns: [/俄罗斯|俄羅斯/, /\bRU\b/i] },
  { key: 'ua', label: '乌克兰', patterns: [/乌克兰|烏克蘭/, /\bUA\b/i] },
  { key: 'tr', label: '土耳其', patterns: [/土耳其/, /\bTR\b/i] },
  { key: 'in', label: '印度', patterns: [/印度/, /\bIN\b/] },
  { key: 'vn', label: '越南', patterns: [/越南/, /\bVN\b/i] },
  { key: 'th', label: '泰国', patterns: [/泰国|泰國/, /\bTH\b/i] },
  { key: 'my', label: '马来西亚', patterns: [/马来|馬來/, /\bMY\b/i] },
  { key: 'ph', label: '菲律宾', patterns: [/菲律宾|菲律賓/, /\bPH\b/i] },
  { key: 'id', label: '印尼', patterns: [/印尼|印度尼西亚/, /\bID\b/i] },
  { key: 'au', label: '澳大利亚', patterns: [/澳大利亚|澳洲/, /\bAU\b/i] },
  { key: 'br', label: '巴西', patterns: [/巴西/, /\bBR\b/i] },
  { key: 'ar', label: '阿根廷', patterns: [/阿根廷/, /\bAR\b/i] },
  { key: 'ng', label: '尼日利亚', patterns: [/尼日利亚|尼日利亞/, /\bNG\b/i] },
  { key: 'za', label: '南非', patterns: [/南非/, /\bZA\b/i] },
  { key: 'ae', label: '阿联酋', patterns: [/阿联酋|迪拜/, /\bAE\b/i] },
  { key: 'il', label: '以色列', patterns: [/以色列/, /\bIL\b/i] },
  { key: 'ch', label: '瑞士', patterns: [/瑞士/, /\bCH\b/i] },
  { key: 'se', label: '瑞典', patterns: [/瑞典/, /\bSE\b/i] },
  { key: 'es', label: '西班牙', patterns: [/西班牙/, /\bES\b/i] },
  { key: 'it', label: '意大利', patterns: [/意大利/, /\bIT\b/i] },
  { key: 'pl', label: '波兰', patterns: [/波兰|波蘭/, /\bPL\b/i] },
  { key: 'mx', label: '墨西哥', patterns: [/墨西哥/, /\bMX\b/i] },
  { key: 'cn', label: '中国大陆', patterns: [/中国大陆|回国|大陆/] },
];

/** 认不出国家时的兜底分组 */
export const UNKNOWN_REGION = { key: 'other', label: '未识别' } as const;

export interface RegionInfo {
  key: string;
  label: string;
}

/**
 * 认出一个节点名属于哪个地区。
 *
 * 中文名优先于代码：「美国LA-优化」里 LA 和 US 都能命中美国，但
 * 「新加坡SG-A-Gemini」若先跑代码规则，`\bSG\b` 之类的写法容易在别的
 * 名字里误伤。中文名是订阅里最稳定的信号，先用它。
 */
export function detectRegion(name: string): RegionInfo {
  const text = name.trim();
  if (!text) return { ...UNKNOWN_REGION };

  // 两轮：先所有中文规则，再所有代码规则
  for (const round of [0, 1]) {
    for (const rule of REGION_RULES) {
      const pattern = rule.patterns[round];
      if (pattern && pattern.test(text)) return { key: rule.key, label: rule.label };
    }
  }
  return { ...UNKNOWN_REGION };
}

export interface RegionGroup<T> {
  key: string;
  label: string;
  items: T[];
}

/**
 * 按地区分组，组内保持传入顺序。
 *
 * 组的排列顺序按「组内数量降序、同数量按标签」，让节点最多的地区排在最上面 ——
 * 用户最常批量勾选的就是那几个大组。未识别组一律垫底。
 */
export function groupByRegion<T>(items: readonly T[], nameOf: (item: T) => string): RegionGroup<T>[] {
  const groups = new Map<string, RegionGroup<T>>();

  for (const item of items) {
    const region = detectRegion(nameOf(item));
    const existing = groups.get(region.key);
    if (existing) existing.items.push(item);
    else groups.set(region.key, { key: region.key, label: region.label, items: [item] });
  }

  return [...groups.values()].sort((a, b) => {
    if (a.key === UNKNOWN_REGION.key) return 1;
    if (b.key === UNKNOWN_REGION.key) return -1;
    return b.items.length - a.items.length || a.label.localeCompare(b.label, 'zh-Hans-CN');
  });
}
