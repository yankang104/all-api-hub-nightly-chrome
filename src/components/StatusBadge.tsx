import { AnimatePresence, motion } from 'motion/react';
import { Check, CheckCheck, HelpCircle, Loader2, AlertTriangle, ShieldAlert, UserCheck } from 'lucide-react';
import type { CheckinMethod, DailyStatus } from '@/types';
import type { CheckinEvidence } from '@/lib/checkin/checkin-evidence';
import { actionWords, statusLabelFor } from '@/lib/checkin/action-label';
import { cn } from '@/lib/core/cn';

interface Props {
  status: DailyStatus;
  /**
   * 本次执行方式，决定徽标说「已签到」还是「已领取」。
   * 留空按签到显示，兼容旧调用。
   */
  method?: CheckinMethod;
  /**
   * 成功的证据级别，仅当 status === 'done' 时有意义。
   *
   * - verified   : 守恒差分看到额度增长 → 翠绿 + 双勾
   * - observed   : 读到快照但额度没变多 → 翠绿 + 单勾（今日已签过属于正常）
   * - unverified : 没有快照，成功只是站点文案说的 → 灰绿 + ？
   * - manual     : 用户手动断言 → 灰绿 + 人形勾
   * - undefined  : 向后兼容，等同 unverified
   */
  evidence?: CheckinEvidence;
}

/** 只保留配色；文字由 action-label 按动作生成，避免领取站被写成「已签到」 */
const STATUS_CLS: Record<DailyStatus, string> = {
  pending:   'bg-amber-500/15 text-amber-600 dark:text-amber-400 ring-amber-500/30',
  running:   'bg-brand-500/15 text-brand-600 dark:text-brand-400 ring-brand-500/30',
  attention: 'bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 ring-cyan-500/30',
  done:      'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 ring-emerald-500/30',
  failed:    'bg-rose-500/15 text-rose-600 dark:text-rose-400 ring-rose-500/30',
};

/** Stable hooks for the comic treatment; CSS owns the actual animation. */
const STATUS_COMIC_STATE: Record<DailyStatus, string> = {
  pending: 'thunder-flicker',
  running: 'armor-reactor',
  attention: 'mystic-portal',
  done: 'shield-glint',
  failed: 'titan-impact',
};

/**
 * done 状态按证据级别覆盖配色。
 *
 * ⚠️ 这里曾经写的是 `bg-ink-500/10 text-ink-600/70 dark:text-ink-300/60`，
 * 而 tailwind.css 只定义了 ink 的 50/100/700/800/900/950 六档 —— ink-300/500/600
 * 压根不存在，构建产物里查不到任何 `.text-ink-500` 之类的规则。也就是说
 * unverified 和 manual 这两级**整行样式都是死类**，实际渲染出来只剩继承的默认
 * 文字色，与 verified/observed 的区分完全失效。而 checkin-evidence.ts 顶部记着
 * 这个区分正是为了防那个已修 bug（无证据的成功曾和真成功长得一样）。
 * 现在改用已定义的档位，让弱证据真的看起来更弱。
 */
const DONE_EVIDENCE_CLS: Record<CheckinEvidence, string> = {
  verified:   'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 ring-emerald-500/30',
  // 页面奖励是明确的成功反馈，但还没有余额守恒证据，使用中性青色提示。
  reported:   'bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 ring-cyan-500/30',
  observed:   'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 ring-emerald-500/30',
  // 无证据：不用绿，改中性灰 —— 「可能对，也可能站点文案骗了你」。
  // 文字用 ink-800/70（浅底 ~4.9:1）与 ink-100/75（深底 ~3.6:1），都高于原来的死类。
  unverified: 'bg-ink-100 text-ink-800/70 ring-black/8 dark:bg-white/10 dark:text-ink-100/75 dark:ring-white/15',
  manual:     'bg-ink-100 text-ink-800/70 ring-black/8 dark:bg-white/10 dark:text-ink-100/75 dark:ring-white/15',
};

