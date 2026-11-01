/**
 * 「学习登录」链路的持久化补丁、读回校验与同源闸门。
 *
 * 这里放的全是**纯函数**：background entrypoint 只负责 IO（读写 storage、发消息），
 * 判定逻辑集中在这里，才能在单测里覆盖「保存 → 读回 → 校验」整条接缝 ——
 * 只比 `steps.length` 或只信写入接口返回成功，正是「回报告诉用户已保存、
 * 下次自动签到却找不到控件」这类事故的来源。
 */
import type { Account, LoginMethod, SiteConfig } from '@/types';
import type { LearnedLoginSettings } from '@/automation/learning/learning';
import { hasUnstableIdSelector } from '@/automation/learning/learning';

/**
 * 录制会话期望的站点源（scheme + host + port）。
 *
 * 站点地址不合法时返回 null —— 调用方对 null 一律按「拒绝」处理，绝不按
 * 「没有限制」处理：拿不到期望源时放行，等于把 OAuth 供应商页面的选择器
 * 学成本站配置。
 */
export function learningSiteOrigin(site: Pick<SiteConfig, 'loginUrl'> | undefined | null): string | null {
  if (!site) return null;
  try {
    const origin = new URL(site.loginUrl).origin;
    return origin && origin !== 'null' ? origin : null;
  } catch {
    return null;
  }
}

/**
 * 学习事件只接受来自站点自身源的页面。
 *
 * 为什么必须有：学习标签页会跳到 OAuth 供应商（github.com 等）等外域页面，
 * 那些页面上的采集脚本也会上报事件；事件里的 path 只是 `pathname + hash`，
 * 落盘后无法与原站页面区分 —— 学出的选择器就成了 GitHub 登录框的选择器。
 * 发送方 URL 是唯一能拿到真实源的证据。
 */
export function isLearningSenderSameOrigin(
  senderUrl: string | null | undefined,
  siteOrigin: string | null,
): boolean {
  if (!siteOrigin || !senderUrl) return false;
  try {
    return new URL(senderUrl).origin === siteOrigin;
  } catch {
    return false;
  }
}

/**
 * 完成登录学习时要写回站点的补丁。
 *
 * 两条规则：
 * 1. 只写演示到的东西（选择器 / 入口 / OAuth 按钮），其余字段不碰；
 * 2. **清掉与本次学习方式矛盾的旧入口字段** —— 重新学习是「用新的替换旧的」，
 *    不是「新旧混合」：
 *    - OAuth 学习：只保留**与 OAuth 按钮配套演示过**的前置入口；演示里没有
 *      （或那个入口是表单动作）时清空旧值。旧表单的展开选择器绝不能和 OAuth
 *      按钮拼成一对 —— 回放时点它可能反而把第三方登录区藏起来；
 *    - form 学习：回放不经过 clickOAuthButton，旧 OAuth 入口清空；演示里没有
 *      前置入口时也把旧值清空 —— 表单已经能直接看到时，旧的前置点击可能反而
 *      把表单切走。
 *    空串与「未配置」在回放侧等价（所有消费点都是 `?.trim()` 后判真值）。
 */
export function planLearnedLoginPatch(
  learned: LearnedLoginSettings,
  site: SiteConfig,
): Partial<SiteConfig> {
  const patch: Partial<SiteConfig> = {};
  if (learned.loginMethod) patch.loginMethod = learned.loginMethod;
  if (learned.loginUrl) patch.loginUrl = learned.loginUrl;
  if (learned.selectors) patch.selectors = { ...site.selectors, ...learned.selectors };
  if (learned.loginMethod === 'form' || learned.loginMethod === 'oauth') {
    patch.preLoginClickSelectors = learned.preLoginClickSelectors ?? [];
  }

  if (learned.loginMethod === 'oauth') {
    if (learned.oauthButtonSelector) patch.oauthButtonSelector = learned.oauthButtonSelector;
    patch.preLoginClickSelector = learned.preLoginClickSelector?.trim() || '';
  } else if (learned.loginMethod === 'form') {
    patch.preLoginClickSelector = learned.preLoginClickSelector?.trim() || '';
    patch.oauthButtonSelector = '';
  } else {
    // 兼容分支：没有明确登录方式的配置只写明确学到的字段，不动入口。
    if (learned.preLoginClickSelector) patch.preLoginClickSelector = learned.preLoginClickSelector;
    if (learned.oauthButtonSelector) patch.oauthButtonSelector = learned.oauthButtonSelector;
  }

  return patch;
}

/**
 * 读回校验：学到的登录配置必须**完整且一致**地落到了站点上。
 *
 * 校验的是「可回放性」而不是「写没写」：
 * - 方式与选择器按方式配套（form 必须有账号/密码；oauth 必须有按钮）；
 * - 选择器不得含自动生成 id（写进去等于随机点一个控件）；
 * - 入口字段必须与方式一致，且旧入口确实被清理（`planLearnedLoginPatch` 的镜像）。
 */
