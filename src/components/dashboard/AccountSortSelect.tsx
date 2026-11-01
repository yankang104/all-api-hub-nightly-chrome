import { cn } from '@/lib/core/cn';
import { normalizeAccountSortMode, type AccountSortMode } from '@/lib/core/account-sort';

export function AccountSortSelect({
  value,
  onChange,
  compact,
}: {
  value: AccountSortMode;
  onChange: (mode: AccountSortMode) => void;
  compact?: boolean;
}) {
  return (
    <label
      className={cn(
        'flex h-8 min-w-0 items-center gap-1.5 rounded-md border border-black/8 bg-white px-2 text-[11px] dark:border-white/10 dark:bg-ink-900',
        compact ? 'grow' : 'shrink-0',
      )}
      title="按账号名称排序：有备注用备注，否则用用户名"
    >
      <span className="shrink-0 text-ink-800/60 dark:text-ink-100/60">账号排序</span>
      <select
        aria-label="账号排序"
        value={value}
        onChange={(event) => onChange(normalizeAccountSortMode(event.target.value))}
        className="min-w-0 flex-1 cursor-pointer rounded bg-white py-1 text-ink-900 outline-none focus:ring-2 focus:ring-brand-500/30 dark:bg-ink-900 dark:text-ink-50"
      >
        <option value="name-asc">名称 A→Z（默认）</option>
        <option value="name-desc">名称 Z→A</option>
        <option value="added">添加顺序</option>
      </select>
    </label>
  );
}
