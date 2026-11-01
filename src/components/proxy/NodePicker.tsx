import { useMemo, useState } from 'react';
import { ChevronDown, Search, X } from 'lucide-react';
import { cn } from '@/lib/core/cn';
import { groupByRegion } from '@/lib/proxy/proxy-region';

interface Props {
  /** 待挑选的节点名，顺序即导入顺序 */
  names: readonly string[];
  selected: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  /** 每个节点右侧的附注，例如「会分给 主号」 */
  noteOf?: (name: string, index: number) => string;
}

/**
 * 按国家分组的节点挑选器。
 *
 * 三四十个节点平铺成一列时，「只要日本的」得一个个点。所以这里给三种批量入口：
 * 按国家整组选、搜索框实时过滤后整批选、关键词（优化 / GPT / Gemini）批量勾。
 * 分组规则见 lib/proxy-region.ts，只按名字判断 —— 名称条目没有出口可查，
 * 而用户要的本来就是「和 Clash Verge 显示的一样」。
 */
export function NodePicker({ names, selected, onChange, noteOf }: Props) {
  const [query, setQuery] = useState('');
  const [keyword, setKeyword] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => {
    const text = query.trim().toLowerCase();
    if (!text) return [...names];
    return names.filter((name) => name.toLowerCase().includes(text));
  }, [names, query]);

  // 分组前先过滤：搜索时只看命中的节点，「选中当前结果」才符合直觉
  const groups = useMemo(() => groupByRegion(filtered, (name) => name), [filtered]);
  const indexOf = useMemo(() => new Map(names.map((name, index) => [name, index])), [names]);

  function replace(mutate: (next: Set<string>) => void) {
    const next = new Set(selected);
    mutate(next);
    onChange(next);
  }

  function toggleOne(name: string) {
    replace((next) => {
      if (next.has(name)) next.delete(name);
      else next.add(name);
    });
  }

  function toggleGroup(items: readonly string[]) {
    const allPicked = items.every((name) => selected.has(name));
    replace((next) => {
      for (const name of items) {
        if (allPicked) next.delete(name);
        else next.add(name);
      }
    });
  }

  /** 关键词批量勾选：在当前过滤结果里追加命中项，不动已选的其他节点 */
  function pickByKeyword() {
    const text = keyword.trim().toLowerCase();
    if (!text) return;
    replace((next) => {
      for (const name of filtered) {
        if (name.toLowerCase().includes(text)) next.add(name);
      }
    });
  }

  function toggleCollapse(key: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const filteredPicked = filtered.filter((name) => selected.has(name)).length;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-[150px] flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-ink-800/35 dark:text-ink-100/35" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索节点，如 日本"
            aria-label="搜索节点"
            className="h-7 w-full rounded-md border border-black/8 bg-white pl-7 pr-6 text-[11px] text-ink-900 outline-none placeholder:text-ink-800/35 focus:border-brand-500/50 dark:border-white/10 dark:bg-ink-900 dark:text-ink-50"
          />
          {query && (
            <button type="button" onClick={() => setQuery('')} aria-label="清空节点搜索" className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-ink-800/40 hover:bg-black/5 dark:text-ink-100/40">
              <X className="size-3" />
            </button>
          )}
        </label>

        <div className="flex items-center gap-1">
          <input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); pickByKeyword(); } }}
            placeholder="关键词，如 优化"
            aria-label="按关键词批量勾选"
            className="h-7 w-28 rounded-md border border-black/8 bg-white px-2 text-[11px] text-ink-900 outline-none placeholder:text-ink-800/35 focus:border-brand-500/50 dark:border-white/10 dark:bg-ink-900 dark:text-ink-50"
          />
          <button
            type="button"
            disabled={!keyword.trim()}
            onClick={pickByKeyword}
            className="h-7 shrink-0 rounded-md bg-ink-100 px-2 text-[11px] font-medium text-ink-900 disabled:opacity-40 dark:bg-white/10 dark:text-ink-50"
          >
            勾选含此词
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between rounded-md bg-white px-2 py-1.5 text-[10px] ring-1 ring-black/5 dark:bg-ink-900 dark:ring-white/10">
        <span className="text-ink-800/60 dark:text-ink-100/50">
          {query ? `筛出 ${filtered.length} 个 · 其中已选 ${filteredPicked} 个` : `共 ${names.length} 个节点 · 已选 ${selected.size} 个`}
        </span>
        <span className="flex items-center gap-2">
          <button type="button" onClick={() => toggleGroup(filtered)} className="font-medium text-brand-600 hover:underline dark:text-brand-400">
            {filtered.length > 0 && filtered.every((name) => selected.has(name)) ? '取消当前结果' : '选中当前结果'}
          </button>
          <button type="button" onClick={() => onChange(new Set())} className="text-ink-800/50 hover:underline dark:text-ink-100/40">
            清空
          </button>
        </span>
      </div>

      <div className="max-h-72 space-y-1.5 overflow-y-auto">
        {groups.map((group) => {
          const shut = collapsed.has(group.key);
          const picked = group.items.filter((name) => selected.has(name)).length;
          const allPicked = picked === group.items.length;
          return (
            <div key={group.key} className="overflow-hidden rounded-lg ring-1 ring-black/5 dark:ring-white/10">
              <div className="flex items-center gap-2 bg-ink-50 px-2 py-1.5 dark:bg-ink-900">
                <input
                  type="checkbox"
                  checked={allPicked}
                  onChange={() => toggleGroup(group.items)}
                  aria-label={`${allPicked ? '取消选择' : '选择'}${group.label}全部节点`}
                  className="size-3.5 shrink-0"
                />
                <button type="button" onClick={() => toggleCollapse(group.key)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                  <span className="truncate text-[11px] font-semibold text-ink-900 dark:text-ink-50">{group.label}</span>
                  <span className="shrink-0 text-[10px] tabular-nums text-ink-800/45 dark:text-ink-100/35">{picked}/{group.items.length}</span>
                  <ChevronDown className={cn('ml-auto size-3 shrink-0 text-ink-800/40 transition-transform dark:text-ink-100/35', shut && '-rotate-90')} />
                </button>
              </div>

              {!shut && (
                <div className="divide-y divide-black/5 dark:divide-white/5">
                  {group.items.map((name) => {
                    const index = indexOf.get(name) ?? 0;
                    return (
                      <label key={name} className="flex cursor-pointer items-center gap-2 bg-white px-2 py-1.5 dark:bg-ink-950">
                        <input
                          type="checkbox"
                          checked={selected.has(name)}
                          onChange={() => toggleOne(name)}
                          aria-label={`选择节点 ${name}`}
                          className="size-3.5 shrink-0"
                        />
                        <span className="min-w-0 flex-1 truncate text-[11px] text-ink-900 dark:text-ink-50" title={name}>{name}</span>
                        {noteOf && <span className="shrink-0 text-[10px] text-ink-800/45 dark:text-ink-100/35">{noteOf(name, index)}</span>}
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}

        {!groups.length && (
          <p className="rounded-lg bg-white px-2.5 py-3 text-center text-[11px] text-ink-800/45 ring-1 ring-black/5 dark:bg-ink-900 dark:text-ink-100/35 dark:ring-white/10">
            没有匹配「{query}」的节点
          </p>
        )}
      </div>
    </div>
  );
}
