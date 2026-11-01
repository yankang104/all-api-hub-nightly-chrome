/**
 * 领取理由去重的消息域。
 *
 * 有些站点（如 sharedchat 的「领取 Codex 权益」）要求每次填写的领取原因
 * 都不能与历史重复。固定文本第二次就会被拒，所以扩展从候选池里挑没用过
 * 的那条，用掉之后必须落盘 —— 否则下一轮又挑到同一条。
 *
 * 写的是**站点配置**而不是账号：同一站点下不同账号的历史是各自独立的，
 * 但站点自己就按账号隔离，配置级去重已经够用，也避免把每个账号的记录
 * 都塞进账号对象里。
 */

export type ClaimMessage =
  /** content → background：这条领取理由已经用掉了，记进站点配置 */
  {
    type: 'CLAIM_TEXT_USED';
    runId: string;
    siteId: string;
    text: string;
  };
