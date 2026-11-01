export interface PageAvailabilityIssue {
  message: string;
  retryable: boolean;
}

const RETRYABLE_HTTP_CODES = new Set([500, 502, 503, 504, 520, 521, 522, 523, 524, 530]);

/**
 * 403 页面：站点明确拒绝这次访问。
 *
 * 单独识别它的价值在于**下一步完全不同**：503 是等站点恢复，403 通常要换出口
 * 地区或换账号，而选择器/登录表单的排查方向一律是错的。旧实现只认 5xx，
 * 403 页面会一路走到「找不到用户名输入框」，用户拿着一个选择器问题去改配置，
 * 永远修不好。`retryable: false`：同样的 IP、同样的地区，重试多少次都是 403。
 */
function detectAccessDenied(text: string, title: string): string | null {
  // 标题里的 403 是最强信号（浏览器错误页与多数拒绝页都把它放在最前面）。
  if (/(?:^|[\s|:：-])403(?:[\s|:：-]|$)/.test(title) && /forbidden|denied|禁止|拒绝|无权限/i.test(`${title}\n${text}`)) {
    return '站点返回 403 Forbidden（访问被拒绝）';
  }
  if (/\b403\s+forbidden\b/i.test(text)) return '站点返回 403 Forbidden（访问被拒绝）';
  if (/(?:error\s*code|http\s*error|状态码|错误码)\s*[:：]?\s*403\b/i.test(text)) {
    return '站点返回 403 Forbidden（访问被拒绝）';
  }
  // 地区限制的常见说法：必须同时出现拒绝语境，避免把正文里提到「地区」的
  // 普通页面误判成封锁。
  if (/(?:not\s+available\s+in\s+your\s+(?:region|country)|access\s+denied|国家\/?地区.{0,6}(?:不支持|受限|限制)|根据你所在的地区|地区限制)/i.test(text)
    && /(?:403|forbidden|denied|blocked|restricted)/i.test(text)) {
    return '站点限制了当前地区 / 出口的访问（访问被拒绝）';
  }
  return null;
}

/** 识别真实站点的 5xx/托管故障页与 403 拒绝页，避免把网络/权限问题误报成表单选择器问题。 */
export function detectPageAvailabilityIssue(): PageAvailabilityIssue | null {
  const title = document.title ?? '';
  /**
   * 优先 innerText（只取可见文字，能避开隐藏模板里的错误页文案）；
   * 无 innerText 的环境（jsdom、极少数嵌入式文档）回落到 textContent ——
   * 宁可多读一点，也不能因为读不到就整段判断失效。
   */
  const body = (document.body?.innerText ?? document.body?.textContent ?? '').slice(0, 12_000);
  const text = `${title}\n${body}`;

  /**
   * 403 必须在 5xx 之前判：Cloudflare 的 403 页面正文里常同时出现
   * 「Error 1020 / 5xx」字样与「Access denied」，先判 5xx 会把地区封锁
   * 说成「站点暂时不可用，稍后重试」—— 用户等一天也不会好。
   */
  const denied = detectAccessDenied(text, title);
  if (denied && !/\b5\d{2}\b/.test(title)) {
    return { message: denied, retryable: false };
  }

  const codeText = title.match(/(?:^|\|)\s*(5\d{2})\s*:/)?.[1]
    ?? text.match(/(?:error\s*code|http\s*error)\s*(5\d{2})/i)?.[1];
  const hasGatewayFailure = /bad\s*gateway|service\s*unavailable|gateway\s*time-?out/i.test(text);
  const hasCloudflareHostFailure = /cloudflare[\s\S]{0,800}host[\s\S]{0,80}error/i.test(text)
    || /the\s+web\s+server\s+reported\s+a\s+bad\s+gateway/i.test(text);

  if (!codeText && !hasGatewayFailure && !hasCloudflareHostFailure) return null;

  const code = codeText ? Number(codeText) : 502;
  const provider = hasCloudflareHostFailure ? 'Cloudflare 显示 Host Error' : '站点服务暂不可用';
  return {
    message: `站点源服务器返回 ${code}（${provider}）`,
    retryable: RETRYABLE_HTTP_CODES.has(code),
  };
}

