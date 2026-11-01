/**
 * 工作流结束后的结果核对。
 *
 * 用户实测：学习出的流程点完了、日志只写「工作流步骤已完成」，而页面上其实什么都没发生
 * （点错元素、或签到没生效）。工作流**不能**因为「步骤跑完了」就宣称签到成功 ——
 * 那等于把「点到了」当成「签到了」，用户看到的就是「一直卡在核对」却没有任何结论。
 *
 * 这里只做一件事：把页面上的成功/已完成证据读出来，读不到就如实说读不到。
 * 判定词统一从 checkin-vocab 读取，学习/回放/自动识别共用同一套词表。
 */
import { ALREADY_WORDS, SUCCESS_WORDS } from '@/automation/checkin/checkin-vocab';
import type { StepLog } from '@/automation/shared/log';

export type WorkflowOutcomeEvidence =
  | { kind: 'success'; words: string[] }
  | { kind: 'already'; words: string[] }
  | { kind: 'unknown' };

function bodyText(): string {
  if (typeof document === 'undefined') return '';
  return document.body?.innerText ?? document.body?.textContent ?? '';
}

function scopedText(root: ParentNode | Element): string {
  return (root as HTMLElement).innerText ?? root.textContent ?? '';
}

function matchedWords(text: string, words: readonly string[]): string[] {
  const haystack = text.toLocaleLowerCase();
  return words.filter((word) => haystack.includes(word.toLocaleLowerCase()));
}

function evidenceFromText(text: string): WorkflowOutcomeEvidence {
  if (!text) return { kind: 'unknown' };

  const success = matchedWords(text, SUCCESS_WORDS);
  if (success.length > 0) return { kind: 'success', words: success.slice(0, 4) };

  const already = matchedWords(text, ALREADY_WORDS);
  if (already.length > 0) return { kind: 'already', words: already.slice(0, 4) };

  return { kind: 'unknown' };
}

/**
 * 读页面上的签到结果证据。
 *
 * 顺序有意为之：**先判成功、再判已签到**。签到完成后页面往往同时出现「签到成功」提示
 * 和「今日已签到」按钮，先判 already 会把这次成功降级成「之前就签过了」，
 * 奖励归因就错了。
 */
export function readWorkflowOutcomeEvidence(): WorkflowOutcomeEvidence {
  return evidenceFromText(bodyText());
}

/**
 * 只在给定子树里读签到结果证据。
 *
 * 点击失败时的 already 判定**不能**读整页文本：页面侧栏/历史记录/说明文案里常年写着
 * 「今日已签到」，而那与本次点击的目标控件有没有生效毫无关系。用整页文本判 already
 * 会把「点击失败」伪装成「今天早就签过了」，用户下次再也不会有真实失败可见。
 * 因此失败路径只认目标控件附近子树的证据（见 workflow.ts settleClickFailure）。
 *
 * 判定顺序与整页版本一致：先 success 再 already。
 */
export function readWorkflowOutcomeEvidenceIn(root: ParentNode | Element): WorkflowOutcomeEvidence {
  return evidenceFromText(scopedText(root));
}

/**
 * 把页面证据翻译成工作流结论。
 *
 * 读不到证据时返回 `unknown` 而不是 `success`：工作流只负责「按学到的步骤操作」，
 * 它没有能力证明签到生效。假装成功会掩盖真正的失败（用户下一次也发现不了），
 * 而如实说「未确认」至少能让上层继续按余额等其它证据判定。
 */
export function settleWorkflowOutcome(
  evidence: WorkflowOutcomeEvidence,
  log: StepLog,
): { status: 'success' | 'already' | 'unknown'; message: string } {
  if (evidence.kind === 'success') {
    log.push(`工作流结束后页面出现签到成功证据：${evidence.words.join('、')}`);
    return { status: 'success', message: '工作流命中签到成功证据' };
  }
  if (evidence.kind === 'already') {
    log.push(`工作流结束后页面显示今日已完成：${evidence.words.join('、')}`);
    return { status: 'already', message: '工作流确认今日签到已完成' };
  }
  log.push('工作流步骤已执行完，但页面上没有出现签到成功或已签到的证据；结果交由余额等其它证据判定');
  return { status: 'unknown', message: '工作流步骤已执行完，未读到签到结果证据' };
}
