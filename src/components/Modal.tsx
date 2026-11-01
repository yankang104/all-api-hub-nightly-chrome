import { AnimatePresence, motion } from 'motion/react';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';

interface Props {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}

export function Modal({ open, title, onClose, children, wide }: Props) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.94, y: 16 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            onClick={(e) => e.stopPropagation()}
            className={`${wide ? 'max-w-2xl' : 'max-w-md'} max-h-full w-full overflow-y-auto rounded-2xl bg-white shadow-2xl ring-1 ring-black/10 dark:bg-ink-800 dark:ring-white/10`}
          >
            <header className="flex items-center justify-between border-b border-black/5 px-5 py-3.5 dark:border-white/5">
              <h3 className="text-sm font-semibold text-ink-900 dark:text-ink-50">{title}</h3>
              <motion.button
                whileHover={{ scale: 1.12, rotate: 90 }}
                whileTap={{ scale: 0.9 }}
                type="button"
                onClick={onClose}
                className="rounded-lg p-1.5 text-ink-800/50 hover:bg-black/5 dark:text-ink-100/50 dark:hover:bg-white/10"
              >
                <X className="size-4" />
              </motion.button>
            </header>
            <div className="p-5">{children}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-ink-800/70 dark:text-ink-100/60">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-ink-800/40 dark:text-ink-100/30">{hint}</span>}
    </label>
  );
}

export const inputCls =
  'w-full rounded-xl bg-ink-50 px-3 py-2 text-sm text-ink-900 outline-none ring-1 ring-black/5 ' +
  'transition-shadow placeholder:text-ink-800/30 focus:ring-2 focus:ring-brand-500/50 ' +
  'dark:bg-ink-900 dark:text-ink-50 dark:ring-white/10 dark:placeholder:text-ink-100/25';

export const btnPrimary =
  'w-full rounded-xl bg-brand-500 px-4 py-2.5 text-sm font-medium text-white shadow-lg shadow-brand-500/25 ' +
  'transition-colors hover:bg-brand-600 disabled:opacity-40 disabled:shadow-none';
