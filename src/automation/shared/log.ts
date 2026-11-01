/**
 * 执行日志接口。
 *
 * 单独成文件是为了避免循环依赖：steps.ts 与 announcements.ts 互相需要
 * 对方的东西，若 StepLog 留在 steps.ts 里，announcements 就得 import steps，
 * 而 steps 又要 import announcements。
 */

/** 每一步的执行结果，汇总成日志回传给界面 */
export interface StepLog {
  push(msg: string): void;
}
