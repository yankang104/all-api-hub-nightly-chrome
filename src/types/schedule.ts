/**
 * 后台自动签到计划。
 *
 * weekdays 使用 JavaScript Date 的约定：0=周日，1=周一 ... 6=周六。
 * time 是用户本地时区的 24 小时制 HH:mm。
 */
export interface CheckinSchedule {
  enabled: boolean;
  time: string;
  weekdays: number[];
  /**
   * 计划目标账号白名单。
   *
   * undefined 表示全部账号（兼容没有这个字段的旧配置）；
   * 显式数组只执行其中的账号，空数组表示暂不执行账号。
   */
  accountIds?: string[];
}
