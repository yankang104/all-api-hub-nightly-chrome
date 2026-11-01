import type { CheckinConfig, SiteConfig } from '@/types';
import { siteOrigin } from '@/lib/site/site-security';
import { usesLearnedCheckin, usesSiteSpecificCheckin } from '@/lib/checkin/learned-checkin';

/**
 * 同一个站点（同一 origin）只有一份学到的签到流程。
 *
 * 「同一个站点」在存储里可能是**多张站点卡**：同一域名被重复导入、内置站点之外又
 * 手动加过一次、书签与备份各导入一份。流程挂在 `SiteConfig.checkin` 上，按卡片 id
 * 存；只在一张卡上学过时，另一张卡下的账号仍然看不到它，用户只能再学一遍 ——
 * 这违背「一个站点学一次、站内所有账号共用」。
 *
 * 规则（只读、纯函数，不改存储）：
 * 1. 目标卡片自己有学到的流程（workflow 回放或学到的登录即签到），用自己的 ——
 *    自己的永远优先；
 * 2. 目标卡片的签到方式是**用户明确选的别的方式**（button / api / claim / relogin /
 *    none，或显式切回自动识别并停用回放），尊重它，不借；
 * 3. 否则（还是默认的「自动识别」、没有停用标记），从同 origin 的其它卡片里借一份
 *    已启用的学到流程（回放或学到的登录即签到）；多张都有时取第一张（与卡片顺序
 *    一致，结果稳定）。学习保存时会把同域的学到流程一起换新，见下方
 *    `learnedCheckinForSameOriginCard`，因此正常情况下它们本来就是同一份。
 *
 * 借来的只是 `checkin` 这一块：登录配置、选择器、代理都仍按目标卡片自己的。
 * 登录成功标志与站点系统的补齐见 `inheritSameOriginRecognition`。
 */
export function resolveSharedLearnedCheckin(
  site: SiteConfig,
  sameOriginSites: readonly SiteConfig[],
): { site: SiteConfig; sharedFrom?: SiteConfig } {
  if (usesLearnedCheckin(site)) return { site };
  const method = site.checkin?.method ?? 'auto';
  if (method !== 'auto' || site.checkin?.workflowReplayDisabled === true) return { site };
  const origin = siteOrigin(site);
  if (!origin) return { site };
  const donor = sameOriginSites.find((candidate) => (
    candidate.id !== site.id
    && usesLearnedCheckin(candidate)
    && siteOrigin(candidate) === origin
  ));
  if (!donor?.checkin) return { site };
  return {
    site: { ...site, checkin: { ...donor.checkin } },
    sharedFrom: donor,
  };
}

/** 从同域名其它卡借来的一项站点识别信息，供启动日志如实说明。 */
export interface BorrowedRecognition {
  field: 'successIndicator' | 'adapter';
  from: SiteConfig;
}

/**
 * 同一站点的重复卡片补齐「认出站点」的信息：登录成功标志、站点系统（adapter）。
 *
 * 第二张同域名卡片常由手动添加（探测没认出来）或书签导入产生，带的是空白预设：
 * 没有登录成功标志，打开时认不出已登录；没有 adapter，身份接口和签到兜底都退到
 * 最保守的一档。同一 origin 就是同一个前端和后端，另一张卡上验证过的这两项对它
 * 同样成立。
 *
 * 只补**目标卡片完全没有**的项，不覆盖任何已填的值；adapter 不带 `userId` ——
 * 那是早期单账号站点的账号级字段，不能借给别的卡。只读、纯函数，不改存储。
 */
export function inheritSameOriginRecognition(
  site: SiteConfig,
  sameOriginSites: readonly SiteConfig[],
): { site: SiteConfig; borrowed: BorrowedRecognition[] } {
  const origin = siteOrigin(site);
  if (!origin) return { site, borrowed: [] };
  const donors = sameOriginSites.filter((candidate) => candidate.id !== site.id && siteOrigin(candidate) === origin);
  const borrowed: BorrowedRecognition[] = [];
  let next = site;

  if (!site.successIndicator?.trim()) {
    const donor = donors.find((candidate) => candidate.successIndicator?.trim());
    if (donor) {
      next = { ...next, successIndicator: donor.successIndicator };
      borrowed.push({ field: 'successIndicator', from: donor });
    }
  }

  if (!site.adapter || Object.keys(site.adapter).length === 0) {
    const donor = donors.find((candidate) => candidate.adapter?.family || candidate.adapter?.siteType);
    if (donor?.adapter) {
      const { userId: _userId, ...adapter } = donor.adapter;
      next = { ...next, adapter };
      borrowed.push({ field: 'adapter', from: donor });
    }
  }

  return { site: next, borrowed };
}

/**
 * 学完一张卡后，同域名其它卡该写成什么（返回 null 表示这张卡不动）。
 *
 * 「谁再学一次就整体覆盖这一份」在重复卡片上同样成立：其它卡若也在用学到的流程
 * （回放或登录即签到），它们就是同一份流程的旧版本，要一起换成新学的。
 * 不动的卡：用户明确选了别的方式（按钮/接口/领取/重登、停用回放），以及模板写死的
 * 专用复合流程（答题翻牌、抽奖）。还在「自动识别」的卡不用写，运行时自然会借用。
 */
export function learnedCheckinForSameOriginCard(
  other: SiteConfig,
  learned: CheckinConfig,
): CheckinConfig | null {
  if (!usesLearnedCheckin(other) || usesSiteSpecificCheckin(other)) return null;
  // 登录即签到是完整策略：与学习那张卡一样整块替换，不留旧入口。
  if (learned.method === 'none') return { ...learned };
  const { entry: _entry, url: _url, ...rest } = other.checkin ?? { method: 'auto' as const };
  return {
    ...rest,
    method: 'workflow',
    ...(learned.workflow ? { workflow: learned.workflow } : {}),
    workflowReplayDisabled: false,
  };
}
