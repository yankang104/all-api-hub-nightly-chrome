import type { LoginMethod } from '@/types';

export type SelectableLoginMethod = Extract<LoginMethod, 'form' | 'github'>;

/** 新建和编辑界面允许主动选择的登录方式。旧方式仍由运行时兼容。 */
export const LOGIN_METHOD_OPTIONS = [
  { value: 'form', label: '站点账号密码', description: '填站点用户名密码并提交，最常见' },
  { value: 'github', label: 'GitHub 账号密码', description: '点站点 OAuth 按钮，跳到 GitHub 后自动填 GitHub 账密' },
] as const satisfies readonly {
  value: SelectableLoginMethod;
  label: string;
  description: string;
}[];

/** 旧值只用于准确显示已有配置，不会重新出现在可选列表中。 */
export const LOGIN_METHOD_LABELS: Record<LoginMethod, string> = {
  form: '站点账号密码',
  github: 'GitHub 账号密码',
  passkey: 'Passkey 登录',
  oauth: '其他 OAuth 授权',
  token: 'API 通行令牌',
  auto: '自动检测',
};

export function isSelectableLoginMethod(method: LoginMethod): method is SelectableLoginMethod {
  return method === 'form' || method === 'github';
}
