import { useState } from 'react';
import type { CheckinWorkflowCondition, CheckinWorkflowStep } from '@/types';
import { Field, inputCls } from '../Modal';
import { describeWorkflowStep, removeRoutePage } from '@/lib/workflow/workflow-form';

interface Props {
  steps: CheckinWorkflowStep[];
  /**
   * 学习模式记录的页面路线。
   *
   * 必须展示出来：用户手动签到一次之后，唯一能确认「学得对不对」的方式就是
   * 看见扩展记住了哪几个页面。只显示步骤而藏起路线，用户无从判断，也不知道
   * 自动签到会从哪一页开始走。
   */
  route?: string[];
  onChange: (steps: CheckinWorkflowStep[]) => void;
  /** 修改学习到的路线（删掉学错的一页）。不传时路线只读。 */
  onChangeRoute?: (route: string[]) => void;
}

const STEP_LABELS: Record<CheckinWorkflowStep['type'], string> = {
  if: '条件判断',
  navigate: '进入页面',
  click: '点击控件',
  fill: '填写内容',
  scroll: '滚动页面',
  drag: '拖拽控件',
  wait: '等待',
  assert: '检查结果',
  'leilei-daily': '一梦五千年专用流程',
};

type ClickStep = Extract<CheckinWorkflowStep, { type: 'click' }>;
type FillStep = Extract<CheckinWorkflowStep, { type: 'fill' }>;
type ScrollStep = Extract<CheckinWorkflowStep, { type: 'scroll' }>;
type DragStep = Extract<CheckinWorkflowStep, { type: 'drag' }>;
type PointerAnchor = NonNullable<ClickStep['anchor']>;
type ClickGesture = NonNullable<ClickStep['gesture']>;
type ClickKey = NonNullable<ClickStep['key']>;
type FormControl = NonNullable<FillStep['control']>;

/**
 * 联合类型新增成员时这里会编译失败 —— 强制作者补齐编辑器 UI，
 * 而不是让新步骤悄悄落到「未知步骤」分支。
 */
function assertNeverStep(value: never): never {
  throw new Error(`不支持的工作流步骤类型: ${String(value)}`);
}

/** 学习到的选择器常是 text=可见文字，展示时剥掉语法。 */
function selectorLabel(selector: string): string {
  const trimmed = selector.trim();
  return trimmed.startsWith('text=') ? trimmed.slice('text='.length).trim() : trimmed;
}

/** scroll/drag 的说明由本组件兜底：workflow-form 的通用文案不认识新步骤。 */
function describeStep(step: CheckinWorkflowStep): string {
  if (step.type === 'scroll') {
    const target = `滚动到 ${Math.round(step.ratio * 100)}%`;
    return step.container ? `在「${selectorLabel(step.container)}」${target}` : `把页面${target}`;
  }
  if (step.type === 'drag') {
    const from = `「${selectorLabel(step.selector)}」`;
    const to = `「${selectorLabel(step.toSelector)}」`;
    return `把 ${from} 拖到 ${to}`;
  }
  return describeWorkflowStep(step);
}

/**
 * 输入框里呈现 0..1 的比例。
 *
 * 存下来的必须是数字：非法输入（如 `abc`）会得到 NaN，保存时被校验器拒绝，
 * 这正是我们要的行为 —— 宁可拒绝，也不把不可执行的坐标写进 storage。
 */
function ratioFromInput(raw: string): number {
  return raw.trim() === '' ? 0 : Number(raw);
}

function anchorPatch(current: PointerAnchor | undefined, key: 'rx' | 'ry', raw: string): PointerAnchor {
  const base: PointerAnchor = { rx: current?.rx ?? 0.5, ry: current?.ry ?? 0.5 };
  const value = ratioFromInput(raw);
  return key === 'rx' ? { ...base, rx: value } : { ...base, ry: value };
}

function integerOrUndefined(raw: string): number | undefined {
  return raw.trim() === '' ? undefined : Number(raw);
}

