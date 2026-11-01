import { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, KeyRound, Pencil, Plus, Trash2 } from 'lucide-react';
import type { CredentialKind, CredentialPreset } from '@/types/credential';
import { useCredentialPresets } from '@/lib/credential/use-credential-presets';
import { useAppStore } from '@/stores/app-store';
import { Modal, Field, inputCls, btnPrimary } from './Modal';

interface Props {
  open: boolean;
  onClose: () => void;
}

const GROUPS: { kind: CredentialKind; title: string }[] = [
  { kind: 'site', title: '站点账号' },
  { kind: 'github', title: 'GitHub 账号' },
];

function formatTime(timestamp: number): string {
  if (!timestamp) return '—';
  try {
    return new Date(timestamp).toLocaleString('zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '—';
  }
}

export function CredentialLibraryModal({ open, onClose }: Props) {
  const { presets, saveAsPreset, renamePreset, deletePreset } = useCredentialPresets();
  const sites = useAppStore((state) => state.sites);

  /** 正在明文显示密码的行（用户主动切换；绝不默认明文） */
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(new Set());
  const [confirmingId, setConfirmingId] = useState('');
  const [renamingId, setRenamingId] = useState('');
  const [renameDraft, setRenameDraft] = useState('');
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [formKind, setFormKind] = useState<CredentialKind>('site');
  const [formUsername, setFormUsername] = useState('');
  const [formPassword, setFormPassword] = useState('');
  const [formLabel, setFormLabel] = useState('');
  const [formSiteId, setFormSiteId] = useState('');
  const [saving, setSaving] = useState(false);
  const [formMessage, setFormMessage] = useState<{ type: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => () => {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
  }, []);

  /**
   * 关闭弹窗即恢复遮蔽，并清掉进行中的改名/删除确认态。
   *
   * 组件本身不随 open 卸载（由选择器一直挂着），不重置的话「显示密码」的
   * 明文状态与半截操作会在下次打开时原样出现。
   */
  useEffect(() => {
    if (open) return;
    setRevealed(new Set());
    setConfirmingId('');
    setRenamingId('');
  }, [open]);

  const groups = GROUPS.map((group) => ({
    ...group,
    presets: presets
      .filter((preset) => preset.kind === group.kind)
      .sort((a, b) => b.updatedAt - a.updatedAt),
  }));

  function toggleReveal(id: string) {
    setRevealed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleDelete(id: string) {
    if (confirmingId !== id) {
      setConfirmingId(id);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirmingId(''), 3000);
      return;
    }
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    setConfirmingId('');
    void deletePreset(id);
  }

  function startRename(preset: CredentialPreset) {
    setRenamingId(preset.id);
    setRenameDraft(preset.label ?? '');
  }

  async function commitRename(id: string) {
    await renamePreset(id, renameDraft);
    setRenamingId('');
  }

  function cancelRename() {
    setRenamingId('');
    setRenameDraft('');
  }

  async function submitAdd() {
    if (saving) return;
    setSaving(true);
    setFormMessage(null);
    const error = await saveAsPreset({
      kind: formKind,
      username: formUsername,
      password: formPassword,
      ...(formLabel.trim() ? { label: formLabel } : {}),
      ...(formKind === 'site' && formSiteId ? { siteId: formSiteId } : {}),
    });
    setSaving(false);
    if (error) {
      setFormMessage({ type: 'error', text: error });
      return;
    }
    setFormUsername('');
    setFormPassword('');
    setFormLabel('');
    setFormMessage({ type: 'ok', text: '已保存到常用凭据' });
  }

  return (
    <Modal open={open} title="管理常用凭据" onClose={onClose} wide>
      <div className="space-y-4">
        {presets.length === 0 && (
          <div className="rounded-xl border border-dashed border-ink-200 px-4 py-8 text-center dark:border-ink-700">
            <KeyRound className="mx-auto size-6 text-ink-800/25 dark:text-ink-100/20" />
            <p className="mt-2 text-xs font-medium text-ink-800/65 dark:text-ink-100/55">还没有保存的常用凭据</p>
            <p className="mt-1 text-[11px] text-ink-800/40 dark:text-ink-100/30">
              在账号表单里点「将当前输入存为常用」，或直接用下面的表单新增
            </p>
          </div>
        )}

        {groups.map((group) => group.presets.length > 0 && (
          <section key={group.kind} className="space-y-1.5">
            <h4 className="text-[11px] font-semibold uppercase tracking-wide text-ink-800/50 dark:text-ink-100/40">
              {group.title}
            </h4>
            {group.presets.map((preset) => {
              const name = preset.label || preset.username;
              const isRevealed = revealed.has(preset.id);
              const isConfirming = confirmingId === preset.id;
              const isRenaming = renamingId === preset.id;
              return (
                <div key={preset.id} data-kind={preset.kind} className="rounded-lg bg-ink-50 p-3 ring-1 ring-black/5 dark:bg-ink-900 dark:ring-white/10">
                  <div className="flex items-center gap-2">
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                        preset.kind === 'github'
                          ? 'bg-purple-500/10 text-purple-700 dark:text-purple-300'
                          : 'bg-sky-500/10 text-sky-700 dark:text-sky-300'
                      }`}
                    >
                      {preset.kind === 'github' ? 'GitHub' : '站点'}
                    </span>

                    {isRenaming ? (
                      <div className="flex min-w-0 flex-1 items-center gap-1">
                        <input
                          className="min-w-0 flex-1 rounded-md bg-white px-2 py-1 text-xs text-ink-900 outline-none ring-1 ring-black/10 dark:bg-ink-800 dark:text-ink-50 dark:ring-white/10"
                          value={renameDraft}
                          onChange={(event) => setRenameDraft(event.target.value)}
                          placeholder="备注（留空清除）"
                        />
                        <button
                          type="button"
                          aria-label="确认改名"
                          onClick={() => void commitRename(preset.id)}
                          className="shrink-0 rounded-md px-1.5 py-1 text-[11px] font-semibold text-brand-600 hover:bg-brand-500/10 dark:text-brand-400"
                        >
                          保存
                        </button>
                        <button
                          type="button"
                          aria-label="取消改名"
                          onClick={cancelRename}
                          className="shrink-0 rounded-md px-1.5 py-1 text-[11px] text-ink-800/50 hover:bg-black/5 dark:text-ink-100/50 dark:hover:bg-white/10"
                        >
                          取消
                        </button>
                      </div>
                    ) : (
                      <div className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium text-ink-900 dark:text-ink-50">{name}</span>
                        <span className="block truncate text-[11px] text-ink-800/45 dark:text-ink-100/35">{preset.username}</span>
                      </div>
                    )}

                    <time className="shrink-0 text-[10px] tabular-nums text-ink-800/40 dark:text-ink-100/30">
                      {formatTime(preset.updatedAt)}
                    </time>

                    {!isRenaming && (
                      <button
                        type="button"
                        aria-label={`改名 ${name}`}
                        onClick={() => startRename(preset)}
                        className="shrink-0 rounded-md p-1.5 text-ink-800/50 hover:bg-black/5 dark:text-ink-100/50 dark:hover:bg-white/10"
                      >
                        <Pencil className="size-3.5" />
                      </button>
                    )}

                    <button
                      type="button"
                      aria-label={isConfirming ? `确认删除 ${name}` : `删除 ${name}`}
                      onClick={() => handleDelete(preset.id)}
                      className={
                        isConfirming
                          ? 'shrink-0 rounded-md bg-rose-500 px-2 py-1 text-[10px] font-semibold text-white'
                          : 'shrink-0 rounded-md p-1.5 text-rose-500 hover:bg-rose-500/10'
                      }
                    >
                      {isConfirming ? '确认删除' : <Trash2 className="size-3.5" />}
                    </button>
                  </div>

                  <div className="mt-1.5 flex items-center gap-2">
                    <input
                      readOnly
                      type={isRevealed ? 'text' : 'password'}
                      value={preset.password}
                      aria-label={`${name} 的密码`}
                      className="min-w-0 flex-1 rounded-md bg-white px-2 py-1 font-mono text-[11px] text-ink-800/70 outline-none ring-1 ring-black/5 dark:bg-ink-800 dark:text-ink-100/60 dark:ring-white/10"
                    />
                    <button
                      type="button"
                      onClick={() => toggleReveal(preset.id)}
                      aria-label={isRevealed ? `隐藏 ${name} 的密码` : `显示 ${name} 的密码`}
                      className="shrink-0 rounded-md p-1.5 text-ink-800/50 hover:bg-black/5 dark:text-ink-100/50 dark:hover:bg-white/10"
                    >
                      {isRevealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                    </button>
                  </div>
                </div>
              );
            })}
          </section>
        ))}

        <section className="rounded-xl bg-ink-50 p-3 ring-1 ring-black/5 dark:bg-ink-900/60 dark:ring-white/10">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-ink-900 dark:text-ink-50">
            <Plus className="size-3.5" />
            新增凭据
          </p>
          <div className="mt-2 space-y-2">
            <Field label="类型">
              <select
                className={inputCls}
                value={formKind}
                onChange={(event) => setFormKind(event.target.value as CredentialKind)}
              >
                <option value="site">站点账号</option>
                <option value="github">GitHub 账号</option>
              </select>
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="用户名">
                <input
                  className={inputCls}
                  value={formUsername}
                  onChange={(event) => setFormUsername(event.target.value)}
                  placeholder="用户名"
                />
              </Field>
              <Field label="密码" hint="仅保存在本机浏览器">
                <input
                  type="password"
                  className={inputCls}
                  value={formPassword}
                  onChange={(event) => setFormPassword(event.target.value)}
                  placeholder="密码"
                />
              </Field>
            </div>
            <Field label="备注" hint="可选，用于区分同站多账号">
              <input
                className={inputCls}
                value={formLabel}
                onChange={(event) => setFormLabel(event.target.value)}
                placeholder="备注（可选）"
              />
            </Field>
            {formKind === 'site' && (
              <Field label="来源站点" hint="可选；选了之后会在这个站点的候选里排最前">
                <select
                  className={inputCls}
                  value={formSiteId}
                  onChange={(event) => setFormSiteId(event.target.value)}
                >
                  <option value="">不指定（任意站点可用）</option>
                  {sites.map((site) => (
                    <option key={site.id} value={site.id}>
                      {site.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <button type="button" className={btnPrimary} disabled={saving} onClick={() => void submitAdd()}>
              {saving ? '保存中…' : '保存凭据'}
            </button>
            {formMessage && (
              <p
                role="status"
                className={`text-[11px] ${
                  formMessage.type === 'error' ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'
                }`}
              >
                {formMessage.text}
              </p>
            )}
          </div>
        </section>
      </div>
    </Modal>
  );
}
