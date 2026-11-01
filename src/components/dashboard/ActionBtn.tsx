import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/core/cn';

export function ActionBtn({
  icon,
  label,
  onClick,
  primary,
  accent,
  danger,
  compact,
  disabled,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  primary?: boolean;
  accent?: boolean;
  danger?: boolean;
  compact?: boolean;
  disabled?: boolean;
}) {
  return (
    <motion.button
      whileHover={{ scale: disabled ? 1 : 1.04, y: disabled ? 0 : -1 }}
      whileTap={{ scale: disabled ? 1 : 0.97 }}
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={cn(
        'action-btn inline-flex h-9 items-center gap-1.5 rounded-lg text-xs font-semibold transition-colors disabled:opacity-40',
        compact ? 'w-9 justify-center px-0' : 'px-3',
        primary && 'action-btn-primary bg-mint-600 text-white shadow-lg shadow-mint-600/20 hover:bg-mint-700',
        accent && 'action-btn-accent bg-coral-500 text-white shadow-lg shadow-coral-500/20 hover:bg-coral-600',
        danger && 'action-btn-danger bg-rose-500 text-white shadow-lg shadow-rose-500/20 hover:bg-rose-600',
        !primary &&
          !accent &&
          !danger &&
          'bg-white text-ink-800 ring-1 ring-black/5 hover:bg-sun-100 dark:bg-white/5 dark:text-ink-100 dark:ring-white/10 dark:hover:bg-white/10',
      )}
    >
      <span className="action-btn-energy" aria-hidden="true" />
      <span className="action-btn-icon" aria-hidden="true">{icon}</span>
      <span className={cn('action-label relative z-[2]', compact && 'sr-only')}>{label}</span>
    </motion.button>
  );
}
