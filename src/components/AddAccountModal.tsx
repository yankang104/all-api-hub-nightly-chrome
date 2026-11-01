import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import type { Account, AccountProxyMode, LoginMethod, ProxyConfig, SiteConfig } from '@/types';
import { DEFAULT_LOGIN_METHOD, loginCredentialNeeds } from '@/lib/checkin/effective-method';
import { usesCheckinWorkflow } from '@/lib/checkin/learned-checkin';
import { resolveSharedLearnedCheckin } from '@/lib/checkin/shared-learned-flow';
import { Modal, Field, inputCls, btnPrimary } from './Modal';
import { CredentialPicker } from './CredentialPicker';
import {
  isSelectableLoginMethod,
  LOGIN_METHOD_LABELS,
  LOGIN_METHOD_OPTIONS,
} from './login-method-options';

interface Props {
  open: boolean;
  sites: SiteConfig[];
  proxies: ProxyConfig[];
  defaultSiteId?: string;
  /** 传入则为编辑模式：改已有账号的密码/token/代理，而不是新建 */
  editing?: Account | null;
  onClose: () => void;
  onSubmit: (input: Omit<Account, 'id'>) => Promise<void>;
}

const PROXY_MODES: { value: AccountProxyMode; label: string }[] = [
  { value: 'inherit', label: '跟随站点设置' },
  { value: 'none', label: '不使用代理（直连）' },
  { value: 'pool', label: '选择已保存的代理' },
  { value: 'custom', label: '为这个账号单独填地址' },
];

const FOLLOW_SITE = '';

