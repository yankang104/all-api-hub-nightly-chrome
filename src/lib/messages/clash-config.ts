import type { ProxyConfig } from '@/types';

export type ClashConfigMessage = {
  type: 'SYNC_CLASH_PROXIES';
  inputs: Omit<ProxyConfig, 'id'>[];
};

export interface ClashConfigResponse {
  clashConfigSync?: {
    added: number;
    skipped: number;
    upgraded: number;
    removed: number;
    /** 仍被账号或站点绑定、因此没有被清理的旧出口数量；>0 时界面必须说明。 */
    keptInUse: number;
  };
}
