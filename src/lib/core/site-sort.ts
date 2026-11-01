import { pinyin } from 'pinyin-pro';
import type { SiteConfig } from '@/types';

/**
 * 站点显示顺序。
 *
 * - `name-asc` / `name-desc`：按名称排序（字母与拼音混排，阿拉伯数字按数值）。
 * - `manual`：字母排序之后用卡片箭头微调出来的顺序。它不是可选项 —— 用户不需要
 *   先切换模式才能调整，任何排序下点箭头都会把当前可见顺序固化成 manual。
 */
export type SiteSortMode = 'name-asc' | 'name-desc' | 'manual';
export const DEFAULT_SITE_SORT_MODE: SiteSortMode = 'name-asc';

export function normalizeSiteSortMode(value: unknown): SiteSortMode {
  return value === 'name-desc' || value === 'manual' ? value : DEFAULT_SITE_SORT_MODE;
}

const siteNameCollator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

/** Store 提供手动顺序；名称排序仅用于展示，不改写站点及其 sortOrder。 */
export function sortSites(sites: readonly SiteConfig[], mode: SiteSortMode = DEFAULT_SITE_SORT_MODE): SiteConfig[] {
  if (mode === 'manual') return [...sites];
  const direction = mode === 'name-desc' ? -1 : 1;
  // zh-CN Collator 会把汉字整体排在拉丁字母之前；先取无声调全拼，才能真正混排。
  // 一/壹等汉字保留读音，只有原文中的阿拉伯数字参与 numeric 自然排序。
  return sites
    .map((site) => ({ site, key: pinyin(site.name.trim(), { toneType: 'none', type: 'array' }).join('') }))
    .sort((a, b) => direction * siteNameCollator.compare(a.key, b.key))
    .map(({ site }) => site);
}

/**
 * 在一条站点顺序里把某个站点向上/向下移动一位，返回新数组（不修改入参）。
 *
 * `visibleIds` 是界面当前真正显示的站点（搜索过滤后）。不过滤时就是普通的相邻
 * 换位；过滤时直接和相邻项换位会换到一个看不见的站点上（点箭头像没反应），
 * 因此移动要跨过不可见项、落到下一个可见邻居旁边。移不动时返回原顺序的副本。
 */
export function moveSiteIdInOrder(
  order: readonly string[],
  siteId: string,
  direction: 'up' | 'down',
  visibleIds?: ReadonlySet<string>,
): string[] {
  const next = [...order];
  const from = next.indexOf(siteId);
  if (from < 0) return next;
  const isVisible = (id: string) => !visibleIds || visibleIds.has(id);
  if (direction === 'up') {
    let to = from - 1;
    while (to >= 0 && !isVisible(next[to]!)) to -= 1;
    if (to < 0) return next;
    next.splice(from, 1);
    next.splice(to, 0, siteId);
    return next;
  }
  let to = from + 1;
  while (to < next.length && !isVisible(next[to]!)) to += 1;
  if (to >= next.length) return next;
  next.splice(from, 1);
  next.splice(to, 0, siteId);
  return next;
}