export function AddAccountModal({ open, sites, proxies, defaultSiteId, editing, onClose, onSubmit }: Props) {
  const [siteId, setSiteId] = useState(defaultSiteId ?? sites[0]?.id ?? '');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [label, setLabel] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [loginMethod, setLoginMethod] = useState<LoginMethod | ''>(FOLLOW_SITE);
  const [githubUsername, setGithubUsername] = useState('');
  const [githubPassword, setGithubPassword] = useState('');
  const [passkey, setPasskey] = useState(false);
  const [proxyMode, setProxyMode] = useState<AccountProxyMode>('inherit');
  const [proxyId, setProxyId] = useState('');
  const [customScheme, setCustomScheme] = useState<'http' | 'https' | 'socks4' | 'socks5'>('http');
  const [customHost, setCustomHost] = useState('');
  const [customPort, setCustomPort] = useState('');
  const [customUser, setCustomUser] = useState('');
  const [customPass, setCustomPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const usableProxies = proxies.filter((proxy) => proxy.nameOnly !== true);

  /**
   * 只在弹窗从关闭变成打开的那一刻初始化表单。
   *
   * 不能直接跟着 [open, editing, sites] 每次变化就重跑：sites 来自 store，
   * 任何一次广播（签到状态变了、抓到登录态）都会换一个新数组引用，effect 跟着重跑，
   * 会把用户正在输入的密码当场清掉或回填成旧值。
   */
  const wasOpen = useRef(false);

  useEffect(() => {
    const justOpened = open && !wasOpen.current;
    wasOpen.current = open;
    if (!justOpened) return;
    setError('');

    if (!editing) {
      // 上一次打开的可能是「编辑账号」。不清干净就会把别人的用户名、密码、token
      // 留在「添加账号」的表单里 —— 一路点下去就是拿 A 账号的凭据新建了个 B。
      reset();
      setSiteId(defaultSiteId ?? sites[0]?.id ?? '');
      return;
    }

    // 编辑模式：把已有值全部回填。
    // 密码和 token 也照填 —— 留空会让用户以为「不改就行」，
    // 但提交时空值会把原来的凭据清掉。
    setSiteId(editing.siteId);
    setUsername(editing.username);
    setPassword(editing.password ?? '');
    setLabel(editing.label ?? '');
    setApiToken(editing.apiToken ?? '');
    setGithubUsername(editing.githubUsername ?? '');
    setGithubPassword(editing.githubPassword ?? '');
    setPasskey(editing.passkey ?? false);
    setLoginMethod(editing.loginMethod ?? FOLLOW_SITE);
    setProxyMode(editing.proxyMode ?? 'inherit');
    setProxyId(editing.proxyId ?? '');
    setCustomScheme(editing.customProxy?.scheme ?? 'http');
    setCustomHost(editing.customProxy?.host ?? '');
    setCustomPort(editing.customProxy?.port ? String(editing.customProxy.port) : '');
    setCustomUser(editing.customProxy?.username ?? '');
    setCustomPass(editing.customProxy?.password ?? '');
  }, [open, editing, defaultSiteId, sites]);

  const site = sites.find((s) => s.id === siteId);
  const siteLoginMethod = site?.loginMethod ?? DEFAULT_LOGIN_METHOD;
  // 本卡没学过、但同一域名的另一张卡学过时，签到会共用那一份（见 shared-learned-flow.ts）。
  const hasCheckinWorkflow = !!site && (usesCheckinWorkflow(site) || !!resolveSharedLearnedCheckin(site, sites).sharedFrom);
  const loginAsCheckin = site?.checkin?.method === 'none';
  /**
   * 账号级覆盖优先于站点默认值 —— 用户在这里选了 token，
   * 下面就该出 token 输入框，而不是继续按站点配置显示密码框。
   */
  const effectiveLoginMethod = loginMethod || siteLoginMethod;
  const legacyLoginMethod = loginMethod && !isSelectableLoginMethod(loginMethod)
    ? loginMethod
    : null;
  /** 这种登录方式到底要哪些凭据，与引擎共用一份判断 */
  const needs = loginCredentialNeeds(effectiveLoginMethod);
  const preserveLegacyCredentials = !!editing
    && !isSelectableLoginMethod(effectiveLoginMethod)
    && password === (editing.password ?? '')
    && apiToken === (editing.apiToken ?? '')
    && githubUsername === (editing.githubUsername ?? '')
    && githubPassword === (editing.githubPassword ?? '')
    && passkey === (editing.passkey ?? false);

  /** 已经抓到过登录态 —— 有它就不需要手贴 token */
  const hasSession = !!editing?.identity?.session?.accessToken;

  // 按登录方式决定必填项：token 要 token，账密要密码，
  // OAuth 两个都不要（凭据是浏览器里第三方平台的登录态，扩展存不了）。
  // 已抓到登录态时 token 变成可选：会话本身就是凭据，
  // 强制要求手贴一个反而会逼用户去 F12 复制一个用不上的值。
  const credentialsOk = preserveLegacyCredentials || (
    needs.github
      ? githubUsername.trim().length > 0 && githubPassword.length > 0
      : needs.token
        ? apiToken.trim().length > 0 || (needs.sessionCounts && hasSession)
        : needs.password
          ? password.length > 0
          : true
  );
  const proxyOk = proxyMode === 'pool'
    ? !!proxyId
    : proxyMode === 'custom'
      ? customHost.trim().length > 0 && Number(customPort) > 0
      : true;
  const valid = siteId && username.trim() && credentialsOk && proxyOk;
  const proxySelectionChanged = proxyMode === 'pool' && (
    !editing
    || (editing.proxyMode ?? 'inherit') !== 'pool'
    || (editing.proxyId ?? '') !== proxyId
  );

  /** 清空除所属站点以外的所有字段。站点由调用方单独决定填什么。 */
  function reset() {
    setUsername('');
    setPassword('');
    setLabel('');
    setApiToken('');
    setGithubUsername('');
    setGithubPassword('');
    setPasskey(false);
    setLoginMethod(FOLLOW_SITE);
    setProxyMode('inherit');
    setProxyId('');
    setCustomScheme('http');
    setCustomHost('');
    setCustomPort('');
    setCustomUser('');
    setCustomPass('');
  }

  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    setError('');
    const normalizedUsername = username.trim();
    const normalizedToken = apiToken.trim();
    const normalizedGithubUsername = githubUsername.trim();
    const effectivePassword = needs.password ? password : '';
    const effectiveToken = needs.token ? normalizedToken : '';
    const effectiveGithubUsername = needs.github ? normalizedGithubUsername : '';
    const effectiveGithubPassword = needs.github ? githubPassword : '';
    const effectivePasskey = needs.passkey;

    // 未主动切换旧方式时原样保留凭据；否则显式清空新方式不再使用的字段。
    // 这样改备注或代理不会破坏旧 auto/token/oauth/passkey 账号，主动改为
    // form/github 时仍能清掉不再使用的 token、GitHub 密码和 passkey。
    const credentials = editing
      ? preserveLegacyCredentials
        ? {
            password: editing.password,
            ...(editing.apiToken !== undefined ? { apiToken: editing.apiToken } : {}),
            ...(editing.githubUsername !== undefined ? { githubUsername: editing.githubUsername } : {}),
            ...(editing.githubPassword !== undefined ? { githubPassword: editing.githubPassword } : {}),
            ...(editing.passkey !== undefined ? { passkey: editing.passkey } : {}),
          }
        : {
            password: effectivePassword,
            apiToken: effectiveToken,
            githubUsername: effectiveGithubUsername,
            githubPassword: effectiveGithubPassword,
            passkey: effectivePasskey,
          }
      : {
          password: effectivePassword,
          ...(effectiveToken ? { apiToken: effectiveToken } : {}),
          ...(effectiveGithubUsername ? { githubUsername: effectiveGithubUsername } : {}),
          ...(effectiveGithubPassword ? { githubPassword: effectiveGithubPassword } : {}),
          ...(effectivePasskey ? { passkey: true } : {}),
        };

    // 身份快照（尤其是抓取的 session）必须与凭据绑定。用户改 token、账号名或
    // 登录方式后继续复用旧 session，会让新 token 根本不生效，甚至把旧账号当成新账号。
    const previousLoginMethod = editing?.loginMethod || siteLoginMethod;
    const authChanged = !!editing && (
      editing.username !== normalizedUsername
      || previousLoginMethod !== effectiveLoginMethod
      // 只比较当前方式真正会读取的凭据。旧版本留下的无关密码/token 会在本次
      // 保存时被清理，但不应因此把仍然有效的 OAuth/Passkey 身份一起清掉。
      || (needs.password && (editing.password ?? '') !== effectivePassword)
      || (needs.token && (editing.apiToken ?? '') !== effectiveToken)
      || (needs.github && (
        (editing.githubUsername ?? '') !== effectiveGithubUsername
        || (editing.githubPassword ?? '') !== effectiveGithubPassword
      ))
    );
    // Token 模式允许只依赖已抓取的 session。切换到 token 时若因此清掉 identity，
    // 表单虽然能保存，下一次运行却会立刻报「没有登录凭据」。
    const keepCapturedSession = !!editing
      && needs.token
      && !normalizedToken
      && hasSession
      && editing.username === normalizedUsername;
    const shouldClearIdentity = authChanged && !keepCapturedSession;

    try {
      await onSubmit({
        siteId,
        username: normalizedUsername,
        ...credentials,
        label: label.trim() || undefined,
        // 编辑时用空字符串明确清掉旧的账号级覆盖；单纯省略字段会被
        // updateAccount 的浅合并保留下来，界面显示「跟随」但实际仍走旧配置。
        ...(editing
          ? {
              loginMethod: (loginMethod || '') as LoginMethod,
            }
          : {
              ...(loginMethod ? { loginMethod } : {}),
            }),
        // 仅凭据变化时显式清空身份。未变化时不要把打开弹窗时的旧快照写回，
        // 否则会覆盖后台任务刚刷新出的 session。
        ...(shouldClearIdentity ? { identity: {} } : {}),
        proxyMode,
        ...(proxyMode === 'pool' && proxyId
          ? { proxyId, ...(proxySelectionChanged ? { proxyPinned: true } : {}) }
          : {}),
        ...(proxyMode === 'custom'
          ? {
              customProxy: {
                scheme: customScheme,
                host: customHost.trim(),
                port: Number(customPort),
                ...(customUser.trim() ? { username: customUser.trim() } : {}),
                ...(customPass ? { password: customPass } : {}),
              },
            }
          : {}),
      });
      // 编辑模式不清空：下次打开会由 effect 重新回填，
      // 这里清了反而会让关闭动画期间字段闪空
      if (!editing) reset();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '账号保存失败');
    } finally {
      // 存储失败时也要恢复按钮，否则弹窗会永久停在「保存中」。
      setBusy(false);
    }
  }

  return (
    <Modal open={open} title={editing ? '编辑账号' : '添加账号'} onClose={() => !busy && onClose()}>
      <div className="space-y-4">
        <Field label="所属站点" hint={editing ? '账号归属不能改；要换站点请新建一个账号' : undefined}>
          <select
            className={inputCls}
            value={siteId}
            // 编辑时锁死：换了站点，密码/token/抓来的会话全都对不上新站点了
            disabled={!!editing}
            onChange={(e) => setSiteId(e.target.value)}
          >
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="登录方式"
          hint="留空跟随站点配置。同一站点有的账号用账密、有的用 OAuth 时才需要单独选"
        >
          <select
            className={inputCls}
            value={loginMethod}
            onChange={(e) => setLoginMethod(e.target.value as LoginMethod | '')}
          >
            <option value={FOLLOW_SITE}>
              跟随站点设置（当前：{LOGIN_METHOD_LABELS[siteLoginMethod]}）
            </option>
            {legacyLoginMethod && (
              <option value={legacyLoginMethod} disabled>
                当前兼容配置：{LOGIN_METHOD_LABELS[legacyLoginMethod]}
              </option>
            )}
            {LOGIN_METHOD_OPTIONS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="签到流程"
          hint="本站所有账号共用。学习结果保存在站点设置，只用于登录后的签到。"
        >
          <div className="rounded-lg border border-brand-500/15 bg-brand-500/[0.06] px-3 py-2 text-xs text-ink-800/75 dark:border-brand-400/15 dark:bg-brand-400/[0.08] dark:text-ink-100/70">
            <strong className="font-semibold text-brand-700 dark:text-brand-300">{hasCheckinWorkflow ? '学习流程回放' : loginAsCheckin ? '登录即签到' : site?.checkin?.method && site.checkin.method !== 'auto' ? '本站适配' : '自动识别'}</strong>
            <p className="mt-1 leading-relaxed">先登录并确认账号 → {hasCheckinWorkflow ? '执行本站已保存的签到流程' : loginAsCheckin ? '登录成功后直接视为签到完成，不再寻找签到按钮' : '自动完成签到；可从账号旁「学习本站流程」一次教会登录与签到'}</p>
          </div>
        </Field>

        {needs.password && (
          <CredentialPicker
            kind="site"
            siteId={siteId}
            excludeAccountId={editing?.id}
            username={username}
            password={password}
            disabled={busy}
            onPick={(picked) => {
              setUsername(picked.username);
              setPassword(picked.password);
            }}
          />
        )}

        <Field
          label={needs.password ? '站点账号' : '账号标识'}
          hint={needs.password ? '用于站点自身的账密登录' : '用于核对实际登录的是不是本账号'}
        >
          <input className={inputCls} value={username} onChange={(e) => setUsername(e.target.value)} placeholder="站点用户名或邮箱" />
        </Field>

        {needs.password && (
          <Field label="站点密码" hint="仅保存在本机浏览器，不会上传">
            <input
              type="password"
              className={inputCls}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="站点登录密码"
            />
          </Field>
        )}

        {needs.github && (
          <div className="space-y-3 rounded-xl bg-ink-50 p-3 dark:bg-ink-900/60">
            <p className="text-xs font-medium text-ink-800 dark:text-ink-100">GitHub 凭据</p>
            <CredentialPicker
              kind="github"
              siteId={siteId}
              excludeAccountId={editing?.id}
              username={githubUsername}
              password={githubPassword}
              disabled={busy}
              onPick={(picked) => {
                setGithubUsername(picked.username);
                setGithubPassword(picked.password);
              }}
            />
            <Field label="GitHub 用户名或邮箱" hint="仅在跳转到 github.com 授权页时自动填写">
              <input className={inputCls} value={githubUsername} onChange={(e) => setGithubUsername(e.target.value)} placeholder="GitHub 用户名或邮箱" />
            </Field>
            <Field label="GitHub 密码" hint="仅保存在本机；绝不会派发到站点或其他第三方页面">
              <input type="password" className={inputCls} value={githubPassword} onChange={(e) => setGithubPassword(e.target.value)} placeholder="GitHub 登录密码" />
            </Field>
          </div>
        )}

        {needs.passkey && (
          <div className="rounded-xl bg-ink-50 p-3 text-[11px] leading-relaxed text-ink-800/60 dark:bg-ink-900/60 dark:text-ink-100/50">
            将使用浏览器/系统保存的 Passkey。扩展不会保存或模拟 Passkey 私钥；签到时会点站点的 Passkey 按钮，并等待你在原生系统提示中确认。
          </div>
        )}

        {needs.token ? (
          <Field
            label={hasSession ? 'API Token（可留空）' : 'API Token'}
            /**
             * 推荐的路径是「抓取登录态」而不是手贴 token ——
             * 手贴的是短命的 access token，过几分钟到几小时就失效；
             * 抓取会连 refresh token 一起拿到，能自己续期。
             */
            hint={
              hasSession
                ? `已抓取登录态（${new Date(editing!.identity!.session!.capturedAt).toLocaleString('zh-CN')}），不用填 token`
                : `推荐：在站点手动登录后，用账号行上的钥匙按钮「抓取登录态」。也可手填 ${site?.tokenConfig?.storageKey || 'token'} 的值（会较快过期）`
            }
          >
            <input
              type="password"
              className={inputCls}
              value={apiToken}
              onChange={(e) => setApiToken(e.target.value)}
              placeholder={hasSession ? '已有登录态，留空即可' : 'eyJhbGciOi...'}
            />
          </Field>
        ) : null}

        <Field label="备注" hint="可选，用于区分同站多个账号">
          <input className={inputCls} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="小号 / 主号" />
        </Field>

        <Field label="代理" hint="同一站点的不同账号可以走不同出口">
          <select
            className={inputCls}
            value={proxyMode}
            onChange={(e) => setProxyMode(e.target.value as AccountProxyMode)}
          >
            {PROXY_MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </Field>

        {proxyMode === 'pool' && (
          <Field label="选择代理" hint={usableProxies.length ? undefined : '还没有可用出口，请先在代理管理里同步 Clash Verge 配置'}>
            <select className={inputCls} value={proxyId} onChange={(e) => setProxyId(e.target.value)}>
              <option value="">请选择</option>
              {editing?.proxyId && proxies.find((proxy) => proxy.id === editing.proxyId)?.nameOnly && (
                <option value={editing.proxyId} disabled>
                  {proxies.find((proxy) => proxy.id === editing.proxyId)?.name}（仅名称，无出口）
                </option>
              )}
              {usableProxies.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}（{p.scheme}://{p.host}:{p.port}）
                </option>
              ))}
            </select>
          </Field>
        )}

        {proxyMode === 'custom' && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            className="space-y-3 overflow-hidden rounded-xl bg-ink-50 p-3 dark:bg-ink-900/60"
          >
            <Field label="协议">
              <select
                className={inputCls}
                value={customScheme}
                onChange={(e) => setCustomScheme(e.target.value as typeof customScheme)}
              >
                <option value="http">HTTP</option>
                <option value="https">HTTPS</option>
                <option value="socks5">SOCKS5</option>
                <option value="socks4">SOCKS4</option>
              </select>
            </Field>
            <Field label="地址">
              <input
                className={inputCls}
                value={customHost}
                onChange={(e) => setCustomHost(e.target.value)}
                placeholder="127.0.0.1"
              />
            </Field>
            <Field label="端口">
              <input
                className={inputCls}
                inputMode="numeric"
                value={customPort}
                onChange={(e) => setCustomPort(e.target.value.replace(/\D/g, ''))}
                placeholder="7890"
              />
            </Field>
            <Field label="认证" hint="可选，需要账号密码的代理才填">
              <div className="grid grid-cols-2 gap-2">
                <input
                  className={inputCls}
                  value={customUser}
                  onChange={(e) => setCustomUser(e.target.value)}
                  placeholder="用户名"
                />
                <input
                  type="password"
                  className={inputCls}
                  value={customPass}
                  onChange={(e) => setCustomPass(e.target.value)}
                  placeholder="密码"
                />
              </div>
            </Field>
          </motion.div>
        )}

        {error && <p role="alert" className="text-xs text-rose-600 dark:text-rose-400">{error}</p>}
        <motion.button whileTap={{ scale: 0.98 }} type="button" disabled={!valid || busy} onClick={() => void submit()} className={btnPrimary}>
          {busy ? '保存中...' : '保存账号'}
        </motion.button>
      </div>
    </Modal>
  );
}
