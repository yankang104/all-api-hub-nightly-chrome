import type { ProxyConfig, SiteConfig } from '@/types';
import { Field, inputCls } from '../Modal';
import { effectiveProxyScheme } from '@/lib/proxy/proxy-config';

type SiteFormValue = Omit<SiteConfig, 'id'>;

interface Props {
  form: SiteFormValue;
  proxies: ProxyConfig[];
  onChange: (patch: Partial<SiteFormValue>) => void;
  /**
   * 地址填完后触发站点探测。
   *
   * 挂在 blur 而不是 onChange —— 探测要往站点发请求，
   * 每敲一个字符探一次既慢又是在刷别人的日志。
   */
  onUrlSettled?: (url: string) => void;
}

export function SiteBasicsSection({ form, proxies, onChange, onUrlSettled }: Props) {
  const usableProxies = proxies.filter((proxy) => proxy.nameOnly !== true);
  return (
    <>
      <Field label="登录页地址" hint="必填，例如 https://api.example.com/login">
        <input
          className={inputCls}
          placeholder="https://..."
          value={form.loginUrl}
          onChange={(e) => onChange({ loginUrl: e.target.value })}
          onBlur={(e) => onUrlSettled?.(e.target.value)}
        />
      </Field>

      <Field label="站点名称" hint="留空则自动使用域名">
        <input
          className={inputCls}
          placeholder="我的中转站"
          value={form.name}
          onChange={(e) => onChange({ name: e.target.value })}
        />
      </Field>

      <Field label="访问代理" hint={usableProxies.length ? '默认跟随 Chrome；只有需要强制指定出口时才选择' : '默认跟随 Chrome/系统网络设置'}>
        <select
          className={inputCls}
          value={form.proxyId ?? ''}
          onChange={(e) => onChange({ proxyId: e.target.value || undefined })}
        >
          <option value="">跟随 Chrome/系统代理（推荐）</option>
          {form.proxyId && proxies.find((proxy) => proxy.id === form.proxyId)?.nameOnly && (
            <option value={form.proxyId} disabled>
              {proxies.find((proxy) => proxy.id === form.proxyId)?.name}（仅名称，无出口）
            </option>
          )}
          {usableProxies.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} — {effectiveProxyScheme(p)}://{p.host}:{p.port}
            </option>
          ))}
        </select>
      </Field>
    </>
  );
}