function createStep(type: CheckinWorkflowStep['type']): CheckinWorkflowStep {
  switch (type) {
    case 'if':
      return {
        type: 'if',
        condition: { type: 'text', words: ['今日已签到'] },
        then: [{ type: 'assert', text: ['今日已签到'], result: 'already' }],
        else: [],
      };
    case 'navigate': return { type: 'navigate', url: '/profile' };
    case 'click': return { type: 'click', selector: 'button' };
    case 'fill': return { type: 'fill', selector: 'textarea', value: '{{claimText}}' };
    case 'wait': return { type: 'wait', ms: 500 };
    case 'assert': return { type: 'assert', text: ['签到成功'], result: 'success' };
    case 'scroll': return { type: 'scroll', ratio: 1 };
    case 'drag': return { type: 'drag', selector: '.drag-source', toSelector: '.drag-target' };
    case 'leilei-daily': return { type: 'leilei-daily' };
    default: return assertNeverStep(type);
  }
}

function updateAt(
  steps: CheckinWorkflowStep[],
  index: number,
  update: (step: CheckinWorkflowStep) => CheckinWorkflowStep,
): CheckinWorkflowStep[] {
  return steps.map((step, current) => current === index ? update(step) : step);
}

function withCondition(step: Extract<CheckinWorkflowStep, { type: 'if' }>, condition: CheckinWorkflowCondition): CheckinWorkflowStep {
  return { ...step, condition };
}

function allowedTypes(depth: number, isRoot: boolean, index: number): CheckinWorkflowStep['type'][] {
  // scroll/drag 与 click/fill 一样是分支里的合法动作；只有 navigate 必须独占
  // 根级第一步，受限平台复合流程仍只放在根层级。
  const types: CheckinWorkflowStep['type'][] = ['if', 'click', 'fill', 'scroll', 'drag', 'wait', 'assert'];
  if (isRoot && index === 0) types.unshift('navigate');
  if (depth === 0) types.push('leilei-daily');
  return types;
}

function StepList({
  steps,
  onChange,
  depth,
  isRoot,
}: {
  steps: CheckinWorkflowStep[];
  onChange: (steps: CheckinWorkflowStep[]) => void;
  depth: number;
  isRoot: boolean;
}) {
  const [newType, setNewType] = useState<CheckinWorkflowStep['type']>('click');
  const addableTypes = allowedTypes(depth, isRoot, steps.length);

  return (
    <div className="space-y-2">
      {steps.map((step, index) => (
        <StepEditor
          key={`${depth}-${index}-${step.type}`}
          step={step}
          index={index}
          depth={depth}
          isRoot={isRoot}
          onChange={(next) => onChange(updateAt(steps, index, () => next))}
          onRemove={() => onChange(steps.filter((_, current) => current !== index))}
        />
      ))}
      {depth < 4 && (
        <div className="flex items-center gap-2">
          <select
            className={`${inputCls} min-w-0 flex-1 text-xs`}
            value={newType}
            onChange={(event) => setNewType(event.target.value as CheckinWorkflowStep['type'])}
          >
            {addableTypes.map((type) => <option key={type} value={type}>{STEP_LABELS[type]}</option>)}
          </select>
          <button
            type="button"
            className="shrink-0 rounded-lg bg-brand-500 px-3 py-2 text-xs font-medium text-white hover:bg-brand-600"
            onClick={() => onChange([...steps, createStep(newType)])}
          >
            添加步骤
          </button>
        </div>
      )}
      {steps.length === 0 && (
        <p className="rounded-lg border border-dashed border-black/10 px-3 py-2 text-[11px] text-ink-800/45 dark:border-white/10 dark:text-ink-100/40">
          还没有步骤。先添加一个点击、检查或条件判断。
        </p>
      )}
    </div>
  );
}

