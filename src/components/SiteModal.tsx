import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Loader2, Save, UserPlus, Wand2 } from 'lucide-react';
import type { ProxyConfig, SiteConfig } from '@/types';
import type { BookmarkSiteImportResult } from '@/lib/backup/bookmark-import';
import { Modal, btnPrimary } from './Modal';
import { sendMessage } from '@/lib/core/messaging';
import { blankSite, matchTemplateByName, normalizedLoginUrl, SITE_TEMPLATES } from '@/sites';
import { hostOf } from '@/lib/core/date';
import { BookmarkImportPanel } from './BookmarkImportPanel';
import { CheckinMethodSection } from './site-form/CheckinMethodSection';
import { LoginMethodSection } from './site-form/LoginMethodSection';
import { SelectorSettingsSection } from './site-form/SelectorSettingsSection';
import { SiteBasicsSection } from './site-form/SiteBasicsSection';

interface Props {
  open: boolean;
  mode: 'add' | 'import';
  /** 传入则为编辑模式 */
  editing?: SiteConfig | null;
  /** 从“添加账号”进入时，明确告诉用户当前正在完成账号创建的前置步骤 */
  accountSetupRequested?: boolean;
  sites: SiteConfig[];
  proxies: ProxyConfig[];
  onClose: () => void;
  onSubmit: (site: Omit<SiteConfig, 'id'>) => Promise<void>;
  onSubmitAndAddAccount?: (site: Omit<SiteConfig, 'id'>) => Promise<void>;
  onSubmitMany?: (
    sites: Omit<SiteConfig, 'id'>[],
    options: { overwriteExisting: boolean },
  ) => Promise<BookmarkSiteImportResult>;
}

