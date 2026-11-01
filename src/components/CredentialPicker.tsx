import { useEffect, useRef, useState } from 'react';
import type { CredentialCandidate, CredentialKind } from '@/types/credential';
import { useCredentialPresets } from '@/lib/credential/use-credential-presets';
import { Field, inputCls } from './Modal';
import { CredentialLibraryModal } from './CredentialLibraryModal';

interface Props {
  kind: CredentialKind;
  siteId: string;
  /** 编辑账号时排除自身，避免「从自己复制自己」 */
  excludeAccountId?: string;
  /** 当前表单里的用户名与密码（用于「将当前输入存为常用」） */
  username: string;
  password: string;
  disabled?: boolean;
  /**
   * 选中候选后回填账号表单。
   * ⚠️ 密码只经此路径写入表单的 type=password 输入框，绝不以任何文本渲染。
   */
  onPick: (value: { username: string; password: string }) => void;
}

/**
 * 候选 option 文本：备注/用户名 + 来源站点 + 使用账号数。
 *
 * ⚠️ 安全红线：这里只能拼展示性字段（label/siteName/accountCount），
 * 绝不能把 candidate.password 放进文本、value、title 或 aria-label。
 */
function candidateText(candidate: CredentialCandidate): string {
  const parts = [candidate.label || candidate.username];
  if (candidate.siteName) parts.push(` · ${candidate.siteName}`);
  if ((candidate.accountCount ?? 1) > 1) parts.push(`（${candidate.accountCount} 个账号）`);
  return parts.join('');
}

export function CredentialPicker({
  kind,
  siteId,
  excludeAccountId,
  username,
  password,
  disabled,
  onPick,
}: Props) {
  const { optionsFor, markUsed, saveAsPreset } = useCredentialPresets();
  const options = optionsFor(kind, siteId, { excludeAccountId });

  const [selected, setSelected] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{ type: 'ok' | 'error'; text: string } | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 卸载时清掉未到期的提示计时器，避免对已卸载组件 setState
  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
  }, []);

  function flashNotice(text: string) {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice(text);
    noticeTimer.current = setTimeout(() => setNotice(''), 2600);
  }

  function handlePick(selectedId: string) {
    // 无论选中什么，下拉都复位成「手动输入」，不遮挡用户后续手输
    setSelected('');
    if (!selectedId) return;
    const candidate = options.find((option) => option.id === selectedId);
    if (!candidate) return;
    onPick({ username: candidate.username, password: candidate.password });
    markUsed(candidate);
    flashNotice(`已填入 ${candidate.label || candidate.username}`);
  }

  async function handleSave() {
    if (saving) return;
    setSaving(true);
    setSaveMessage(null);
    const error = await saveAsPreset({ kind, username, password, siteId });
    setSaving(false);
    setSaveMessage(error
      ? { type: 'error', text: error }
      : { type: 'ok', text: '已保存，之后可直接在下拉中选择' });
  }

  const fieldLabel = kind === 'github' ? '选择已保存的 GitHub 账号' : '选择已保存的站点账号';
  const canSave = username.trim().length > 0 && password.length > 0;

  return (
    <div className="rounded-xl bg-ink-50 p-3 ring-1 ring-black/5 dark:bg-ink-900/60 dark:ring-white/10">
      <Field label={fieldLabel}>
        <select
          className={inputCls}
          value={selected}
          disabled={disabled || options.length === 0}
          onChange={(event) => handlePick(event.target.value)}
        >
          <option value="">手动输入</option>
          {options.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidateText(candidate)}
            </option>
          ))}
        </select>
      </Field>

      {options.length === 0 && (
        <p className="mt-1.5 text-[11px] leading-relaxed text-ink-800/40 dark:text-ink-100/30">
          {kind === 'github'
            ? '还没有可选的 GitHub 凭据：保存过的 GitHub 账号或「存为常用」的凭据会自动出现在这里'
            : '还没有可选的站点凭据：本站（或同一登录主机）已保存的账号与常用凭据会自动出现在这里'}
        </p>
      )}

      {notice && (
        <p role="status" className="mt-1.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
          {notice}
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={disabled || saving || !canSave}
          className="text-[11px] font-medium text-brand-600 hover:underline disabled:cursor-default disabled:opacity-40 disabled:no-underline dark:text-brand-400"
        >
          {saving ? '保存中…' : '将当前输入存为常用'}
        </button>
        <button
          type="button"
          onClick={() => setLibraryOpen(true)}
          disabled={disabled}
          className="text-[11px] font-medium text-brand-600 hover:underline disabled:opacity-40 dark:text-brand-400"
        >
          管理常用凭据…
        </button>
      </div>

      {saveMessage && (
        <p
          role="status"
          className={`mt-1 text-[11px] ${
            saveMessage.type === 'error' ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'
          }`}
        >
          {saveMessage.text}
        </p>
      )}

      <CredentialLibraryModal open={libraryOpen} onClose={() => setLibraryOpen(false)} />
    </div>
  );
}