function StepEditor({
  step,
  index,
  depth,
  isRoot,
  onChange,
  onRemove,
}: {
  step: CheckinWorkflowStep;
  index: number;
  depth: number;
  isRoot: boolean;
  onChange: (step: CheckinWorkflowStep) => void;
  onRemove: () => void;
}) {
  const types = allowedTypes(depth, isRoot, index);

  const changeType = (type: CheckinWorkflowStep['type']) => onChange(createStep(type));
  const set = (patch: Partial<CheckinWorkflowStep>) => onChange({ ...step, ...patch } as CheckinWorkflowStep);

  return (
    <div className="rounded-xl border border-black/5 bg-white/70 p-3 dark:border-white/10 dark:bg-ink-800/60">
      <div className="mb-2 flex items-center gap-2">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-brand-500/10 text-[10px] font-semibold text-brand-700 dark:text-brand-300">
          {index + 1}
        </span>
        <select
          className={`${inputCls} min-w-0 flex-1 text-xs`}
          value={step.type}
          onChange={(event) => changeType(event.target.value as CheckinWorkflowStep['type'])}
        >
          {types.map((type) => <option key={type} value={type}>{STEP_LABELS[type]}</option>)}
        </select>
        <button type="button" className="shrink-0 text-xs text-rose-600 hover:text-rose-700" onClick={onRemove}>
          删除
        </button>
      </div>

      {/* 人话描述：只显示裸选择器时，用户看不出这一步到底在做什么。 */}
      <p className="mb-2 text-[11px] text-ink-800/55 dark:text-ink-100/45">{describeStep(step)}</p>

      {step.type === 'navigate' && (
        <Field label="同源路径">
          <input className={inputCls} value={step.url} onChange={(event) => set({ url: event.target.value })} placeholder="/profile" />
        </Field>
      )}

      {step.type === 'click' && (
        <div className="space-y-2">
          <Field label="控件选择器">
            <input className={inputCls} value={step.selector} onChange={(event) => set({ selector: event.target.value })} placeholder="button.checkin 或 text=立即签到" />
          </Field>
          <Field label="点击后等待出现（可选）">
            <input className={inputCls} value={step.waitFor ?? ''} onChange={(event) => set({ waitFor: event.target.value || undefined })} placeholder=".success-panel" />
          </Field>
          <details className="rounded-lg bg-ink-50 p-2 dark:bg-ink-900/60">
            <summary className="cursor-pointer text-[11px] font-medium text-ink-800/60 dark:text-ink-100/50">
              手势与落点（学习模式会自动记录）
            </summary>
            <div className="mt-2 space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <Field label="手势">
                  <select
                    className={inputCls}
                    aria-label="点击手势"
                    value={step.gesture ?? 'click'}
                    onChange={(event) => set({ gesture: event.target.value as ClickGesture })}
                  >
                    <option value="click">单击</option>
                    <option value="double">双击</option>
                    <option value="right">右键</option>
                    <option value="long-press">长按</option>
                  </select>
                </Field>
                <Field label="键盘触发">
                  <select
                    className={inputCls}
                    aria-label="键盘触发按键"
                    value={step.key ?? ''}
                    onChange={(event) => set({ key: (event.target.value || undefined) as ClickKey | undefined })}
                  >
                    <option value="">不按键</option>
                    <option value="Enter">Enter</option>
                    <option value="Space">空格</option>
                    <option value="Escape">Escape</option>
                    <option value="Tab">Tab</option>
                    <option value="ArrowUp">↑</option>
                    <option value="ArrowDown">↓</option>
                    <option value="ArrowLeft">←</option>
                    <option value="ArrowRight">→</option>
                  </select>
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Field label="落点横向比例 rx">
                  <input
                    className={inputCls}
                    inputMode="decimal"
                    aria-label="点击落点横向比例 rx"
                    value={step.anchor?.rx ?? ''}
                    onChange={(event) => set({ anchor: anchorPatch(step.anchor, 'rx', event.target.value) })}
                    placeholder="0.5"
                  />
                </Field>
                <Field label="落点纵向比例 ry">
                  <input
                    className={inputCls}
                    inputMode="decimal"
                    aria-label="点击落点纵向比例 ry"
                    value={step.anchor?.ry ?? ''}
                    onChange={(event) => set({ anchor: anchorPatch(step.anchor, 'ry', event.target.value) })}
                    placeholder="0.5"
                  />
                </Field>
              </div>
              <label className="flex items-center gap-2 text-[11px] text-ink-800/60 dark:text-ink-100/50">
                <input
                  type="checkbox"
                  checked={step.scrollIntoView === true}
                  onChange={(event) => set({
                    scrollIntoView: event.target.checked || undefined,
                    scrollContainer: event.target.checked ? step.scrollContainer : undefined,
                  })}
                />
                点击前先把控件滚进视口
              </label>
              {step.scrollIntoView && (
                <Field label="滚动容器（留空则滚页面）">
                  <input
                    className={inputCls}
                    value={step.scrollContainer ?? ''}
                    onChange={(event) => set({ scrollContainer: event.target.value || undefined })}
                    placeholder=".panel-body"
                  />
                </Field>
              )}
            </div>
          </details>
          <p className="text-[11px] text-ink-800/45 dark:text-ink-100/40">
            点击后会自动检查是否出现人机验证；没有验证的站点会直接继续，有验证的站点会等待处理完成。
          </p>
        </div>
      )}

      {step.type === 'scroll' && (
        <div className="space-y-2">
          <Field label="滚动位置（0 顶部，1 底部）">
            <input
              className={inputCls}
              inputMode="decimal"
              aria-label="滚动位置比例"
              value={step.ratio}
              onChange={(event) => set({ ratio: ratioFromInput(event.target.value) })}
              placeholder="1"
            />
          </Field>
          <Field label="滚动容器（留空则滚页面）">
            <input
              className={inputCls}
              value={step.container ?? ''}
              onChange={(event) => set({ container: event.target.value || undefined })}
              placeholder=".panel-body"
            />
          </Field>
          <Field label="滚动后等待稳定毫秒（可选）">
            <input
              className={inputCls}
              inputMode="numeric"
              value={step.settleMs ?? ''}
              onChange={(event) => set({ settleMs: event.target.value ? Number(event.target.value) : undefined })}
              placeholder="300"
            />
          </Field>
          <p className="text-[11px] text-ink-800/45 dark:text-ink-100/40">
            比例不会因页面变高而失效；滚到 1 可以触发无限滚动或懒加载。
          </p>
        </div>
      )}

      {step.type === 'drag' && (
        <div className="space-y-2">
          <Field label="起点控件选择器">
            <input className={inputCls} value={step.selector} onChange={(event) => set({ selector: event.target.value })} placeholder=".slider-handle" />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="起点 rx（可选）">
              <input
                className={inputCls}
                inputMode="decimal"
                aria-label="拖拽起点横向比例"
                value={step.anchor?.rx ?? ''}
                onChange={(event) => set({ anchor: anchorPatch(step.anchor, 'rx', event.target.value) })}
                placeholder="0.5"
              />
            </Field>
            <Field label="起点 ry（可选）">
              <input
                className={inputCls}
                inputMode="decimal"
                aria-label="拖拽起点纵向比例"
                value={step.anchor?.ry ?? ''}
                onChange={(event) => set({ anchor: anchorPatch(step.anchor, 'ry', event.target.value) })}
                placeholder="0.5"
              />
            </Field>
          </div>
          <Field label="终点控件选择器">
            <input className={inputCls} value={step.toSelector} onChange={(event) => set({ toSelector: event.target.value })} placeholder=".slider-track-end" />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="终点 rx（可选）">
              <input
                className={inputCls}
                inputMode="decimal"
                aria-label="拖拽终点横向比例"
                value={step.toAnchor?.rx ?? ''}
                onChange={(event) => set({ toAnchor: anchorPatch(step.toAnchor, 'rx', event.target.value) })}
                placeholder="1"
              />
            </Field>
            <Field label="终点 ry（可选）">
              <input
                className={inputCls}
                inputMode="decimal"
                aria-label="拖拽终点纵向比例"
                value={step.toAnchor?.ry ?? ''}
                onChange={(event) => set({ toAnchor: anchorPatch(step.toAnchor, 'ry', event.target.value) })}
                placeholder="0.5"
              />
            </Field>
          </div>
          <Field label="中间轨迹点数（0-200，可选）">
            <input
              className={inputCls}
              inputMode="numeric"
              value={step.steps ?? ''}
              onChange={(event) => set({ steps: integerOrUndefined(event.target.value) })}
              placeholder="20"
            />
          </Field>
          <label className="flex items-center gap-2 text-[11px] text-ink-800/60 dark:text-ink-100/50">
            <input
              type="checkbox"
              checked={step.scrollIntoView === true}
              onChange={(event) => set({
                scrollIntoView: event.target.checked || undefined,
                scrollContainer: event.target.checked ? step.scrollContainer : undefined,
              })}
            />
            拖拽前先把控件滚进视口
          </label>
          {step.scrollIntoView && (
            <Field label="滚动容器（留空则滚页面）">
              <input
                className={inputCls}
                value={step.scrollContainer ?? ''}
                onChange={(event) => set({ scrollContainer: event.target.value || undefined })}
                placeholder=".panel-body"
              />
            </Field>
          )}
        </div>
      )}

      {step.type === 'fill' && (
        <div className="space-y-2">
          <Field label="输入框选择器">
            <input className={inputCls} value={step.selector} onChange={(event) => set({ selector: event.target.value })} placeholder="textarea" />
          </Field>
          <Field label="填写内容">
            <input className={inputCls} value={step.value} onChange={(event) => set({ value: event.target.value })} placeholder="支持 {{claimText}}" />
          </Field>
          <Field label="控件种类">
            <select
              className={inputCls}
              aria-label="填写控件种类"
              value={step.control ?? 'text'}
              onChange={(event) => {
                const control = event.target.value as FormControl;
                const patch: Partial<FillStep> = { control };
                // 配套字段一并清掉，避免留下「文本框带下拉序号」这类校验必拒的组合。
                if (control === 'select') {
                  patch.choice = step.choice ?? 0;
                  patch.checked = undefined;
                } else if (control === 'checkbox' || control === 'radio') {
                  patch.checked = step.checked ?? true;
                  patch.choice = undefined;
                } else {
                  patch.choice = undefined;
                  patch.checked = undefined;
                }
                set(patch);
              }}
            >
              <option value="text">文本框</option>
              <option value="select">下拉选择</option>
              <option value="checkbox">勾选框</option>
              <option value="radio">单选框</option>
            </select>
          </Field>
          {step.control === 'select' && (
            <Field label="选中第几项（0 起）">
              <input
                className={inputCls}
                inputMode="numeric"
                value={step.choice ?? ''}
                onChange={(event) => set({ choice: integerOrUndefined(event.target.value) })}
                placeholder="0"
              />
            </Field>
          )}
          {(step.control === 'checkbox' || step.control === 'radio') && (
            <label className="flex items-center gap-2 text-[11px] text-ink-800/60 dark:text-ink-100/50">
              <input
                type="checkbox"
                checked={step.checked === true}
                onChange={(event) => set({ checked: event.target.checked })}
              />
              回放后应处于选中状态
            </label>
          )}
        </div>
      )}

      {step.type === 'wait' && (
        <div className="grid grid-cols-2 gap-2">
          <Field label="等待毫秒">
            <input className={inputCls} inputMode="numeric" value={step.ms ?? ''} onChange={(event) => set({ ms: event.target.value ? Number(event.target.value) : undefined, selector: undefined })} placeholder="500" />
          </Field>
          <Field label="或等待元素">
            <input className={inputCls} value={step.selector ?? ''} onChange={(event) => set({ selector: event.target.value || undefined, ms: undefined })} placeholder=".result" />
          </Field>
        </div>
      )}

      {step.type === 'assert' && (
        <div className="space-y-2">
          <Field label="检查元素（可选）">
            <input className={inputCls} value={step.selector ?? ''} onChange={(event) => set({ selector: event.target.value || undefined })} placeholder=".checked-in" />
          </Field>
          <Field label="检查文字（逗号分隔）">
            <input className={inputCls} value={(step.text ?? []).join(', ')} onChange={(event) => set({ text: event.target.value.split(',').map((word) => word.trim()).filter(Boolean) })} placeholder="签到成功, 今日已签到" />
          </Field>
          <Field label="命中后结果">
            <select className={inputCls} value={step.result ?? ''} onChange={(event) => set({ result: (event.target.value || undefined) as 'success' | 'already' | undefined })}>
              <option value="">仅检查，继续后续步骤</option>
              <option value="success">签到成功</option>
              <option value="already">今日已完成</option>
            </select>
          </Field>
        </div>
      )}

      {step.type === 'if' && (
        <div className="space-y-3">
          <div className="grid grid-cols-[auto_1fr] items-center gap-2">
            <span className="text-[11px] text-ink-800/55 dark:text-ink-100/45">判断类型</span>
            <select
              className={`${inputCls} text-xs`}
              value={step.condition.type}
              onChange={(event) => {
                const type = event.target.value as CheckinWorkflowCondition['type'];
                const condition: CheckinWorkflowCondition = type === 'text'
                  ? { type, words: ['今日已签到'] }
                  : type === 'selector'
                    ? { type, selector: '.checked-in' }
                    : { type, pattern: '/profile*' };
                onChange(withCondition(step, condition));
              }}
            >
              <option value="text">页面文字</option>
              <option value="selector">元素选择器</option>
              <option value="path">当前路径</option>
            </select>
          </div>
          {step.condition.type === 'text' && (
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <input className={inputCls} value={step.condition.words.join(', ')} onChange={
                (event) => onChange(withCondition(step, {
                  ...step.condition,
                  words: event.target.value.split(',').map((word) => word.trim()).filter(Boolean),
                } as CheckinWorkflowCondition))
              } placeholder="今日已签到, 已完成" />
              <select className={inputCls} value={step.condition.match ?? 'any'} onChange={
                (event) => onChange(withCondition(step, { ...step.condition, match: event.target.value as 'any' | 'all' } as CheckinWorkflowCondition))
              }>
                <option value="any">任一命中</option>
                <option value="all">全部命中</option>
              </select>
            </div>
          )}
          {step.condition.type === 'selector' && (
            <input className={inputCls} value={step.condition.selector} onChange={(event) => onChange(withCondition(step, { ...step.condition, selector: event.target.value } as CheckinWorkflowCondition))} placeholder=".checked-in" />
          )}
          {step.condition.type === 'path' && (
            <input className={inputCls} value={step.condition.pattern} onChange={(event) => onChange(withCondition(step, { ...step.condition, pattern: event.target.value } as CheckinWorkflowCondition))} placeholder="/profile*" />
          )}
          <div className="rounded-lg bg-ink-50 p-2 dark:bg-ink-900/60">
            <p className="mb-1 text-[11px] font-medium text-ink-800/60 dark:text-ink-100/50">条件成立时</p>
            <StepList steps={step.then} depth={depth + 1} isRoot={false} onChange={(then) => set({ then })} />
          </div>
          <div className="rounded-lg bg-ink-50 p-2 dark:bg-ink-900/60">
            <p className="mb-1 text-[11px] font-medium text-ink-800/60 dark:text-ink-100/50">条件不成立时（可选）</p>
            <StepList steps={step.else ?? []} depth={depth + 1} isRoot={false} onChange={(elseSteps) => set({ else: elseSteps })} />
          </div>
        </div>
      )}

      {step.type === 'leilei-daily' && (
        <p className="text-[11px] text-ink-800/50 dark:text-ink-100/40">
          这是受限平台复合流程；点击后的验证仍由通用认证检查处理。
        </p>
      )}
    </div>
  );
}

