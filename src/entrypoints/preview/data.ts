import { Activity, Check, Clock3, ShieldAlert } from 'lucide-react';

/**
 * 预览页共享的数据结构与演示数据。
 * 抽到这里是为了让 main.tsx 只留 App 和入口，组件与 mock 分文件维护。
 */
export type Status = 'done' | 'pending' | 'running' | 'attention';

/** 余额历史的一天：金额已是换算后的展示币种。 */
export type BalancePoint = { day: string; amount: number };

export type Account = {
  id: string;
  name: string;
  label?: string;
  status: Status;
  lastRun: string;
  reward?: number;
  /** 站点原始额度换算后的余额；undefined 表示本轮没取到，站点汇总里记一个「未获取」。 */
  balance?: number;
  balanceAt?: string;
  proxy?: string;
  note?: string;
  history?: BalancePoint[];
};

export type Site = {
  id: string;
  name: string;
  domain: string;
  kind: string;
  accent: string;
  /** 本站签到流程说明，对应正式页站点卡片上的流程行。 */
  flow: string;
  proxy?: string;
  accounts: Account[];
};
export const INITIAL_SITES: Site[] = [
  {
    id: 'oneapi',
    name: "1412's API",
    domain: 'napi.kid1412.qzz.io',
    kind: '本站适配',
    accent: 'blue',
    flow: '通用登录 → 核对当前账号 → 按本站适配完成签到 · 可学习',
    proxy: 'Japan-01（站点继承）',
    accounts: [
      {
        id: 'a1',
        name: '主账号',
        label: '生产',
        status: 'done',
        lastRun: '刚刚',
        reward: 0.3449,
        balance: 32.1847,
        balanceAt: '刚刚',
        proxy: 'Japan-01',
        history: [
          { day: '10-14', amount: 31.8398 },
          { day: '10-15', amount: 32.0249 },
          { day: '10-16', amount: 32.1847 },
        ],
      },
      {
        id: 'a2',
        name: '备用账号',
        label: '轮换',
        status: 'done',
        lastRun: '2 分钟前',
        reward: 0.125,
        balance: 5.321,
        balanceAt: '2 分钟前',
        proxy: 'Japan-01',
        history: [
          { day: '10-14', amount: 5.196 },
          { day: '10-15', amount: 5.196 },
          { day: '10-16', amount: 5.321 },
        ],
      },
      { id: 'a3', name: '实验账号', status: 'running', lastRun: '执行中', proxy: 'HongKong-02' },
      { id: 'a4', name: '旧账号', status: 'pending', lastRun: '未执行', note: '余额未获取：接口自检未通过' },
    ],
  },
  {
    id: 'anyrouter',
    name: 'AnyRouter',
    domain: 'anyrouter.top',
    kind: '登录即签到',
    accent: 'violet',
    flow: '通用登录 → 登录成功即完成签到 · 不再寻找签到按钮 · 可重新学习',
    proxy: 'US-03（站点继承）',
    accounts: [
      {
        id: 'b1',
        name: '主账号',
        label: '默认',
        status: 'done',
        lastRun: '6 分钟前',
        reward: 1.25,
        balance: 12.5,
        balanceAt: '6 分钟前',
        proxy: 'US-03',
        history: [
          { day: '10-14', amount: 11.25 },
          { day: '10-15', amount: 12.5 },
          { day: '10-16', amount: 12.5 },
        ],
      },
      { id: 'b2', name: '备用账号', status: 'attention', lastRun: '需验证', note: '触发站点异地登录校验，等待人工确认' },
      {
        id: 'b3',
        name: '共享账号',
        status: 'done',
        lastRun: '12 分钟前',
        reward: 0.5,
        balance: 3.75,
        balanceAt: '12 分钟前',
        proxy: 'US-03',
        history: [
          { day: '10-14', amount: 3.25 },
          { day: '10-15', amount: 3.25 },
          { day: '10-16', amount: 3.75 },
        ],
      },
    ],
  },  {
    id: 'future',
    name: 'Future Hub',
    domain: 'api.futureppo.top',
    kind: '学习流程回放',
    accent: 'mint',
    flow: '通用登录 → 核对当前账号 → 执行已保存签到流程 · 本站账号共用，可重新学习',
    accounts: [
      {
        id: 'c1',
        name: '主账号',
        status: 'done',
        lastRun: '19 分钟前',
        reward: 0.0785,
        balance: 18.4002,
        balanceAt: '19 分钟前',
        proxy: '直连',
        history: [
          { day: '10-14', amount: 18.2396 },
          { day: '10-15', amount: 18.3217 },
          { day: '10-16', amount: 18.4002 },
        ],
      },
      {
        id: 'c2',
        name: '备用账号',
        status: 'done',
        lastRun: '21 分钟前',
        reward: 0.321,
        balance: 9.05,
        balanceAt: '21 分钟前',
        proxy: '直连',
        history: [
          { day: '10-14', amount: 8.729 },
          { day: '10-15', amount: 8.729 },
          { day: '10-16', amount: 9.05 },
        ],
      },
    ],
  },
];

export const statusMeta: Record<Status, { label: string; tone: string; icon: typeof Check }> = {
  done: { label: '已完成', tone: 'done', icon: Check },
  pending: { label: '待签到', tone: 'pending', icon: Clock3 },
  running: { label: '执行中', tone: 'running', icon: Activity },
  attention: { label: '需处理', tone: 'attention', icon: ShieldAlert },
};
