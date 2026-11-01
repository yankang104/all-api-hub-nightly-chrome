import { motion } from 'motion/react';
import { Import, SquarePlus } from 'lucide-react';

export function EmptyState({ onAdd, onImport }: { onAdd: () => void; onImport: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-col items-center justify-center overflow-hidden rounded-lg border border-dashed border-black/10 bg-white px-4 py-10 dark:border-white/10 dark:bg-white/[0.03]"
    >
      <img
        src="/pelican-bicycle.svg"
        alt="鹈鹕骑自行车"
        className="mb-2 h-auto w-full max-w-[460px]"
      />
      <h3 className="text-sm font-semibold">还没有站点</h3>
      <p className="mt-1 mb-4 text-xs text-ink-800/50 dark:text-ink-100/40">手动添加一个站点，或从 Chrome 书签中批量导入</p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <motion.button
          whileHover={{ scale: 1.04 }}
          whileTap={{ scale: 0.97 }}
          type="button"
          onClick={onAdd}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-4 py-2 text-xs font-medium text-white shadow-lg shadow-brand-500/25"
        >
          <SquarePlus className="size-4" />
          添加第一个站点
        </motion.button>
        <motion.button
          whileHover={{ scale: 1.04 }}
          whileTap={{ scale: 0.97 }}
          type="button"
          onClick={onImport}
          className="inline-flex items-center gap-1.5 rounded-lg bg-white px-4 py-2 text-xs font-medium text-ink-800 ring-1 ring-black/10 hover:bg-ink-50 dark:bg-white/5 dark:text-ink-100 dark:ring-white/10 dark:hover:bg-white/10"
        >
          <Import className="size-4" />
          从书签导入
        </motion.button>
      </div>
    </motion.div>
  );
}
