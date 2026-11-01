/**
 * 「结束学习」保存结果的成因分类与文案映射（纯函数）。
 *
 * 为什么必须单独一层：`toggleLearning` 的结束分支同时握着三种**成因完全不同**
 * 的信息，而它们都只有一个出口 —— 给用户的那一句话：
 *
 * 1. 这次演示**录到了什么**（`buildLearnedArtifacts` 的 notices）；
 * 2. 这次学习**自己**没存下去（写入异常 / 读回不一致 / 流程校验失败）；
 * 3. 站点**既有**配置不完整，导致连合法的产物也写不进去
 *    （`appRepository.updateSite` 会把整份站点配置过一遍 `validateSiteConfig`）。
 *
 * 把它们混在一起的后果是有现场证据的：用户点「开始学习」后什么都没做就点
 * 「结束学习」，屏幕上报的是「缺少用户名输入框选择器」—— 一句站点配置校验器的
 * 实现措辞，描述的是站点旧配置，与用户刚才做了什么毫无关系，用户既不知道
 * 自己哪里做错了，也不知道下一步该干什么。
 *
 * 因此这里做**显式判定**（不是笼统 catch），并按成因给出对应的说法：
 * - 空演示 → 说清「还没有录到任何动作」并告诉用户继续演示（会话还留着）；
 * - 站点挡住 → 说清是站点**自己**的配置不完整，并把字段翻译成人话；
 * - 其它保存失败 → 如实转述这次学习的失败原因。
 *
 * 站点校验器本身一个字都不放宽：这里只决定**怎么把话说给用户听**。
 */
import type { LearnedArtifactKind } from '@/types';

export interface LearningSaveOutcomeInput {
  /** 这次真的落盘成功的产物。 */
  saved: readonly LearnedArtifactKind[];
  /** 描述「本次演示录到了什么」的固定文案（由 `buildLearnedArtifacts` 产出）。 */
  notices: readonly string[];
  /** 这次学习自身的保存失败原因（写入异常 / 读回不一致 / 流程校验）。 */
  failures: readonly string[];
  /** 站点既有配置不完整、导致写不进去的原因（`validateSiteConfig` 的第一条）。 */
  siteConfigBlockers: readonly string[];
}

export type LearningSaveOutcome =
  | { ok: true; notices: string[] }
  | { ok: false; error: string };

/**
 * 把站点校验器的措辞翻译成「用户要去改哪里」。
 *
 * 只翻译与本次保存直接相关的三条表单字段错误 —— 它们是「学签到但站点还没配
 * 登录表单」这类真实场景里最常撞到的一条；其余消息原样保留（那描述的确实是
 * 这次学到的流程/配置本身，不翻译反而是最准确的信息）。
 */
export function describeSiteConfigBlocker(message: string): string {
  switch (message) {
    case '缺少用户名输入框选择器':
      return '站点还没配置登录表单：缺少账号（用户名）输入框选择器';
    case '缺少密码输入框选择器':
      return '站点还没配置登录表单：缺少密码输入框选择器';
    case '缺少登录按钮选择器':
      return '站点还没配置登录表单：缺少登录按钮选择器';
    default:
      return message;
  }
}

/** 站点配置挡住保存时的统一说法：说清成因 + 给出可执行的下一步。 */
function siteConfigBlockedError(first: string): string {
  return `这次学到的内容没有写入站点：站点自己的配置还不完整（${describeSiteConfigBlocker(first)}）。`
    + '请先在该站点的设置里补齐登录方式与字段选择器，再回到这个页面点「结束学习」；'
    + '本次学习还在继续，不需要重新开始';
}

/**
 * 两个产物一个都没保存下来时如实报错并**保留会话**（用户补完演示后可以再点结束）。
 * 只保存了一半时继续走成功分支：已学到的那半必须先落盘，缺的半边用 notices 讲清楚。
 */
export function learningSaveOutcome(input: LearningSaveOutcomeInput): LearningSaveOutcome {
  const { saved, notices, failures, siteConfigBlockers } = input;

  if (saved.length === 0) {
    if (siteConfigBlockers.length > 0) {
      return { ok: false, error: siteConfigBlockedError(siteConfigBlockers[0]!) };
    }
    // 一句都没有编译出来时，failures 必然为空（这段代码根本没去写站点），
    // 于是落到 notices 里那句描述**本次演示观测结果**的话。
    const reason = failures[0] ?? notices[0] ?? '这次演示没有录到可保存的内容';
    return { ok: false, error: reason };
  }

  const merged = [...notices];
  if (siteConfigBlockers.length > 0) {
    merged.push(`有内容没能保存：站点自己的配置还不完整（${describeSiteConfigBlocker(siteConfigBlockers[0]!)}）`);
  }
  if (failures.length > 0) {
    merged.push(
      `这次没有保存完整：另一半保存失败（原因：${failures[0]}）。`
      + '已保存的部分不受影响、会继续生效；本次学习已结束，失败的那半需要重新学习才能补上',
    );
  }
  return { ok: true, notices: merged };
}
