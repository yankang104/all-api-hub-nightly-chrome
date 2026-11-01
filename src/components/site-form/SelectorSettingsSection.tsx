import { motion } from 'motion/react';
import type { SiteConfig } from '@/types';
import { COMMON_CLOSE_SELECTORS } from '@/sites';
import { Field, inputCls } from '../Modal';

type SiteFormValue = Omit<SiteConfig, 'id'>;

interface Props {
  form: SiteFormValue;
  advanced: boolean;
  onToggle: () => void;
  onChange: (patch: Partial<SiteFormValue>) => void;
}

export function SelectorSettingsSection({ form, advanced, onToggle, onChange }: Props) {
  return (
    <>
      <button
        type="button"
        onClick={onToggle}
        className="text-xs font-medium text-brand-600 hover:underline dark:text-brand-400"
      >
        {advanced ? '收起' : '展开'}登录表单选择器
      </button>

      {advanced && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          className="space-y-3 overflow-hidden rounded-xl bg-ink-50 p-3 dark:bg-ink-900/60"
        >
          <Field label="用户名输入框选择器">
            <input
              className={inputCls}
              value={form.selectors.username}
              onChange={(e) => onChange({ selectors: { ...form.selectors, username: e.target.value } })}
            />
          </Field>
          <Field label="密码输入框选择器">
            <input
              className={inputCls}
              value={form.selectors.password}
              onChange={(e) => onChange({ selectors: { ...form.selectors, password: e.target.value } })}
            />
          </Field>
          <Field label="登录按钮选择器">
            <input
              className={inputCls}
              value={form.selectors.submit}
              onChange={(e) => onChange({ selectors: { ...form.selectors, submit: e.target.value } })}
            />
          </Field>
          <Field label="公告弹窗关闭选择器" hint="每行一个，已预填常见中转站的通用选择器">
            <textarea
              rows={4}
              className={inputCls}
              value={(form.closeModalSelectors ?? []).join('\n')}
              onChange={(e) =>
                onChange({ closeModalSelectors: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })
              }
            />
          </Field>
          <button
            type="button"
            onClick={() => onChange({ closeModalSelectors: [...COMMON_CLOSE_SELECTORS] })}
            className="text-xs text-brand-600 hover:underline dark:text-brand-400"
          >
            重置为通用选择器
          </button>
        </motion.div>
      )}
    </>
  );
}