export function SiteModal({
  open,
  mode,
  editing,
  accountSetupRequested,
  sites,
  proxies,
  onClose,
  onSubmit,
  onSubmitAndAddAccount,
  onSubmitMany,
}: Props) {
  const [form, setForm] = useState<Omit<SiteConfig, 'id'>>(blankSite());
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** 已套用的模板名，用于提示用户「选择器已自动填好」 */
  const [templateApplied, setTemplateApplied] = useState<string | null>(null);
  /** 探测得出的依据，如「/api/v1/auth/me 的响应形状符合 Sub2API 系」 */
  const [probeEvidence, setProbeEvidence] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  /** 探过的地址，避免同一个地址反复往站点发请求 */
  const probedUrl = useRef('');

  useEffect(() => {
    if (!open) return;
    setForm(editing ? { ...editing } : blankSite());
    setAdvanced(!!editing);
    setError('');
    setTemplateApplied(null);
    setProbeEvidence(null);
    setProbing(false);
    probedUrl.current = '';
  }, [open, editing]);

  /**
   * 探测站点系统并套用预设。
   *
   * 域名里的关键词只够认出「叫这个名字」的站点，白标站点（百倍就是）
   * 域名和标题都不提自己跑的是什么，只能问后端。所以在用户填完地址后
   * 真去探一次，把选择器、签到方式、token 配置一并填好。
   */
  const runProbe = async (url: string) => {
    const target = url.trim();
    if (!target || editing || target === probedUrl.current) return;
    probedUrl.current = target;

    setProbing(true);
    try {
      const response = await sendMessage({ type: 'PROBE_SITE', url: target });
      const probe = response.ok ? response.feature?.probe : undefined;
      // unknown 只表示没有归入既有协议族；精确主机模板（如 Hvoy/Linux.SB）
      // 仍可能提供完整的站点预设。只要后台确实返回 preset，就可以安全套用。
      if (!probe || !probe.preset) {
        // 探不出来不改用户已填的东西，让他手动配
        setProbeEvidence(null);
        return;
      }
      setTemplateApplied(probe.templateLabel ?? null);
      setProbeEvidence(probe.evidence);
      // 优先用探测命中的模板归一登录地址：未知域名按名字匹配不到，
      // 新版 new-api 站点就会留在不存在的 /login 上。
      const template = (probe.templateId ? SITE_TEMPLATES.find((item) => item.id === probe.templateId) : undefined)
        ?? matchTemplateByName(target);
      const loginUrl = normalizedLoginUrl(target, template);
      setForm((current) => ({ ...current, ...probe.preset, name: current.name, loginUrl }));
    } finally {
      setProbing(false);
    }
  };

  const valid = form.loginUrl.trim().length > 0;

  /**
   * 改表单字段。
   *
   * 新建站点时，一旦登录地址里能认出站点系统（域名含 sub2api / new-api 之类），
   * 就顺手把选择器和签到方式填好 —— 用户不必去查「密码框的 CSS 选择器是什么」。
   * 只在新建、且用户还没手动改过选择器时套用，免得覆盖用户自己的配置。
   */
  const patchForm = (patch: Partial<Omit<SiteConfig, 'id'>>) => {
    const next = { ...form, ...patch };

    if (!editing && patch.loginUrl !== undefined && !templateApplied) {
      const template = matchTemplateByName(patch.loginUrl);
      if (template) {
        const loginUrl = normalizedLoginUrl(patch.loginUrl, template);
        setTemplateApplied(template.label);
        setForm({ ...next, ...template.preset, name: next.name, loginUrl });
        return;
      }
    }

    setForm(next);
  };
  const patchCheckin = (patch: Partial<NonNullable<SiteConfig['checkin']>>) =>
    setForm({ ...form, checkin: { ...(form.checkin ?? { method: 'auto' }), ...patch } });

  async function submit(addAccountAfterSave = false) {
    // 探测进行中保存会丢掉整份预设：结果回来时弹窗已关，落盘的是空白默认值。
    if (!valid || busy || probing) return;
    setBusy(true);
    setError('');
    try {
      const site = { ...form, name: form.name.trim() || hostOf(form.loginUrl) };
      if (addAccountAfterSave && onSubmitAndAddAccount) await onSubmitAndAddAccount(site);
      else await onSubmit(site);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '站点保存失败');
    } finally {
      setBusy(false);
    }
  }

  async function importBookmarks(
    sites: Omit<SiteConfig, 'id'>[],
    options: { overwriteExisting: boolean },
  ): Promise<void> {
    if (sites.length === 0 || busy) return;
    setBusy(true);
    setError('');
    try {
      if (!onSubmitMany) throw new Error('批量书签导入不可用');
      await onSubmitMany(sites, options);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '书签导入失败');
    } finally {
      setBusy(false);
    }
  }

  const title = editing
    ? '编辑站点'
    : mode === 'import'
      ? '从书签导入站点'
      : accountSetupRequested
        ? '先添加所属站点'
        : '添加站点';

  return (
    <Modal open={open} title={title} onClose={() => !busy && onClose()} wide={!editing && mode === 'import'}>
      <div className="space-y-4">
        {!editing && mode === 'import' ? (
          <>
            <BookmarkImportPanel sites={sites} disabled={busy} onImport={importBookmarks} />
            {error && <p role="alert" className="text-xs text-rose-600 dark:text-rose-400">{error}</p>}
          </>
        ) : (
          <>
            {accountSetupRequested && !editing && (
              <div className="rounded-lg border border-brand-500/15 bg-brand-500/[0.06] px-3 py-2 text-xs leading-relaxed text-ink-800/70 dark:border-brand-400/15 dark:bg-brand-400/[0.08] dark:text-ink-100/65">
                添加账号需要先选择所属站点。保存这个站点后，将继续填写账号信息。
              </div>
            )}

            <SiteBasicsSection
              form={form}
              proxies={proxies}
              onChange={patchForm}
              onUrlSettled={(url) => void runProbe(url)}
            />

            {/* 底色原为 bg-ink-500/8，但 ink-500 未在 tailwind.css 定义，是死类 */}
            {probing && (
              <div className="flex items-center gap-2 rounded-lg bg-ink-100/70 px-3 py-2 text-[11px] text-ink-800/60 dark:bg-white/8 dark:text-ink-100/50">
                <Loader2 className="size-3.5 shrink-0 animate-spin" />
                <span>正在识别站点系统…</span>
              </div>
            )}

            {!probing && templateApplied && (
              <div className="flex items-start gap-2 rounded-lg bg-brand-500/8 px-3 py-2 text-[11px] text-brand-700 dark:text-brand-300">
                <Wand2 className="mt-px size-3.5 shrink-0" />
                <span>
                  已识别为 <strong className="font-medium">{templateApplied}</strong>，
                  已自动填好本站适配设置。自动识别与学习流程回放可在下方独立选择。
                  {/* 把判据一并说出来：探测偶尔会认错，用户看到依据才能判断信不信 */}
                  {probeEvidence && (
                    <span className="mt-0.5 block opacity-60">依据：{probeEvidence}</span>
                  )}
                </span>
              </div>
            )}
            <LoginMethodSection form={form} onChange={patchForm} />
            <CheckinMethodSection form={form} onChange={patchCheckin} />
            <SelectorSettingsSection
              form={form}
              advanced={advanced}
              onToggle={() => setAdvanced(!advanced)}
              onChange={patchForm}
            />

            {error && <p role="alert" className="text-xs text-rose-600 dark:text-rose-400">{error}</p>}
            {editing ? (
              <motion.button
                whileTap={{ scale: 0.98 }}
                type="button"
                disabled={!valid || busy}
                onClick={() => void submit()}
                className={`${btnPrimary} inline-flex items-center justify-center gap-1.5`}
              >
                {busy ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                {busy ? '保存中...' : '保存修改'}
              </motion.button>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                <motion.button
                  whileTap={{ scale: 0.98 }}
                  type="button"
                  disabled={!valid || busy || probing}
                  onClick={() => void submit()}
                  className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-ink-50 px-4 py-2.5 text-sm font-medium text-ink-800 ring-1 ring-black/5 transition-colors hover:bg-ink-100 disabled:opacity-40 dark:bg-white/5 dark:text-ink-100 dark:ring-white/10 dark:hover:bg-white/10"
                >
                  <Save className="size-4" />
                  仅保存站点
                </motion.button>
                <motion.button
                  whileTap={{ scale: 0.98 }}
                  type="button"
                  disabled={!valid || busy || probing}
                  onClick={() => void submit(true)}
                  className={`${btnPrimary} inline-flex items-center justify-center gap-1.5`}
                >
                  {busy ? <Loader2 className="size-4 animate-spin" /> : <UserPlus className="size-4" />}
                  {busy ? '保存中...' : accountSetupRequested ? '保存并继续' : '保存并添加账号'}
                </motion.button>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
