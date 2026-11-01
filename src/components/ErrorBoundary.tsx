import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * 全局错误边界：React 渲染崩溃时给出可见的报错信息，
 * 而不是一张白屏 —— 白屏让用户和开发者都分不清是数据为空还是代码异常。
 */
interface State {
  error: Error | null;
  info: string;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null, info: '' };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // 组件栈帮助定位到具体是哪个视图炸了
    this.setState({ info: info.componentStack ?? '' });
    console.error('[签到管理台] 渲染崩溃', error, info.componentStack);
  }

  override render() {
    const { error, info } = this.state;
    if (error) {
      return (
        <div className="mx-auto max-w-2xl px-6 py-16">
          <h1 className="text-base font-bold text-rose-700 dark:text-rose-300">签到管理台渲染出错</h1>
          <p className="mt-2 text-xs text-ink-800/65 dark:text-ink-100/55">
            不是你操作的问题，是界面代码崩了。把下面的报错发给开发者即可定位。
          </p>
          <pre className="mt-4 overflow-auto rounded-lg bg-rose-50 p-3 text-[11px] leading-relaxed text-rose-900 ring-1 ring-rose-500/20 dark:bg-rose-950/30 dark:text-rose-200">
            {error.message}
            {error.stack}
          </pre>
          {info && (
            <pre className="mt-3 overflow-auto rounded-lg bg-slate-100 p-3 text-[10px] leading-relaxed text-ink-800/70 dark:bg-slate-900 dark:text-ink-100/60">
              {info}
            </pre>
          )}
          <button
            type="button"
            onClick={() => this.setState({ error: null, info: '' })}
            className="mt-4 h-9 rounded-lg bg-blue-600 px-3 text-xs font-semibold text-white hover:bg-blue-700"
          >
            重试渲染
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
