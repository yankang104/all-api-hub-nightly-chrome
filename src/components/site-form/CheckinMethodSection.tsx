import { BookOpen, CheckCircle2 } from 'lucide-react';
import { CLAIM_MIN_LENGTH_DEFAULT, type CheckinWorkflowStep, type SiteConfig } from '@/types';
import { cn } from '@/lib/core/cn';
import { usesCheckinWorkflow } from '@/lib/checkin/learned-checkin';
import { describeWorkflowStep } from '@/lib/workflow/workflow-form';
import { validateCheckinWorkflow } from '@/lib/workflow/workflow-validation';
import { Field, inputCls } from '../Modal';

type SiteFormValue = Omit<SiteConfig, 'id'>;
type CheckinPatch = Partial<NonNullable<SiteConfig['checkin']>>;

interface Props {
  form: SiteFormValue;
  onChange: (patch: CheckinPatch) => void;
}

export function CheckinMethodSection({ form, onChange }: Props) {
  const usesWorkflow = usesCheckinWorkflow(form);
  const workflow = form.checkin?.workflow;
  const hasWorkflow = workflow !== undefined;
  const workflowErrors = hasWorkflow || usesWorkflow ? validateCheckinWorkflow(form, workflow) : [];
  const steps = Array.isArray(workflow?.steps) ? workflow.steps : [];
  const route = Array.isArray(workflow?.route) ? workflow.route : [];
  const usesLoginAsCheckin = !usesWorkflow && form.checkin?.method === 'none';
  const usesLegacyConfig = !usesWorkflow && !usesLoginAsCheckin && form.checkin?.method && form.checkin.method !== 'auto';
  const claimText = form.checkin?.claimText ?? '';
  const claimMinLength = form.checkin?.claimMinLength ?? (form.checkin?.method === 'claim' ? CLAIM_MIN_LENGTH_DEFAULT : 0);
  const claimTextLength = claimText.trim().length;
  const needsClaimText = usesWorkflow && JSON.stringify(workflow ?? {}).includes('{{claimText}}');
  const showClaimText = needsClaimText || form.checkin?.method === 'claim' || !!claimText;
  const claimTextTooShort = claimTextLength > 0 && claimTextLength < claimMinLength;
  /**
   * 单一「自主学习」入口下的**当前执行方式**。
   *
   * 三种执行方式（自动识别 / 学习流程回放 / 登录即签到）不是让用户挑的偏好，
   * 而是「登录成功后怎么算签完」这一个问题的三种事实。学习结束时会自动判定并
   * 落盘：点过签到按钮 → 学成回放；页面上确实没有签到入口 → 登录即签到；其余
   * 情况保持自动识别。这里只把「现在会怎么做」如实显示出来，用户不需要选。
   */
  const learnedTitle = usesWorkflow
    ? '已学会本站流程，自动回放'
    : usesLoginAsCheckin
      ? '登录即签到（本站没有签到按钮）'
      : usesLegacyConfig
        ? '沿用本站已有的签到适配'
        : '自动识别签到';
  const learnedHint = usesWorkflow
    ? '按学习时记录的页面路线与操作顺序执行，遇到页面改版会自动兜底查找。'
    : usesLoginAsCheckin
      ? '登录成功后即视为完成签到，不再寻找签到按钮。'
      : usesLegacyConfig
        ? '沿用本站已有的按钮、接口或专用签到适配；不会套用学习记录。'
        : '在本站自动寻找签到入口与今日状态；学到流程后会自动改为回放。';
  const learnedStepHint = usesWorkflow
    ? '按本站保存的页面路线与操作顺序执行，不使用其它站点的流程。'
    : usesLoginAsCheckin
      ? '登录成功后直接视为本次签到完成，不再执行额外的签到按钮或接口操作。'
      : usesLegacyConfig
        ? '沿用本站已有的按钮、接口或专用签到适配；不会自动套用学习记录。'
        : '按本站适配和当前页面寻找签到入口、按钮及今日状态，不执行旧学习记录。';

  return (
    <section aria-label="签到设置" className="space-y-3">
      <div className="space-y-2">
        <span className="text-xs font-medium text-ink-800/70 dark:text-ink-100/60">自主学习</span>
        <div className="rounded-xl bg-brand-500/10 p-3 ring-1 ring-brand-500/30">
          <p className="flex items-center gap-2 text-xs font-semibold text-brand-700 dark:text-brand-300">
            <CheckCircle2 className="size-4 shrink-0" />{learnedTitle}
          </p>
          <p className="mt-1.5 text-[11px] leading-relaxed text-ink-800/70 dark:text-ink-100/60">{learnedHint}</p>
          <ol className="mt-2 space-y-2 text-[11px] leading-relaxed text-ink-800/75 dark:text-ink-100/70">
            <li><strong className="font-medium">① 登录并确认账号</strong><br />按登录设置进入站点，确认当前要签到的账号。</li>
            <li><strong className="font-medium">② 完成签到</strong><br />{learnedStepHint}</li>
          </ol>
          <p className="mt-2 text-[11px] leading-relaxed text-ink-800/50 dark:text-ink-100/40">
            遇到没经历过的页面会自己判断：找不到入口先滚动查找、按钮藏在验证后先完成验证、当天已签到按已完成收尾、确实没有按钮则按「登录即签到」处理。要更新流程时，在账号旁点「学习本站流程」再演示一次即可。
          </p>
        </div>
      </div>
      <div className="rounded-xl bg-ink-50 p-3 dark:bg-ink-900/60">
        <p className="flex items-center gap-1.5 text-xs font-medium text-ink-900 dark:text-ink-50">
          <BookOpen className="size-3.5 shrink-0" />
          {hasWorkflow || usesWorkflow ? '已保存签到流程' : '还没有学习签到流程'}
          {hasWorkflow && !usesWorkflow && <span className="text-[10px] text-amber-700 dark:text-amber-400">（未启用，仅保留记录）</span>}
        </p>
        <p className="mt-1.5 text-[11px] leading-relaxed text-ink-800/60 dark:text-ink-100/50">
          学习结果保存在本站设置，本站所有账号共用；只接管第 ② 步的签到，不包含登录操作。
        </p>
        <p className="mt-1.5 text-[11px] leading-relaxed text-ink-800/60 dark:text-ink-100/50">
          {hasWorkflow
            ? '需要更新时，在任一账号旁点「学习本站流程」，手动登录并完成一次签到，再点「结束学习」。保存成功会明确启用学习流程回放；也可随时切回自动识别，保留记录但不执行。'
            : '无需学习也能使用自动识别。需要录制时，先保存站点，在账号旁点「学习本站流程」，本次手动登录并完成一次签到，再点「结束学习」。'}
        </p>
        {hasWorkflow && (
          /*
           * 「切回自动识别 / 重新启用回放」：文案上方一直承诺可以切回，这里给出入口。
           *
           * 停用只写 method:'auto' + workflowReplayDisabled:true，**不删记录**：兼容迁移
           * 认这个标记、不会把它迁回回放；同域其它站点卡也不会再借用它。
           */
          <div className="mt-2 flex flex-wrap gap-2">
            {usesWorkflow ? (
              <button
                type="button"
                className="rounded-md px-2 py-1 text-[11px] font-medium text-ink-800/80 ring-1 ring-black/10 hover:bg-black/5 dark:text-ink-100/80 dark:ring-white/15 dark:hover:bg-white/10"
                onClick={() => onChange({ method: 'auto', workflowReplayDisabled: true })}
              >
                自动识别（自主签到）
              </button>
            ) : workflowErrors.length === 0 ? (
              <button
                type="button"
                className="rounded-md px-2 py-1 text-[11px] font-medium text-brand-700 ring-1 ring-brand-500/30 hover:bg-brand-500/10 dark:text-brand-300"
                onClick={() => onChange({ method: 'workflow', workflowReplayDisabled: false })}
              >
                重新启用学习流程回放
              </button>
            ) : null}
          </div>
        )}
        {(hasWorkflow || usesWorkflow) && (
          <details className="mt-3 rounded-lg border border-black/5 p-2.5 dark:border-white/10">
            <summary className="cursor-pointer text-[11px] font-medium text-brand-700 dark:text-brand-300">
              查看保存的流程（{steps.length} 个步骤 · {route.length} 个页面）
              {workflowErrors.length > 0 && ' · 需要重新学习'}
            </summary>
            {workflowErrors.length > 0 ? (
              <p role="alert" className="mt-2 text-[11px] leading-relaxed text-amber-700 dark:text-amber-400">
                已保存的流程需要修正后才能回放：{workflowErrors.join('；')}。可重新学习；选择自动识别时不执行此记录，也不受此错误影响。
              </p>
            ) : (
              <div className="mt-2 space-y-3 text-[11px] leading-relaxed text-ink-800/70 dark:text-ink-100/60">
                <div>
                  <p className="font-medium">登录后的页面路线</p>
                  {route.length > 0
                    ? <ol className="mt-1 space-y-1">{route.map((page, index) => <li key={`${index}-${page}`} className="break-all">{index + 1}. {page}</li>)}</ol>
                    : <p className="mt-1">未单独记录路线，从登录后的页面开始执行步骤。</p>}
                </div>
                <div>
                  <p className="font-medium">到达签到页后执行</p>
                  <WorkflowStepSummary steps={steps} />
                </div>
              </div>
            )}
          </details>
        )}
      </div>

      {usesLegacyConfig && (
        <p className="text-[11px] leading-relaxed text-ink-800/50 dark:text-ink-100/40">
          本站已有的签到适配设置会继续使用；只有主动切换方式或保存新的学习流程才会更改。
        </p>
      )}

      {showClaimText && (
        <div className="space-y-2">
          <Field label="签到时填写的文本" hint="学习会记住填写动作，但不会保存当时输入的内容；回放时统一填写这里的文本，本站账号共用。">
            <textarea
              rows={3}
              className={inputCls}
              placeholder="填写本站签到表单需要的内容"
              value={claimText}
              onChange={(event) => onChange({ claimText: event.target.value })}
            />
          </Field>
          <p className={cn('text-[11px]', (needsClaimText && claimTextLength === 0) || claimTextTooShort
            ? 'text-amber-700 dark:text-amber-400'
            : 'text-ink-800/50 dark:text-ink-100/40')}>
            {needsClaimText && claimTextLength === 0
              ? '已保存流程包含填写动作，请补充文本后再执行。'
              : `当前 ${claimTextLength} 字${claimTextTooShort ? `，少于 ${claimMinLength} 字，站点可能不接受` : ''}`}
          </p>
        </div>
      )}

      <details className="rounded-xl border border-black/5 p-3 dark:border-white/10">
        <summary className="cursor-pointer text-[11px] text-ink-800/60 dark:text-ink-100/50">补充签到判定</summary>
        <div className="mt-3">
          <Field label="「已签到」判定词" hint="可选，逗号分隔。留空用内置词表（已签到、重复签到…）">
            <input
              className={inputCls}
              placeholder="已签到, 重复签到"
              value={(form.checkin?.alreadyText ?? []).join(', ')}
              onChange={(event) => onChange({ alreadyText: event.target.value.split(',').map((word) => word.trim()).filter(Boolean) })}
            />
          </Field>
        </div>
      </details>
    </section>
  );
}

/** 只展示通过校验的步骤；条件分支也按实际顺序展开，避免把学习结果藏在 JSON 里。 */
function WorkflowStepSummary({ steps }: { steps: CheckinWorkflowStep[] }) {
  return (
    <ol className="mt-1 space-y-1.5">
      {steps.map((step, index) => (
        <li key={index} className="break-words">
          {index + 1}. {describeWorkflowStep(step)}
          {step.type === 'if' && (
            <div className="ml-3 border-l border-black/10 pl-2 dark:border-white/10">
              <p>满足条件时：</p><WorkflowStepSummary steps={step.then} />
              {!!step.else?.length && <><p className="mt-1">否则：</p><WorkflowStepSummary steps={step.else} /></>}
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}
