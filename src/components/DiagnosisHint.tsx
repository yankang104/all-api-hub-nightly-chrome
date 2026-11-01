import { motion } from 'motion/react';
import { AlertTriangle, Lightbulb } from 'lucide-react';
import type { DiagnosisCode } from '@/lib/checkin/diagnosis';
import { DIAGNOSIS_TABLE } from '@/lib/checkin/diagnosis';
import { cn } from '@/lib/core/cn';

/**
 * 失败诊断提示。
 *
 * 「签到失败」本身没有信息量 —— 用户看完还是不知道该做什么。
 * 这里把结构化诊断渲染成「标题 + 说明 + 下一步」三段：
 * 一眼看懂发生了什么，再照着下一步把问题修掉。
 *
 * 渲染的是 DIAGNOSIS_TABLE 的字段，不做任何字符串拼接/截断 ——
 * 判定与文案都在码表里，界面只负责呈现，这样同一个失败在
 * 账号行、站点卡和后续新增的位置都长得一样。
 */
export function DiagnosisHint({ code }: { code: DiagnosisCode }) {
  const entry = DIAGNOSIS_TABLE[code];
  if (!entry) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      data-diagnosis-code={code}
      className={cn(
        'rounded-lg px-2.5 py-2 ring-1 ring-inset',
        'bg-amber-500/[0.07] ring-amber-500/20 dark:bg-amber-400/[0.06]',
      )}
    >
      <div className="flex gap-2">
        <AlertTriangle className="mt-px size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0 space-y-1.5">
          <p
            data-diagnosis-title
            className="text-[11px] font-semibold text-amber-900 dark:text-amber-100"
          >
            {entry.title}
          </p>
          <p className="text-[11px] leading-relaxed text-ink-800/70 dark:text-ink-100/60">
            {entry.detail}
          </p>
          <div className="space-y-0.5">
            <p className="flex items-center gap-1 text-[10px] font-medium text-amber-800/80 dark:text-amber-200/80">
              <Lightbulb className="size-3 shrink-0" />下一步
            </p>
            <ul data-diagnosis-actions className="space-y-0.5">
              {entry.nextActions.map((action, i) => (
                <li
                  key={i}
                  className="flex gap-1.5 text-[11px] leading-relaxed text-ink-800/60 dark:text-ink-100/50"
                >
                  <span className="shrink-0 opacity-45">{i + 1}.</span>
                  <span>{action}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
