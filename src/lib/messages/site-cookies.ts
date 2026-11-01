export interface SiteCookieClearResult {
  /** 属于本任务站点、准备删除的 Cookie 数量。 */
  matched: number;
  /** Chrome 确认已经删除的数量。 */
  removed: number;
  /** 枚举到但未能删除的数量；大于 0 时不能继续切号。 */
  failed: number;
}

export type SiteCookieMessage =
  /** content → background：清除当前任务站点的浏览器 Cookie；站点地址由任务信箱决定。 */
  | { type: 'CLEAR_SITE_COOKIES'; runId: string };

export interface SiteCookieResponse {
  siteCookieClear?: SiteCookieClearResult;
}
