import { useEffect, useId, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { ArrowDownUp } from 'lucide-react';
import { cn } from '@/lib/core/cn';
import type { AccountSortMode } from '@/lib/core/account-sort';
import type { SiteSortMode } from '@/lib/core/site-sort';
import { AccountSortSelect } from './AccountSortSelect';

// “手动”不是可选项：任何排序下都能用卡片箭头微调，点箭头即固化当前顺序。
const choices: { value: Exclude<SiteSortMode, 'manual'>; label: string; name: string; hint: string }[] = [
  { value: 'name-asc', label: 'A → Z', name: '名称 A→Z', hint: '中文按全拼与字母混排；1、2、10 按数值排列' },
  { value: 'name-desc', label: 'Z → A', name: '名称 Z→A', hint: '按名称降序；一、壹等汉字按拼音，不当数字' },
];

/** 顶栏仅占一个方形按钮，展开的排序选项不挤占站点列表。 */
export function SiteSortToolbar({
  value, onChange, accountSortMode, onAccountSortChange,
}: {
  value: SiteSortMode;
  onChange: (mode: SiteSortMode) => void;
  accountSortMode: AccountSortMode;
  onAccountSortChange: (mode: AccountSortMode) => void;
}) {
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [rightOffset, setRightOffset] = useState(0);

  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    };
    const resize = () => setOpen(false);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', keydown);
    window.addEventListener('resize', resize);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('keydown', keydown);
      window.removeEventListener('resize', resize);
    };
  }, [open]);

  return (
    <div ref={container} className="relative shrink-0">
      <motion.button
        ref={trigger}
        type="button"
        aria-label="排序设置"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        title={`排序设置 · 站点：${choices.find((choice) => choice.value === value)?.name ?? '已微调'}`}
        onClick={() => {
          // 窄侧栏中若按钮靠左，向右平移弹层，避免菜单越出屏幕。
          const right = trigger.current?.getBoundingClientRect().right ?? 0;
          setRightOffset(Math.min(0, right - Math.min(224, window.innerWidth - 16) - 8));
          setOpen((current) => !current);
        }}
        whileTap={{ scale: 0.94 }}
        className={cn(
          'grid size-8 place-items-center rounded-md border shadow-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 motion-reduce:transition-none dark:focus-visible:ring-offset-slate-950',
          open ? 'border-blue-600 bg-blue-600 text-white dark:border-blue-500 dark:bg-blue-500' : 'border-slate-200 bg-white text-slate-500 hover:border-blue-300 hover:text-blue-600 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-400 dark:hover:text-blue-300',
        )}
      >
        <ArrowDownUp className="size-4" aria-hidden="true" />
      </motion.button>
      {open && <motion.div
        id={id}
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.16 }}
        style={{ right: rightOffset }}
        className="absolute top-full z-50 mt-2 w-56 max-w-[calc(100vw-16px)] rounded-xl border border-slate-200 bg-white p-3 shadow-lg shadow-slate-900/10 dark:border-slate-700 dark:bg-slate-900 dark:shadow-black/30"
      >
        <div role="group" aria-label="站点排序">
          <p className="mb-2 text-[11px] font-semibold text-slate-600 dark:text-slate-300">站点排序</p>
          <div className="isolate flex rounded-lg bg-slate-100 p-1 dark:bg-slate-950">
            {choices.map((choice) => (
              <motion.button
                key={choice.value}
                type="button"
                aria-label={choice.name}
                aria-pressed={value === choice.value}
                title={choice.hint}
                onClick={() => onChange(choice.value)}
                whileTap={{ scale: 0.96 }}
                className={cn(
                  'relative flex-1 whitespace-nowrap rounded-md px-2 py-1.5 text-[11px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 motion-reduce:transition-none',
                  value === choice.value ? 'text-white' : 'text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100',
                )}
              >
                {value === choice.value && <motion.span
                  layoutId={`${id}-selection`}
                  className="absolute inset-0 -z-10 rounded-md bg-blue-600 shadow-sm dark:bg-blue-500"
                  transition={{ type: 'spring', stiffness: 430, damping: 34 }}
                  aria-hidden="true"
                />}
                {choice.label}
              </motion.button>
            ))}
          </div>
          <p className="mt-2 text-[10px] leading-relaxed text-slate-500 dark:text-slate-400">
            {value === 'manual'
              ? '当前是手动微调后的顺序（可继续用卡片箭头调整）· 选字母排序可恢复'
              : '中文按拼音，1、2、10 按数值 · 卡片箭头可随时微调'}
          </p>
        </div>
        <div className="mt-3 border-t border-slate-100 pt-3 dark:border-slate-800">
          <AccountSortSelect value={accountSortMode} onChange={onAccountSortChange} />
        </div>
      </motion.div>}
    </div>
  );
}