export function StatusBadge({ status, evidence, method }: Props) {
  const words = actionWords(method);
  const cls = status === 'done' && evidence ? DONE_EVIDENCE_CLS[evidence] : STATUS_CLS[status];
  const comicState = STATUS_COMIC_STATE[status];
  const label = (() => {
    if (status === 'attention') return '需处理';
    if (status === 'failed') return '失败';
    if (status === 'done') {
      if (evidence === 'manual') return '手动标记';
      // 无证据：加问号，提示这条「成功」只是站点文案说的
      if (!evidence || evidence === 'unverified') return `${words.done}?`;
      return words.done;
    }
    return statusLabelFor(status, method);
  })();
  const meta = { label, cls };

  // animation key：evidence 变化时也要重新播放入场动画
  const key = status === 'done' ? `done-${evidence ?? 'none'}` : status;

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.span
        key={key}
        data-status={status}
        data-comic-state={comicState}
        initial={{ opacity: 0, scale: 0.8, y: -2 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.8, y: 2 }}
        transition={{ type: 'spring', stiffness: 500, damping: 28 }}
        className={cn(
          'status-badge',
          `status-badge-${status}`,
          `status-badge-${comicState}`,
          'inline-flex min-w-[76px] select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1',
          'text-[11px] font-medium ring-1 ring-inset',
          meta.cls,
        )}
      >
        <Indicator status={status} evidence={evidence} />
        {meta.label}
      </motion.span>
    </AnimatePresence>
  );
}

function Indicator({ status, evidence }: { status: DailyStatus; evidence?: CheckinEvidence }) {
  const comicState = STATUS_COMIC_STATE[status];
  const indicatorCls = cn('status-badge-indicator', `status-badge-indicator-${comicState}`);

  if (status === 'running')   return <Loader2 className={cn(indicatorCls, 'size-3 animate-spin')} />;
  if (status === 'attention') return <ShieldAlert className={cn(indicatorCls, 'size-3')} />;
  if (status === 'failed')    return <AlertTriangle className={cn(indicatorCls, 'size-3')} />;

  if (status === 'done') {
    if (evidence === 'manual') {
      return (
        <motion.span className={indicatorCls} initial={{ scale: 0, rotate: -30 }} animate={{ scale: 1, rotate: 0 }} transition={{ type: 'spring', stiffness: 600, damping: 18 }}>
          <UserCheck className="size-3" />
        </motion.span>
      );
    }
    if (evidence === 'unverified' || !evidence) {
      return <HelpCircle className={cn(indicatorCls, 'size-3')} />;
    }
    if (evidence === 'verified') {
      return (
        <motion.span className={indicatorCls} initial={{ scale: 0, rotate: -30 }} animate={{ scale: 1, rotate: 0 }} transition={{ type: 'spring', stiffness: 600, damping: 18 }}>
          <CheckCheck className="size-3 stroke-[3]" />
        </motion.span>
      );
    }
    // observed：普通单勾
    return (
      <motion.span className={indicatorCls} initial={{ scale: 0, rotate: -30 }} animate={{ scale: 1, rotate: 0 }} transition={{ type: 'spring', stiffness: 600, damping: 18 }}>
        <Check className="size-3 stroke-[3]" />
      </motion.span>
    );
  }

  /*
   * pending：静态圆点。
   *
   * 原来用 animate-breathe 呼吸，但 pending 是「排在那儿等着执行」的静止状态，
   * 呼吸让它看起来像正在运行 —— 而正在运行的 running 用的是 spinner，两者语义
   * 撞在一起。另外这个动画数量随账号数线性增长：40 个待执行账号就是 40 个
   * infinite 动画，实测同屏动画已经把静置帧率压到 55fps。
   */
  return <span className={cn(indicatorCls, 'size-1.5 rounded-full bg-current')} />;
}
