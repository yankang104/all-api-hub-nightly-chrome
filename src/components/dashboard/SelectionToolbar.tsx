import { motion } from 'motion/react';
import { CheckSquare2, Trash2 } from 'lucide-react';

export function SelectionToolbar({
  siteCount,
  accountCount,
  onSelectAll,
  onClear,
  onDelete,
}: {
  siteCount: number;
  accountCount: number;
  onSelectAll: () => void;
  onClear: () => void;
  onDelete: () => void;
}) {
  const total = siteCount + accountCount;

  return (
    <motion.div
      initial={{ opacity: 0, y: 30, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 20, scale: 0.97 }}
      transition={{ type: 'spring', stiffness: 420, damping: 32 }}
      className="fixed bottom-4 left-1/2 z-40 flex w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 flex-wrap items-center gap-2 rounded-xl bg-ink-900 px-3 py-2.5 text-white shadow-2xl ring-1 ring-white/10 dark:bg-white dark:text-ink-900 dark:ring-black/10"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-white/10 text-rose-300 dark:bg-rose-500/10 dark:text-rose-600">
        <CheckSquare2 className="size-4" />
      </span>
      <div className="min-w-[112px] flex-1">
        <p className="text-xs font-semibold">已选 {total} 项</p>
        <p className="text-[10px] text-white/55 dark:text-ink-800/50">{siteCount} 个站点 · {accountCount} 个账号</p>
      </div>
      <button
        type="button"
        onClick={onSelectAll}
        className="h-8 rounded-lg px-2.5 text-[11px] font-medium text-white/70 hover:bg-white/10 hover:text-white dark:text-ink-800/60 dark:hover:bg-black/5 dark:hover:text-ink-900"
      >
        全选
      </button>
      <button
        type="button"
        onClick={onClear}
        disabled={total === 0}
        className="h-8 rounded-lg px-2.5 text-[11px] font-medium text-white/70 hover:bg-white/10 hover:text-white disabled:opacity-35 dark:text-ink-800/60 dark:hover:bg-black/5 dark:hover:text-ink-900"
      >
        清空
      </button>
      <motion.button
        whileHover={{ scale: total ? 1.03 : 1 }}
        whileTap={{ scale: total ? 0.97 : 1 }}
        type="button"
        onClick={onDelete}
        disabled={total === 0}
        className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-rose-500 px-3 text-[11px] font-semibold text-white hover:bg-rose-600 disabled:cursor-not-allowed disabled:opacity-35"
      >
        <Trash2 className="size-3.5" />
        删除选中
      </motion.button>
    </motion.div>
  );
}