export function WorkflowBuilder({ steps, route, onChange, onChangeRoute }: Props) {
  return (
    <div className="space-y-3">
      {route && route.length > 0 && (
        <section
          aria-label="学习到的页面路线"
          className="rounded-xl border border-violet-200/60 bg-violet-50/60 p-2.5 dark:border-violet-500/20 dark:bg-violet-950/20"
        >
          <p className="text-[11px] font-medium text-violet-700 dark:text-violet-300">
            学习到的页面路线（自动签到会按这个顺序走，最后一项执行上面的步骤）
          </p>
          <ol className="mt-1.5 space-y-1">
            {route.map((page, index) => (
              <li key={`${index}-${page}`} className="flex items-center gap-2 text-[11px] text-ink-800/70 dark:text-ink-100/60">
                <span className="grid size-4 shrink-0 place-items-center rounded-full bg-violet-500/10 text-[10px] font-semibold text-violet-700 dark:text-violet-300">
                  {index + 1}
                </span>
                <code className="min-w-0 flex-1 truncate font-mono">{page}</code>
                {index === route.length - 1 && <span className="shrink-0 text-violet-600 dark:text-violet-400">← 签到页</span>}
                {/* 学错一页（典型是被重定向的登录页）时，用户必须能删掉；
                    否则路线上限在死循环里，除了重学一遍没有任何自救手段。 */}
                {onChangeRoute && (
                  <button
                    type="button"
                    title="从路线中删除这一页"
                    aria-label={`从路线中删除第 ${index + 1} 页 ${page}`}
                    className="shrink-0 text-[11px] text-rose-600 hover:text-rose-700 dark:text-rose-400"
                    onClick={() => onChangeRoute(removeRoutePage(route, index))}
                  >
                    删除
                  </button>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}
      <StepList steps={steps} onChange={onChange} depth={0} isRoot />
    </div>
  );
}
