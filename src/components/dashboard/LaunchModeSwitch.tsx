import { motion } from 'motion/react';
import { ExternalLink, PanelRight } from 'lucide-react';
import type { LaunchMode } from '@/types';
import { cn } from '@/lib/core/cn';
import type { LaunchSurface } from '@/lib/site/launch-mode';

const MODES = [
  { value: 'sidepanel' as const, label: '侧边栏', Icon: PanelRight },
  { value: 'tab' as const, label: '独立页', Icon: ExternalLink },
];

export function LaunchModeSwitch({
  mode,
  compact,
  surface,
  disabled = false,
  onChange,
}: {
  mode: LaunchMode;
  compact: boolean;
  surface: LaunchSurface;
  disabled?: boolean;
  onChange: (mode: LaunchMode) => void | Promise<void>;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="扩展打开方式"
      data-mode={mode}
      aria-busy={disabled}
      className={cn(
        'launch-mode-switch inline-flex h-9 items-center gap-0.5 rounded-lg bg-white p-1 text-ink-800 ring-1 ring-black/5 dark:bg-white/5 dark:text-ink-100 dark:ring-white/10',
        disabled && 'launch-mode-switch-busy',
      )}
    >
      <span className={cn('launch-mode-caption px-1.5 text-[9px] font-bold uppercase text-ink-800/45 dark:text-ink-100/45', compact && 'sr-only')}>
        打开方式
      </span>
      {MODES.map(({ value, label, Icon }) => {
        const active = mode === value;
        const alreadyAtSurface = value === 'tab' ? surface === 'page' : surface === 'sidepanel';
        return (
          <motion.button
            key={value}
            whileTap={{ scale: 0.92 }}
            type="button"
            disabled={disabled}
            role="radio"
            aria-checked={active}
            aria-label={`${label}模式`}
            title={active && alreadyAtSurface ? `当前为${label}模式` : `切换到${label}并立即打开`}
            onClick={() => {
              if (!active || !alreadyAtSurface) void onChange(value);
            }}
            className={cn('launch-mode-option', active && 'launch-mode-option-active')}
          >
            {active && (
              <motion.span
                layoutId="launch-mode-active"
                className="launch-mode-active-plate"
                transition={{ type: 'spring', stiffness: 460, damping: 34 }}
                aria-hidden="true"
              />
            )}
            <span className="launch-mode-icon" aria-hidden="true"><Icon className="size-3.5" /></span>
            <span className={cn('launch-mode-label', compact && 'sr-only')}>{label}</span>
          </motion.button>
        );
      })}
    </div>
  );
}