/**
 * 学到的登录配置保存在站点级，运行时是「账号覆盖 → 站点默认」。
 * 账号若还留着旧的 loginMethod，会继续压过刚学到的站点配置，表现就是
 * 「学习登录已经保存，自动登录却仍走旧流程」。
 *
 * 学习完成时只清除与学到方式冲突的账号级覆盖；方式一致时保留（可能是用户
 * 特意固定），同站其它账号也一律不动。
 */
export function planLearnedLoginAccountPatch(
  learned: Pick<LearnedLoginSettings, 'loginMethod'>,
  account: Pick<Account, 'loginMethod'>,
): Partial<Account> {
  if (!learned.loginMethod || !account.loginMethod || account.loginMethod === learned.loginMethod) {
    return {};
  }
  // 空字符串在 mergeAccountUpdate 中会被解释为「清掉账号级覆盖」。
  return { loginMethod: '' as LoginMethod };
}

/**
 * 学到的登录方式要改写站点默认值时，**同站其它账号**该怎么办。
 *
 * 登录方式本质上是「这个账号怎么进去」：同站常有账密账号与第三方登录账号并存。
 * 站点默认值被一次 OAuth 演示改成 oauth 后，所有「跟随站点」的账密账号会一起改走
 * OAuth —— 它们并没有可用的第三方会话，第二天全部登录失败。
 *
 * 规则：只有站点默认登录方式**真的变了**，才把其它「跟随站点」的账号固定到旧的
 * 默认值上（它们此前就是这样登录成功的）；已经显式设置过的账号一律不动。
 * 学习账号本身由 `planLearnedLoginAccountPatch` 负责，这里排除它。
 */
export function planSiblingLoginMethodPins(
  learned: Pick<LearnedLoginSettings, 'loginMethod'>,
  site: Pick<SiteConfig, 'loginMethod'>,
  siblings: readonly Pick<Account, 'id' | 'loginMethod'>[],
  learningAccountId: string,
): Array<{ accountId: string; patch: Partial<Account> }> {
  const previous: LoginMethod = site.loginMethod || 'form';
  if (!learned.loginMethod || learned.loginMethod === previous) return [];
  return siblings
    .filter((account) => account.id !== learningAccountId && !account.loginMethod)
    .map((account) => ({ accountId: account.id, patch: { loginMethod: previous } }));
}

export function verifyLearnedLoginStored(
  learned: LearnedLoginSettings,
  stored: SiteConfig | undefined,
): { ok: true } | { ok: false; error: string } {
  if (!stored) return { ok: false, error: '学习登录配置写入后无法读回站点' };
  if (learned.loginMethod !== 'form' && learned.loginMethod !== 'oauth') {
    return { ok: false, error: '学习登录配置缺少可回放的登录方式' };
  }
  if (learned.loginMethod === 'form' && (!learned.selectors?.username || !learned.selectors?.password)) {
    return { ok: false, error: '学习登录配置不完整（缺少账号或密码字段）' };
  }
  if (learned.loginMethod === 'oauth' && !learned.oauthButtonSelector) {
    return { ok: false, error: '学习登录配置不完整（缺少 OAuth 按钮）' };
  }
  if (learned.loginUrl && stored.loginUrl !== learned.loginUrl) {
    return { ok: false, error: '学习登录配置写入后登录页面不一致' };
  }
  if (JSON.stringify(stored.preLoginClickSelectors ?? []) !== JSON.stringify(learned.preLoginClickSelectors ?? [])) {
    return { ok: false, error: '学习登录配置写入后前置点击顺序不一致' };
  }
  for (const selector of [...(learned.preLoginClickSelectors ?? []), learned.preLoginClickSelector, learned.oauthButtonSelector]) {
    if (selector && hasUnstableIdSelector(selector)) {
      return { ok: false, error: '学习登录配置包含不可回放的选择器' };
    }
  }
  for (const [key, value] of Object.entries(learned.selectors ?? {})) {
    if (typeof value !== 'string' || !value.trim() || hasUnstableIdSelector(value)) {
      return { ok: false, error: `学习登录配置包含不可回放的选择器：${key}` };
    }
    if (stored.selectors?.[key as keyof SiteConfig['selectors']] !== value) {
      return { ok: false, error: `学习登录配置写入后字段选择器不一致：${key}` };
    }
  }
  if (stored.loginMethod !== learned.loginMethod) {
    return { ok: false, error: '学习登录配置写入后登录方式不一致' };
  }

  if (learned.loginMethod === 'oauth') {
    if (stored.oauthButtonSelector !== learned.oauthButtonSelector) {
      return { ok: false, error: '学习登录配置写入后 OAuth 按钮不一致' };
    }
    if ((stored.preLoginClickSelector ?? '') !== (learned.preLoginClickSelector?.trim() || '')) {
      return { ok: false, error: '学习登录配置写入后 OAuth 入口不一致（不允许旧表单入口残留）' };
    }
    return { ok: true };
  }

  if ((stored.preLoginClickSelector ?? '') !== (learned.preLoginClickSelector?.trim() || '')) {
    return { ok: false, error: '学习登录配置写入后登录入口不一致' };
  }
  if ((stored.oauthButtonSelector ?? '') !== '') {
    return { ok: false, error: '学习登录配置写入后仍残留旧 OAuth 入口' };
  }
  return { ok: true };
}
