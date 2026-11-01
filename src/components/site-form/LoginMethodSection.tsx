import { motion } from 'motion/react';
import type { SiteConfig } from '@/types';
import { cn } from '@/lib/core/cn';
import { Field, inputCls } from '../Modal';
import {
  isSelectableLoginMethod,
  LOGIN_METHOD_LABELS,
  LOGIN_METHOD_OPTIONS,
} from '../login-method-options';

type SiteFormValue = Omit<SiteConfig, 'id'>;

interface Props {
  form: SiteFormValue;
  onChange: (patch: Partial<SiteFormValue>) => void;
}

/** tokenConfig 的必填项有默认值，避免部分填写时产生不完整对象 */
const tokenDefaults = {
  storageKey: '',
  headerName: 'Authorization',
  headerPrefix: 'Bearer ',
} as const;

export function LoginMethodSection({ form, onChange }: Props) {
  const loginMethod = form.loginMethod ?? 'form';
  const legacyLoginMethod = isSelectableLoginMethod(loginMethod) ? null : loginMethod;

  return (
    <>
      {/* 登录方式 */}
      <div className="space-y-2">
        <span className="text-xs font-medium text-ink-800/70 dark:text-ink-100/60">登录方式</span>
        <div className="grid gap-2">
          {LOGIN_METHOD_OPTIONS.map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() => onChange({ loginMethod: m.value })}
              className={cn(
                'flex items-start gap-2.5 rounded-xl px-3 py-2.5 text-left transition-colors',
                loginMethod === m.value
                  ? 'bg-brand-500/10 ring-2 ring-brand-500/50'
                  : 'bg-ink-50 ring-1 ring-black/5 hover:bg-ink-100 dark:bg-ink-900 dark:ring-white/10',
              )}
            >
              <span
                className={cn(
                  'mt-0.5 size-3.5 shrink-0 rounded-full ring-2 transition-colors',
                  loginMethod === m.value ? 'bg-brand-500 ring-brand-500/40' : 'ring-black/15 dark:ring-white/20',
                )}
              />
              <span className="min-w-0">
                <span className="block text-xs font-medium text-ink-900 dark:text-ink-50">{m.label}</span>
                <span className="block text-[11px] text-ink-800/50 dark:text-ink-100/40">{m.description}</span>
              </span>
            </button>
          ))}
        </div>
        {legacyLoginMethod && (
          <p role="status" className="text-[11px] text-ink-800/45 dark:text-ink-100/40">
            当前兼容配置：{LOGIN_METHOD_LABELS[legacyLoginMethod]}
          </p>
        )}
      </div>

      {/* OAuth / GitHub / Passkey 按钮选择器 */}
      {(loginMethod === 'oauth' || loginMethod === 'github' || loginMethod === 'passkey' || loginMethod === 'auto') && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          className="space-y-3 overflow-hidden rounded-xl bg-ink-50 p-3 dark:bg-ink-900/60"
        >
          <Field
            label={loginMethod === 'passkey' ? 'Passkey 按钮选择器' : loginMethod === 'github' ? 'GitHub 按钮选择器' : 'OAuth 按钮选择器'}
            hint={loginMethod === 'oauth' ? '可选。留空会自动识别 GitHub/SSO 按钮；识别不准时再填精确选择器' : loginMethod === 'passkey' ? '可选。留空会自动识别 Passkey 按钮' : '可选。留空会自动识别 GitHub OAuth 按钮'}
          >
            <input
              className={inputCls}
              placeholder='text=使用 GitHub 继续, .oauth-github'
              value={form.oauthButtonSelector ?? ''}
              onChange={(e) => onChange({ oauthButtonSelector: e.target.value })}
            />
          </Field>
          <p className="text-[11px] leading-relaxed text-amber-700 dark:text-amber-400">
            {loginMethod === 'github' && '站点会点站点的 OAuth 按钮跳到 GitHub；扩展在 GitHub 登录页自动填 GitHub 账密。'}
            {loginMethod === 'passkey' && 'Passkey 会触发浏览器/系统原生确认；扩展不会保存或模拟 Passkey 私钥。'}
            {loginMethod === 'oauth' && 'OAuth 会优先使用上面的选择器；留空时会自动寻找 GitHub / Google / LinuxDO / SSO 登录按钮。浏览器里需要已经登录过对应平台，否则会停在授权页等你手动操作。'}
          </p>
        </motion.div>
      )}

      {/* Token 认证配置 */}
      {loginMethod === 'token' && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          className="space-y-3 overflow-hidden rounded-xl bg-ink-50 p-3 dark:bg-ink-900/60"
        >
          <Field label="Token 存储键名" hint="必填。站点把 token 存在哪个键下，F12 → Application → Local Storage 里能看到">
            <input
              className={inputCls}
              placeholder="auth_token"
              value={form.tokenConfig?.storageKey ?? ''}
              onChange={(e) => onChange({
                tokenConfig: { ...tokenDefaults, ...form.tokenConfig, storageKey: e.target.value },
              })}
            />
          </Field>
          <Field label="存储位置" hint="多数站点用 localStorage；关掉标签页就失效的站点用 sessionStorage">
            <select
              className={inputCls}
              value={form.tokenConfig?.storageType ?? 'localStorage'}
              onChange={(e) => onChange({
                tokenConfig: {
                  ...tokenDefaults,
                  ...form.tokenConfig,
                  storageType: e.target.value as 'localStorage' | 'sessionStorage',
                },
              })}
            >
              <option value="localStorage">localStorage</option>
              <option value="sessionStorage">sessionStorage</option>
            </select>
          </Field>
          <Field label="请求头名称" hint="必填。验证身份时用哪个头发 token，一般是 Authorization">
            <input
              className={inputCls}
              placeholder="Authorization"
              value={form.tokenConfig?.headerName ?? ''}
              onChange={(e) => onChange({
                tokenConfig: { ...tokenDefaults, ...form.tokenConfig, headerName: e.target.value },
              })}
            />
          </Field>
          <Field label="请求头前缀" hint="一般是 Bearer 加一个空格；有的站点不需要前缀，留空即可">
            <input
              className={inputCls}
              placeholder="Bearer "
              value={form.tokenConfig?.headerPrefix ?? ''}
              onChange={(e) => onChange({
                tokenConfig: { ...tokenDefaults, ...form.tokenConfig, headerPrefix: e.target.value },
              })}
            />
          </Field>
          <Field label="身份接口" hint="可选。留空会依次试 /api/user/self、/api/user/info、/api/v1/auth/me">
            <input
              className={inputCls}
              placeholder="/api/v1/auth/me"
              value={form.tokenConfig?.identityEndpoint ?? ''}
              onChange={(e) => onChange({
                tokenConfig: { ...tokenDefaults, ...form.tokenConfig, identityEndpoint: e.target.value },
              })}
            />
          </Field>
          <p className="text-[11px] leading-relaxed text-amber-700 dark:text-amber-400">
            Token 填在**每个账号**的设置里，这里只描述站点怎么存和怎么用。
            同一站点的多个账号各自持有独立 token，切换时会自动覆盖。
          </p>
        </motion.div>
      )}

      {/* 登录成功标志：所有登录方式都用它判断「打开时是否已登录」，不只 OAuth */}
      <Field
        label="登录成功标志选择器"
        hint="可选。只在登录后才出现的元素（控制台导航、头像菜单等）。打开站点时用它判断是否已经登录、提交登录后用它确认成功；留空则看登录表单是否消失、是否离开登录页"
      >
        <input
          className={inputCls}
          placeholder=".dashboard, #user-avatar"
          value={form.successIndicator ?? ''}
          onChange={(e) => onChange({ successIndicator: e.target.value })}
        />
      </Field>

      {/* 身份读取扩展（可选，默认关闭）：跨域接口 / 自定义存储键站点的身份核对 */}
      <div className="space-y-3 rounded-xl bg-ink-50 p-3 dark:bg-ink-900/60">
        <span className="text-xs font-medium text-ink-800/70 dark:text-ink-100/60">身份读取扩展（可选）</span>
        <p className="text-[11px] leading-relaxed text-ink-800/50 dark:text-ink-100/40">
          签到要核对「当前登录的是哪个账号」，而站点身份既不在同源接口、也不在页面文字上时填写
          （典型：页面在 orevx.ai、身份在 server.orevx.ai 的接口与 localStorage）。默认关闭；
          全部只读，不会写入任何存储，也不会把凭据发去无关主机。跨域接口的响应里带 points
          （总积分）时，本站余额也复用它读取 —— 不需要额外配置。
        </p>
        <Field label="身份存储键" hint="可选。站点把当前用户信息（JSON）存在哪个键下，如 orevx 的 auth-user">
          <input
            className={inputCls}
            placeholder="auth-user"
            value={form.identitySource?.storageKey ?? ''}
            onChange={(e) => onChange({
              identitySource: { ...form.identitySource, storageKey: e.target.value },
            })}
          />
        </Field>
        <Field label="身份存储位置" hint="可选。不确定就留在「自动」：依次查 localStorage 和 sessionStorage">
          <select
            className={inputCls}
            value={form.identitySource?.storageType ?? ''}
            onChange={(e) => onChange({
              identitySource: {
                ...form.identitySource,
                storageType: (e.target.value || undefined) as 'localStorage' | 'sessionStorage' | undefined,
              },
            })}
          >
            <option value="">自动（推荐）</option>
            <option value="localStorage">localStorage</option>
            <option value="sessionStorage">sessionStorage</option>
          </select>
        </Field>
        <Field label="跨域身份接口" hint="可选。仅 https，且必须是本站域名本身或其父/子域（orevx.ai ↔ server.orevx.ai）；只读 GET。响应里带 points 时该接口同时用于读取本站余额">
          <input
            className={inputCls}
            placeholder="https://server.orevx.ai/api/user/me"
            value={form.identitySource?.endpoint ?? ''}
            onChange={(e) => onChange({
              identitySource: { ...form.identitySource, endpoint: e.target.value },
            })}
          />
        </Field>
        <Field label="接口 Token 存储键" hint="填了跨域接口时必填。该接口用哪个存储键里的 token 做 Bearer 认证，如 auth-token">
          <input
            className={inputCls}
            placeholder="auth-token"
            value={form.identitySource?.tokenKey ?? ''}
            onChange={(e) => onChange({
              identitySource: { ...form.identitySource, tokenKey: e.target.value },
            })}
          />
        </Field>
        <Field label="Token 存储位置" hint="可选。不确定就留在「自动」">
          <select
            className={inputCls}
            value={form.identitySource?.tokenStorageType ?? ''}
            onChange={(e) => onChange({
              identitySource: {
                ...form.identitySource,
                tokenStorageType: (e.target.value || undefined) as 'localStorage' | 'sessionStorage' | undefined,
              },
            })}
          >
            <option value="">自动（推荐）</option>
            <option value="localStorage">localStorage</option>
            <option value="sessionStorage">sessionStorage</option>
          </select>
        </Field>
      </div>

      {/* 令牌引导：新版 new-api 分叉把访问令牌放在页面内存里，扩展默认请求头一律 401 */}
      <Field
        label="令牌引导接口"
        hint="可选。站点用「会话 cookie 换短命 Bearer 令牌」时填（新版 new-api 分叉常见，如一梦五千年的 /api/user/auth/refresh）。填了之后，扩展读余额与身份之前会先换一枚令牌再用 —— 否则这类站点的接口一律 401，余额和签到前后的快照都读不到。只允许本站同源地址"
      >
        <input
          className={inputCls}
          placeholder="/api/user/auth/refresh"
          value={form.authBootstrap?.endpoint ?? ''}
          onChange={(e) => onChange({
            authBootstrap: e.target.value.trim()
              ? { ...form.authBootstrap, endpoint: e.target.value }
              : undefined,
          })}
        />
      </Field>

      {/* 退出接口：切换账号的关键 */}
      <Field
        label="退出接口"
        hint="强烈建议填。同站多账号切换时，只有调它才能清掉服务端 cookie；不填则改用重载登录页，部分站点会失败"
      >
        <input
          className={inputCls}
          placeholder="/api/user/logout"
          value={form.logoutApiUrl ?? ''}
          onChange={(e) => onChange({ logoutApiUrl: e.target.value })}
        />
      </Field>

      {/* 账密表单被折叠时的前置点击 */}
      {(loginMethod === 'form' || loginMethod === 'auto') && (
        <Field
          label="展开表单的前置点击"
          hint="可选。新版 new-api 登录页要先点「使用 邮箱或用户名 登录」才出现账密框。可写 text=按钮文字"
        >
          <input
            className={inputCls}
            placeholder="text=使用 邮箱或用户名 登录"
            value={form.preLoginClickSelector ?? ''}
            onChange={(e) => onChange({ preLoginClickSelector: e.target.value })}
          />
        </Field>
      )}
    </>
  );
}
