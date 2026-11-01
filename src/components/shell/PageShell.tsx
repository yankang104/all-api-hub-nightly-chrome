/**
 * 管理页外壳：左侧导航 + 顶栏（面包屑、搜索、状态胶囊）+ 内容槽。
 *
 * 只在 surface='page' 使用。sidepanel 宽度只有 300~400px，
 * 套侧栏会把内容挤没，仍用原来的紧凑单列布局。
 */
import {
  Activity, CircleHelp, Command, Globe2, LayoutDashboard, ListChecks,
  Radio, Search, Settings2, ShieldAlert, Users, Wifi, Zap,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/core/cn';

export type ShellView = 'overview' | 'sites' | 'accounts' | 'network' | 'records' | 'settings';

const NAV_ITEMS: ReadonlyArray<{ id: ShellView; label: string; icon: typeof Globe2 }> = [
  { id: 'overview', label: '总览', icon: LayoutDashboard },
  { id: 'sites', label: '站点', icon: Globe2 },
  { id: 'accounts', label: '账号', icon: Users },
  { id: 'network', label: '代理与网络', icon: Wifi },
  { id: 'records', label: '执行记录', icon: ListChecks },
];

export interface ShellStatus {
  version: string;
  running: number;
  attention: number;
  total: number;
  done: number;
}

export function PageShell({ view, onViewChange, search, onSearchChange, status, children, shellVisible = true }: {
  view: ShellView;
  onViewChange: (view: ShellView) => void;
  search: string;
  onSearchChange: (value: string) => void;
  status: ShellStatus;
  /** sidepanel 形态下只透传 children，不渲染桌面侧栏与顶栏 */
  children: ReactNode;
  shellVisible?: boolean;
}) {
  // 侧边栏宽度只能容纳原紧凑单列布局：不要渲染桌面外壳，也不能把 children 一起隐藏。
  if (!shellVisible) return <>{children}</>;

  const currentLabel = view === 'settings'
    ? '设置'
    : NAV_ITEMS.find((item) => item.id === view)?.label ?? '总览';

  return (
    <div className="flex min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-50">
      <a
        href="#main-content"
        className="fixed left-1/2 top-2 z-[70] -translate-x-1/2 -translate-y-[180%] rounded-lg bg-ink-900 px-3.5 py-2 text-xs font-semibold text-white shadow-lg transition-transform focus-visible:translate-y-0 dark:bg-white dark:text-ink-900"
      >
        跳到主要内容
      </a>

      <aside aria-label="侧边导航" className="sticky top-0 z-20 flex h-screen w-[68px] shrink-0 flex-col border-r border-slate-200 bg-white px-2 py-4 lg:w-[228px] lg:px-3 dark:border-slate-800 dark:bg-slate-950">
        <div className="mb-5 flex items-center gap-2.5 px-1 lg:px-2">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-blue-600 text-white shadow-sm shadow-blue-600/25" aria-hidden="true">
            <Zap className="size-4" strokeWidth={2.5} />
          </span>
          <span className="hidden min-w-0 lg:block">
            <strong className="block truncate text-sm font-bold tracking-tight">签到管理台</strong>
            <span className="block truncate text-[10px] text-ink-800/50 dark:text-ink-100/45">Nightly workspace</span>
          </span>
        </div>

        <p className="mb-2 hidden px-2 text-[10px] font-semibold uppercase tracking-wider text-ink-800/35 lg:block dark:text-ink-100/30">工作台</p>
        <nav className="flex flex-col gap-1" aria-label="主导航">
          {NAV_ITEMS.map(({ id, label, icon: Icon }) => {
            const active = view === id;
            return (
              <button
                key={id}
                type="button"
                aria-current={active ? "page" : undefined}
                aria-label={label}
                title={label}
                onClick={() => onViewChange(id)}
                className={cn(
                  'relative flex h-9 w-full items-center justify-center gap-2.5 rounded-lg text-xs font-medium transition-colors lg:justify-start lg:px-2.5',
                  active
                    ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
                    : 'text-ink-800/60 hover:bg-slate-100 hover:text-ink-900 dark:text-ink-100/55 dark:hover:bg-slate-900 dark:hover:text-ink-50',
                )}
              >
                {active && <span aria-hidden="true" className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r bg-blue-600" />}
                <Icon className="size-4 shrink-0" />
                <span className="hidden truncate lg:block">{label}</span>
                {id === 'records' && status.done > 0 && (
                  <em className="ml-auto hidden rounded bg-slate-100 px-1.5 py-0.5 text-[9px] font-bold not-italic text-ink-800/55 lg:block dark:bg-slate-800 dark:text-ink-100/50">{status.done}</em>
                )}
              </button>
            );
          })}
        </nav>

        <div className="flex-1" />

        <nav className="mt-4 flex flex-col gap-1" aria-label="系统导航">
          <button
            type="button"
            aria-current={view === 'settings' ? 'page' : undefined}
            aria-label='设置'
            title='设置'
            onClick={() => onViewChange('settings')}
            className={cn(
              'flex h-9 w-full items-center justify-center gap-2.5 rounded-lg text-xs font-medium transition-colors lg:justify-start lg:px-2.5',
              view === 'settings'
                ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
                : 'text-ink-800/60 hover:bg-slate-100 hover:text-ink-900 dark:text-ink-100/55 dark:hover:bg-slate-900',
            )}
          >
            <Settings2 className="size-4 shrink-0" />
            <span className="hidden truncate lg:block">设置</span>
          </button>
        </nav>

        <div className="mt-3 flex items-center justify-center gap-2 rounded-lg border border-slate-200 px-2 py-2 text-[10px] text-ink-800/50 lg:justify-start dark:border-slate-800 dark:text-ink-100/45">
          <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-mint-500" />
          <span className="hidden truncate lg:block">后台服务正常</span>
          <span className="ml-auto hidden shrink-0 lg:block">v{status.version}</span>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white/85 px-4 py-3 backdrop-blur lg:px-6 dark:border-slate-800 dark:bg-slate-950/85">
          <nav aria-label="面包屑" className="flex items-center gap-2 text-[11px] text-ink-800/45 dark:text-ink-100/40">
            <span>工作台</span>
            <span aria-hidden="true">/</span>
            <strong className="font-semibold text-ink-900 dark:text-ink-50">{currentLabel}</strong>
          </nav>

          <label className="relative order-last w-full min-w-0 flex-1 lg:order-none lg:ml-auto lg:w-auto lg:max-w-sm lg:flex-none">
            <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-800/35 dark:text-ink-100/35" />
            <input
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="搜索站点、账号或备注"
              aria-label="搜索站点、账号或备注"
              className="h-9 w-full rounded-lg border border-black/8 bg-slate-50 pr-16 pl-8 text-[11px] text-ink-900 outline-none placeholder:text-ink-800/35 focus:border-brand-500/50 focus:ring-2 focus:ring-brand-500/15 dark:border-white/10 dark:bg-slate-900 dark:text-ink-50"
            />
            <kbd className="pointer-events-none absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[9px] text-ink-800/45 dark:border-slate-700 dark:bg-slate-800 dark:text-ink-100/40">
              <Command className="size-2.5" />K
            </kbd>
          </label>

          <div className="ml-auto flex items-center gap-1.5 lg:ml-0">
            {status.running > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-1 text-[10px] font-bold text-blue-700 dark:bg-blue-950/40 dark:text-blue-300">
                <Radio className="size-2.5" aria-hidden="true" />执行中 {status.running}
              </span>
            )}
            {status.attention > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-cyan-50 px-2 py-1 text-[10px] font-bold text-cyan-700 dark:bg-cyan-950/40 dark:text-cyan-300">
                <ShieldAlert className="size-2.5" aria-hidden="true" />需处理 {status.attention}
              </span>
            )}
            <span className="hidden items-center gap-1 rounded-full bg-mint-50 px-2 py-1 text-[10px] font-bold text-mint-700 sm:inline-flex dark:bg-mint-600/15 dark:text-mint-300">
              <Activity className="size-2.5" aria-hidden="true" />{status.done}/{status.total}
            </span>
          </div>
        </header>

        <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 px-4 py-5 outline-none lg:px-6">
          {children}
        </main>
      </div>
    </div>
  );
}
