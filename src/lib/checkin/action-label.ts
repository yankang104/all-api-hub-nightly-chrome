/**
 * 按站点动作语义生成状态文案。
 *
 * 为什么需要：不同站点做的根本不是同一件事 —— new-api 是「签到」，
 * SharedChat 是「领取权益」（点入口→填理由→提交），Agent Router 是
 * 「退出再登录才发额度」。全都显示「正在签到」会让用户看不懂当前在干嘛，
 * 领取站的用户还会以为扩展跑错了流程。
 *
 * 这里把 checkin.method 映射成一组动作词，界面各处共用同一份 —— 各自写
 * 死文案的话，将来加一种方式必漏一处，表现是同一个任务在不同面板里
 * 叫法不一样。
 */

import type { CheckinMethod, DailyStatus, TaskStage } from '@/types';

/** 一个站点动作的全套称呼 */
export interface ActionWords {
  /** 动作名，用于「正在XX」「XX成功」：签到 / 领取权益 / 登录奖励 */
  noun: string;
  /** 进行中：签到中 / 领取中 */
  running: string;
  /** 完成态：已签到 / 已领取 */
  done: string;
  /** 待执行：待签到 / 待领取 */
  pending: string;
  /** 失败态：签到失败 / 领取失败 */
  failed: string;
  /** 执行签到动作那一阶段的说明：正在签到 / 正在领取权益 */
  acting: string;
}

const CHECKIN_WORDS: ActionWords = {
  noun: '签到',
  running: '签到中',
  done: '已签到',
  pending: '待签到',
  failed: '签到失败',
  acting: '正在签到',
};

/**
 * claim：站点是「领取权益」而不是签到。
 *
 * 措辞跟站点自己的按钮一致（「领取 Codex 权益」），用户一眼能对上，
 * 不会怀疑扩展点错了地方。
 */
const CLAIM_WORDS: ActionWords = {
  noun: '领取权益',
  running: '领取中',
  done: '已领取',
  pending: '待领取',
  failed: '领取失败',
  acting: '正在领取权益',
};

/**
 * relogin：奖励靠「退出再登录一次」触发，中间必然经过一次登出。
 *
 * 单说「签到」会让用户以为扩展在乱点退出；说清是登录奖励才对得上流程。
 */
const RELOGIN_WORDS: ActionWords = {
  noun: '登录奖励',
  running: '领取中',
  done: '已领取',
  pending: '待领取',
  failed: '领取失败',
  acting: '正在重登领奖',
};

const WORDS_BY_METHOD: Partial<Record<CheckinMethod, ActionWords>> = {
  claim: CLAIM_WORDS,
  relogin: RELOGIN_WORDS,
};

/**
 * 取这个站点/账号的动作称呼。
 *
 * 签到方式由站点配置统一决定，账号行只负责按该方式展示状态词。
 * 否则界面说「签到」而实际跑的是领取流程。
 */
export function actionWords(method?: CheckinMethod): ActionWords {
  return (method && WORDS_BY_METHOD[method]) ?? CHECKIN_WORDS;
}

/**
 * 阶段文案。
 *
 * checkin 阶段是唯一需要按动作区分的：其余阶段（登录、校验、授权）
 * 所有站点都一样，硬按方式改称呼只会让文案更啰嗦。
 * relogin 两个阶段带上动作名，用户才知道这次登出是流程的一部分。
 */
export function stageLabelFor(stage: TaskStage, method?: CheckinMethod): string {
  const words = actionWords(method);
  switch (stage) {
    case 'login':
      return '正在登录';
    case 'verify':
      return '登录校验';
    case 'verify-oauth':
      return '等待授权';
    case 'checkin':
      return words.acting;
    case 'github-logout':
      return '正在切换 GitHub 账号';
    case 'relogin':
      return '退出重登';
    case 'relogin-verify':
      return '二次校验';
    default:
      return '处理中';
  }
}

/** 状态徽章与列表用的状态词 */
export function statusLabelFor(status: DailyStatus, method?: CheckinMethod): string {
  const words = actionWords(method);
  switch (status) {
    case 'done':
      return words.done;
    case 'running':
      return words.running;
    case 'attention':
      return '需要人工处理';
    case 'failed':
      return words.failed;
    default:
      return words.pending;
  }
}
