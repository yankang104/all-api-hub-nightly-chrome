import type { CheckinWorkflowConfig, SiteConfig } from '@/types';

const MAX_WORKFLOW_STEPS = 30;
const MAX_TIMEOUT_MS = 30_000;
const MAX_CONDITION_DEPTH = 4;
const MAX_SELECTOR_LENGTH = 300;
const MAX_DRAG_STEPS = 200;
const MAX_FORM_CHOICE = 10_000;
/** 学习路线最多记住的页面数。手动签到经过的页面通常只有两三页，12 足够覆盖
 *  带中转页/弹窗页的流程，同时避免把一次乱点录成超长路线。 */
const MAX_ROUTE_LENGTH = 12;

/** 回放只允许非打印键：任何可打印字符一律拒绝，避免击键内容泄露与重建。 */
const WORKFLOW_KEYS = new Set([
  'Enter', 'Space', 'Escape', 'Tab',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
]);
const WORKFLOW_GESTURES = new Set(['click', 'double', 'right', 'long-press']);
const WORKFLOW_FORM_CONTROLS = new Set(['text', 'select', 'checkbox', 'radio']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteInRange(value: unknown, min = 0, max = MAX_TIMEOUT_MS): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function isZeroToOne(value: unknown): value is number {
  return finiteInRange(value, 0, 1);
}

/** 选择器必须是可执行、有界的普通字符串；长度上限同时约束 scrollContainer/container。 */
function isDrivableSelector(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= MAX_SELECTOR_LENGTH;
}

/** 滚动容器只接受安全 CSS 选择器，`text=` 语义选择器不参与滚动定位。 */
function isScrollContainer(value: unknown): value is string {
  return isDrivableSelector(value) && !value.includes('text=');
}

/**
 * 判断选择器里有没有写明 `http(s)://`、协议相对地址 `//host` 或裸域名含路径的跨站地址。
 * 正常结构选择器（如 `button.checkin`、`[data-href="/a"]`）不会被误伤；
 * 目的是拦住“把选择器当跳转地址写”的形态（运行时不会去访问，但会误导用户）。
 */
function hasCrossSiteUrl(selector: string): boolean {
  const trimmed = selector.trim();
  if (/^(?:https?:)?\/\//i.test(trimmed)) return true;
  return /(?:^|[\s,>+~])(?:[a-z0-9-]+\.)+[a-z]{2,}\//i.test(trimmed);
}

/**
 * click/fill/drag 共用的滚动字段规则：只有显式 `scrollIntoView === true` 才允许带
 * `scrollContainer`，且容器选择器必须是安全 CSS（非空、有上限、不写 `text=`）。
 */
function validateScrollFields(step: Record<string, unknown>, position: string, errors: string[]): void {
  if (step.scrollIntoView !== undefined && typeof step.scrollIntoView !== 'boolean') {
    errors.push(`${position}的 scrollIntoView 必须是布尔值`);
  }
  if (step.scrollContainer === undefined) return;
  if (!isScrollContainer(step.scrollContainer) || step.scrollIntoView !== true) {
    errors.push(`${position}的 scrollContainer 必须是启用滚动定位的 CSS 选择器`);
  }
}

/** 拖拽/点击共用的选择器规则：非空、有界，且不能写成跨站网址。 */
function validateSelectorField(step: Record<string, unknown>, field: string, position: string, errors: string[]): void {
  const value = step[field];
  if (typeof value !== 'string' || !value.trim()) {
    errors.push(`${position}缺少 ${field}`);
    return;
  }
  if (value.length > MAX_SELECTOR_LENGTH) {
    errors.push(`${position}的 ${field} 过长`);
    return;
  }
  if (hasCrossSiteUrl(value)) {
    errors.push(`${position}的 ${field} 不能包含跨站地址`);
  }
}

function validatePointerAnchor(value: unknown, field: string, position: string, errors: string[]): void {
  if (!isRecord(value) || !isZeroToOne(value.rx) || !isZeroToOne(value.ry)) {
    errors.push(`${position}的 ${field} 必须是 rx/ry 均在 0..1 的坐标`);
  }
}

function validateClickExtras(step: Record<string, unknown>, position: string, errors: string[]): void {
  if (step.anchor !== undefined) validatePointerAnchor(step.anchor, 'anchor', position, errors);
  if (step.gesture !== undefined
    && (typeof step.gesture !== 'string' || !WORKFLOW_GESTURES.has(step.gesture))) {
    errors.push(`${position}的 gesture 无效`);
  }
  if (step.key !== undefined
    && (typeof step.key !== 'string' || !WORKFLOW_KEYS.has(step.key))) {
    errors.push(`${position}的 key 只允许非打印功能键`);
  }
}

function validateFillExtras(step: Record<string, unknown>, position: string, errors: string[]): void {
  if (step.control !== undefined
    && (typeof step.control !== 'string' || !WORKFLOW_FORM_CONTROLS.has(step.control))) {
    errors.push(`${position}的 control 无效`);
  }
  if (step.choice !== undefined
    && (!Number.isSafeInteger(step.choice) || (step.choice as number) < 0 || (step.choice as number) > MAX_FORM_CHOICE)) {
    errors.push(`${position}的 choice 必须是 ${MAX_FORM_CHOICE} 以内的非负整数`);
  }
  if (step.checked !== undefined && typeof step.checked !== 'boolean') {
    errors.push(`${position}的 checked 必须是布尔值`);
  }

  // 配套关系：序号只对下拉框有意义，选中态只对勾选/单选框有意义。
  // 缺省 control 等价旧流程的文本框，因此任何文本控件带 choice/checked 都要拒绝。
  const control = typeof step.control === 'string' ? step.control : undefined;
  if (step.choice !== undefined && control !== 'select') {
    errors.push(`${position}的 choice 只能用于 control 为 select 的填写步骤`);
  }
  if (step.checked !== undefined && control !== 'checkbox' && control !== 'radio') {
    errors.push(`${position}的 checked 只能用于 control 为 checkbox/radio 的填写步骤`);
  }
  if (control === 'select' && step.choice === undefined) {
    errors.push(`${position}的 select 步骤必须指定 choice`);
  }
  if ((control === 'checkbox' || control === 'radio') && step.checked === undefined) {
    errors.push(`${position}的 ${control} 步骤必须指定 checked`);
  }
}

function isSameSiteUrl(site: Pick<SiteConfig, 'loginUrl'>, candidate: string): boolean {
  try {
    return new URL(candidate, site.loginUrl).origin === new URL(site.loginUrl).origin;
  } catch {
    return false;
  }
}

/**
 * 校验学习路线（`workflow.route`）。
 *
 * 路线是运行时最先消费的字段，一旦存进 storage 就会驱动真实跳转，因此保存前
 * 必须拦下跨站地址。规则与运行时（`automation/workflow.ts` 的 `resolveRoute`）一致：
 * 必须是字符串数组、每项非空、每项与登录站点同源、长度不超过 12。
 * route 未定义时返回空数组，老配置的校验结论完全不变。
 */
function validateRoute(site: Pick<SiteConfig, 'loginUrl'>, route: unknown): string[] {
  if (route === undefined) return [];
  if (!Array.isArray(route)) return ['工作流学习路线必须是字符串数组'];
  if (route.length > MAX_ROUTE_LENGTH) {
    return [`工作流学习路线最多 ${MAX_ROUTE_LENGTH} 个页面`];
  }
  const errors: string[] = [];
  route.forEach((page, index) => {
    if (typeof page !== 'string' || !page.trim()) {
      errors.push(`工作流学习路线第 ${index + 1} 项必须是非空地址`);
      return;
    }
    if (!isSameSiteUrl(site, page)) {
      errors.push(`工作流学习路线第 ${index + 1} 项必须与登录站点同源`);
    }
  });
  return errors;
}

function validateIdentityPath(
  site: Pick<SiteConfig, 'loginUrl'>,
  identityPath: unknown,
  route: unknown,
): string[] {
  if (identityPath === undefined) return [];
  if (typeof identityPath !== 'string' || !identityPath.trim()) {
    return ['工作流身份核验路径必须是非空字符串'];
  }
  if (identityPath.length > 500) return ['工作流身份核验路径过长'];
  if (!isSameSiteUrl(site, identityPath)) return ['工作流身份核验路径必须与登录站点同源'];

  try {
    const identityUrl = new URL(identityPath, site.loginUrl);
    if (identityUrl.username || identityUrl.password || identityUrl.search
      || /(?:access_token|refresh_token|id_token|code|state|token|secret|password)=/i.test(identityUrl.hash)) {
      return ['工作流身份核验路径不能包含查询参数或凭据'];
    }
    if (!Array.isArray(route) || route.length === 0) {
      return ['工作流身份核验路径必须位于学习路线中'];
    }
    const identityKey = `${identityUrl.pathname}${identityUrl.hash}`;
    const routeKeys = route.map((page) => {
      if (typeof page !== 'string' || !page.trim()) return undefined;
      const pageUrl = new URL(page, site.loginUrl);
      if (pageUrl.origin !== identityUrl.origin) return undefined;
      return `${pageUrl.pathname}${pageUrl.hash}`;
    });
    // 身份核验页只需是路线成员。**与签到终点同址是合法形态**：站点把签到按钮直接
    // 放在资料页上时，引擎到页后先核对账号、再执行签到动作；读不到账号就停机。
    // 这里若要求"必须是另一个页面"，这类站点永远学不出来（保存被拒）。
    return routeKeys.indexOf(identityKey) >= 0
      ? []
      : ['工作流身份核验路径必须位于学习路线中'];
  } catch {
    return ['工作流身份核验路径必须位于学习路线中'];
  }
}

/**
 * 校验可持久化工作流，保存前拦截跨站导航、任意脚本字段和无法执行的步骤。
 * 运行时仍会再次做最小校验，因为 storage JSON 可能来自旧版本或手工编辑。
 */
export function validateCheckinWorkflow(
  site: Pick<SiteConfig, 'loginUrl'>,
  workflow: CheckinWorkflowConfig | undefined,
): string[] {
  const errors: string[] = [];
  if (!workflow || !Array.isArray(workflow.steps) || workflow.steps.length === 0) {
    return ['工作流至少需要一个步骤'];
  }

  // 学习路线独立校验：它承载导航，因此有路线时 steps 里不需要（也不强求）
  // navigate 步骤。步骤本身的规则一条都不放宽。
  errors.push(...validateRoute(site, workflow.route));
  errors.push(...validateIdentityPath(site, workflow.identityPath, workflow.route));

  let totalSteps = 0;
  let navigateCount = 0;

  const validateSteps = (steps: unknown[], prefix: string, depth: number, root: boolean): void => {
    if (depth > MAX_CONDITION_DEPTH) {
      errors.push(`${prefix}条件嵌套超过 ${MAX_CONDITION_DEPTH} 层`);
      return;
    }
    totalSteps += steps.length;
    if (totalSteps > MAX_WORKFLOW_STEPS) return;

    steps.forEach((rawStep, index) => {
      const position = `${prefix}${index + 1}`;
      if (!isRecord(rawStep) || typeof rawStep.type !== 'string') {
        errors.push(`${position}格式无效`);
        return;
      }

      switch (rawStep.type) {
        case 'if': {
          const condition = rawStep.condition;
          if (!isRecord(condition) || typeof condition.type !== 'string') {
            errors.push(`${position}缺少有效 condition`);
          } else if (condition.type === 'text') {
            if (!Array.isArray(condition.words)
              || condition.words.length === 0
              || condition.words.some((word) => typeof word !== 'string' || !word.trim())) {
              errors.push(`${position}的 text 条件需要非空 words`);
            }
            if (condition.match !== undefined && condition.match !== 'any' && condition.match !== 'all') {
              errors.push(`${position}的 text 条件 match 无效`);
            }
          } else if (condition.type === 'selector') {
            if (typeof condition.selector !== 'string' || !condition.selector.trim()) {
              errors.push(`${position}的 selector 条件缺少 selector`);
            }
          } else if (condition.type === 'path') {
            if (typeof condition.pattern !== 'string' || !condition.pattern.trim()) {
              errors.push(`${position}的 path 条件缺少 pattern`);
            }
          } else {
            errors.push(`${position}包含不支持的 condition 类型`);
          }

          if (!Array.isArray(rawStep.then) || rawStep.then.length === 0) {
            errors.push(`${position}的 then 分支不能为空`);
          } else {
            validateSteps(rawStep.then, `${position}.then.`, depth + 1, false);
          }
          if (rawStep.else !== undefined) {
            if (!Array.isArray(rawStep.else)) errors.push(`${position}的 else 分支格式无效`);
            else validateSteps(rawStep.else, `${position}.else.`, depth + 1, false);
          }
          break;
        }
        case 'navigate': {
          navigateCount += 1;
          if (!root || index !== 0) {
            errors.push(`${position}只能把 navigate 放在第一步`);
          }
          if (typeof rawStep.url !== 'string' || !rawStep.url.trim()) {
            errors.push(`${position}缺少 url`);
          } else if (!isSameSiteUrl(site, rawStep.url)) {
            errors.push(`${position}必须与登录站点同源`);
          }
          break;
        }
        case 'click': {
          if (typeof rawStep.selector !== 'string' || !rawStep.selector.trim()) errors.push(`${position}缺少 selector`);
          if (rawStep.waitFor !== undefined && (typeof rawStep.waitFor !== 'string' || !rawStep.waitFor.trim())) {
            errors.push(`${position}的 waitFor 无效`);
          }
          if (rawStep.timeoutMs !== undefined && !finiteInRange(rawStep.timeoutMs, 0)) {
            errors.push(`${position}的 timeoutMs 超出范围`);
          }
          validateClickExtras(rawStep, position, errors);
          validateScrollFields(rawStep, position, errors);
          break;
        }
        case 'fill': {
          if (typeof rawStep.selector !== 'string' || !rawStep.selector.trim()) errors.push(`${position}缺少 selector`);
          if (typeof rawStep.value !== 'string') errors.push(`${position}缺少 value`);
          if (rawStep.timeoutMs !== undefined && !finiteInRange(rawStep.timeoutMs, 0)) {
            errors.push(`${position}的 timeoutMs 超出范围`);
          }
          validateFillExtras(rawStep, position, errors);
          validateScrollFields(rawStep, position, errors);
          break;
        }
        case 'scroll': {
          if (!isZeroToOne(rawStep.ratio)) {
            errors.push(`${position}的 ratio 必须是 0..1 的数字`);
          }
          if (rawStep.container !== undefined && !isScrollContainer(rawStep.container)) {
            errors.push(`${position}的 container 必须是安全的 CSS 选择器`);
          }
          if (rawStep.settleMs !== undefined && !finiteInRange(rawStep.settleMs, 0)) {
            errors.push(`${position}的 settleMs 超出范围`);
          }
          if (rawStep.timeoutMs !== undefined && !finiteInRange(rawStep.timeoutMs, 0)) {
            errors.push(`${position}的 timeoutMs 超出范围`);
          }
          break;
        }
        case 'drag': {
          validateSelectorField(rawStep, 'selector', position, errors);
          validateSelectorField(rawStep, 'toSelector', position, errors);
          if (rawStep.anchor !== undefined) validatePointerAnchor(rawStep.anchor, 'anchor', position, errors);
          if (rawStep.toAnchor !== undefined) validatePointerAnchor(rawStep.toAnchor, 'toAnchor', position, errors);
          if (rawStep.steps !== undefined
            && (!Number.isSafeInteger(rawStep.steps) || (rawStep.steps as number) < 0 || (rawStep.steps as number) > MAX_DRAG_STEPS)) {
            errors.push(`${position}的 steps 必须是 0-${MAX_DRAG_STEPS} 的整数`);
          }
          if (rawStep.timeoutMs !== undefined && !finiteInRange(rawStep.timeoutMs, 0)) {
            errors.push(`${position}的 timeoutMs 超出范围`);
          }
          validateScrollFields(rawStep, position, errors);
          break;
        }
        case 'wait': {
          const hasSelector = typeof rawStep.selector === 'string' && rawStep.selector.trim().length > 0;
          const hasMs = rawStep.ms !== undefined;
          if (hasSelector && hasMs) errors.push(`${position}只能设置 selector 或 ms 其中一个`);
          if (hasMs && !finiteInRange(rawStep.ms, 0)) errors.push(`${position}的 ms 超出范围`);
          if (rawStep.timeoutMs !== undefined && !finiteInRange(rawStep.timeoutMs, 0)) {
            errors.push(`${position}的 timeoutMs 超出范围`);
          }
          break;
        }
        case 'assert': {
          const hasSelector = typeof rawStep.selector === 'string' && rawStep.selector.trim().length > 0;
          const hasText = Array.isArray(rawStep.text)
            && rawStep.text.some((word) => typeof word === 'string' && word.trim());
          if (!hasSelector && !hasText) errors.push(`${position}需要 selector 或 text`);
          if (rawStep.text !== undefined
            && (!Array.isArray(rawStep.text) || rawStep.text.some((word) => typeof word !== 'string'))) {
            errors.push(`${position}的 text 必须是字符串数组`);
          }
          if (rawStep.result !== undefined && rawStep.result !== 'success' && rawStep.result !== 'already') {
            errors.push(`${position}的 result 无效`);
          }
          if (rawStep.timeoutMs !== undefined && !finiteInRange(rawStep.timeoutMs, 0)) {
            errors.push(`${position}的 timeoutMs 超出范围`);
          }
          break;
        }
        case 'leilei-daily': {
          let hostname = '';
          try {
            hostname = new URL(site.loginUrl).hostname.toLowerCase();
          } catch {
            // 站点地址的通用校验会报告具体错误。
          }
          let secureOrigin = false;
          try {
            const origin = new URL(site.loginUrl);
            secureOrigin = origin.protocol === 'https:'
              && origin.hostname.toLowerCase() === 'fapi.leileihog.top'
              && !origin.port;
          } catch {
            // 站点地址的通用校验会报告具体错误。
          }
          if (hostname !== 'fapi.leileihog.top' || !secureOrigin) {
            errors.push(`${position}的 leilei-daily 仅允许用于 fapi.leileihog.top`);
          }
          break;
        }
        default:
          errors.push(`${position}包含不支持的步骤类型`);
      }
    });
  };

  validateSteps(workflow.steps, '工作流第 ', 0, true);
  if (workflow.steps.length > MAX_WORKFLOW_STEPS || totalSteps > MAX_WORKFLOW_STEPS) {
    errors.push(`工作流最多支持 ${MAX_WORKFLOW_STEPS} 个步骤`);
  }
  if (navigateCount > 1) errors.push('工作流当前只允许一个 navigate 步骤');
  return errors;
}
