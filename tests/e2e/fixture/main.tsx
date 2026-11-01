import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

/**
 * 测试用的假站点 —— 用真实 React 受控组件。
 *
 * 这是验证 setNativeValue 技巧的关键：React 会在 DOM 节点实例上
 * 覆写 value 属性做变更追踪，直接 `input.value = x` 会被它吞掉。
 * 只有走原型链上的原生 setter 才能骗过它，让 onChange 真正触发。
 *
 * 路由（靠 pathname 分流，模拟整页跳转的多页站点）：
 *   /login     登录页（带公告弹窗）
 *   /oauth/github  GitHub 快速回调页（不经过可观测的 github.com 中间页）
 *   /console   登录后的落地页
 *   /checkin   签到页（带签到按钮）
 */

const LOGGED_IN_KEY = 'fixture_logged_in';

/**
 * 登录后才弹出来的公告。
 *
 * 复现真实站点最常见的那种：登录成功跳到仪表盘后，前端还要拉一次
 * 公告接口，几百毫秒后才把弹窗盖上来。扩展如果登录后只扫一次页面
 * 必然扑空，然后这个遮罩就会挡住签到按钮。
 *
 * 遮罩用 position:fixed 铺满视口，模拟真实的 modal mask —— 这样
 * elementFromPoint 检查才能真的检出「按钮被挡住」。
 */
function DelayedAnnouncement({
  delayMs = 900,
  id,
  markRead = false,
}: {
  delayMs?: number;
  id: string;
  markRead?: boolean;
}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs]);

  if (!visible) return null;

  return (
    <div
      className="ant-modal-mask"
      id={id}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div className="modal-inner" style={{ background: '#fff', padding: 24, borderRadius: 8 }}>
        <button
          className={markRead ? undefined : 'ant-modal-close'}
          onClick={() => setVisible(false)}
          aria-label={markRead ? undefined : '关闭'}
        >
          {markRead ? '标记已读' : '×'}
        </button>
        <h3>登录后公告</h3>
        <p>这个公告在登录之后才出现，会挡住签到按钮。</p>
      </div>
    </div>
  );
}

function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [showModal, setShowModal] = useState(true);
  const popupOAuth = new URLSearchParams(location.search).has('popup');

  function submit(e: React.FormEvent) {
    e.preventDefault();
    // 关键断言点：这里读的是 React state，不是 DOM value。
    // 若 setNativeValue 失效，这里拿到的是空字符串。
    if (username && password && agreed) {
      sessionStorage.setItem(LOGGED_IN_KEY, username);
      // new-api 系把登录态放在 localStorage，relogin 测试要验证它被清掉
      localStorage.setItem('user', JSON.stringify({ id: 42, username }));
      // 真实整页跳转，content script 会被销毁重建
      location.assign('/console');
    }
  }

  return (
    <>
      {showModal && (
        <div className="modal" id="announcement">
          <div className="modal-inner">
            <button className="ant-modal-close" onClick={() => setShowModal(false)} aria-label="关闭">
              ×
            </button>
            <h3>系统公告</h3>
            <p>这是一个会挡住登录表单的公告弹窗。</p>
          </div>
        </div>
      )}

      <form className="card" onSubmit={submit}>
        <h2>登录测试站</h2>
        <label>
          用户名
          <input name="username" value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label>
          密码
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <label>
          <span className="semi-checkbox">
            <input
              type="checkbox"
              aria-checked={agreed}
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
              style={{ position: 'absolute', opacity: 0, width: 1, height: 1 }}
            />
            <span aria-hidden="true">{agreed ? '☑' : '☐'}</span>
          </span>
          我已阅读并同意用户协议和隐私政策
        </label>
        <button type="submit" disabled={!agreed}>登录</button>

        {/* 默认模拟整页 OAuth；popup=1 模拟 Agent Router 的 window.open 快速回调。 */}
        <button
          type="button"
          className="oauth-btn"
          onClick={() => {
            if (popupOAuth) {
              window.open('/oauth/github?code=fixture-fast-callback', 'fixture-github-oauth', 'popup,width=520,height=720');
              return;
            }
            sessionStorage.setItem(LOGGED_IN_KEY, 'oauth_user');
            localStorage.setItem('user', JSON.stringify({ id: 99, username: 'oauth_user' }));
            location.assign('/console');
          }}
        >
          使用 GitHub 继续
        </button>

        <div id="state-probe" data-username={username} data-password={password} data-agreed={agreed} hidden />
      </form>
    </>
  );
}

/** 已授权 GitHub 的快速回调：弹窗创建后直接回本站，再立刻落到控制台。 */
function OAuthCallbackPage() {
  useEffect(() => {
    sessionStorage.setItem(LOGGED_IN_KEY, 'demo_user');
    localStorage.setItem('user', JSON.stringify({ id: 99, username: 'demo_user' }));
    location.replace('/console');
  }, []);

  return <div className="card" id="oauth-callback">正在完成 GitHub 登录</div>;
}

/** 登录后的落地页：这里没有签到按钮，引擎需要跳到 /checkin */
function ConsolePage() {
  const user = sessionStorage.getItem(LOGGED_IN_KEY);
  const [reward, setReward] = useState<{ rewarded: boolean; logoutCount: number } | null>(null);

  // 模拟 Agent Router：重新登录后落地页会显示奖励是否到账
  useEffect(() => {
    fetch('/api/relogin/reward')
      .then((r) => r.json())
      .then(setReward)
      .catch(() => {});
  }, []);

  return (
    <div className="card">
      {/* 登录成功后才弹的公告：扩展必须等它出现再关 */}
      <DelayedAnnouncement id="console-announcement" delayMs={900} />
      <h2 className="ok" id="login-success">
        登录成功
      </h2>
      <p id="logged-user">{user}</p>
      <p>这是控制台，签到按钮在签到页。</p>
      {/* 退出按钮，relogin 方式会点它（也可走 /api/logout 接口） */}
      <button
        id="logout-btn"
        data-action="logout"
        onClick={() => {
          fetch('/api/logout').finally(() => {
            sessionStorage.removeItem(LOGGED_IN_KEY);
            localStorage.removeItem('user');
            location.assign('/login');
          });
        }}
      >
        退出登录
      </button>
      {reward?.rewarded && <p className="ok" id="relogin-reward">重新登录奖励已发放</p>}
    </div>
  );
}

/** 签到页：点按钮调接口 */
function CheckinPage() {
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'already'>('idle');
  const [msg, setMsg] = useState('');
  const [showSidebarLink, setShowSidebarLink] = useState(true);
  const user = sessionStorage.getItem(LOGGED_IN_KEY);
  const params = new URLSearchParams(location.search);
  const replaceButton = params.has('replace');
  const alreadyButton = params.has('alreadyButton');
  const customNavButton = params.has('navButton');

  // 进页面先问一下今天签过没
  useEffect(() => {
    fetch('/api/checkin/status')
      .then((r) => r.json())
      .then((d) => {
        if (d.checked) {
          setState('already');
          setMsg('今日已签到');
        }
      })
      .catch(() => {});
  }, []);

  async function checkin() {
    setState('loading');
    const r = await fetch('/api/checkin', { method: 'POST' });
    const d = await r.json();
    setState(d.already ? 'already' : 'done');
    setMsg(d.message);
  }

  if (!user) return <div className="card">未登录</div>;

  return (
    <div className="card">
      {/* 签到页也会弹活动公告，且晚于签到按钮出现 —— 正好压在点击窗口上。
          若扩展不等它、也不检查遮挡，就会"点中"被盖住的按钮然后假成功。 */}
      <DelayedAnnouncement id="checkin-announcement" delayMs={600} markRead />
      {showSidebarLink && (
        <nav aria-label="侧栏导航">
          {customNavButton ? (
            <div
              className="sidebar-button"
              onClick={() => {
                history.pushState({}, '', '/checkin?from=sidebar');
                setShowSidebarLink(false);
              }}
            >
              签到
            </div>
          ) : (
            <a
              href="/checkin"
              onClick={(event) => {
                event.preventDefault();
                history.pushState({}, '', '/checkin?from=sidebar');
                setShowSidebarLink(false);
              }}
            >
              签到
            </a>
          )}
        </nav>
      )}
      <h2>每日签到</h2>
      {replaceButton && <p>历史记录中的“已签到”字样不是本次成功证据。</p>}
      {state === 'already' ? (
        alreadyButton ? (
          <button className="checkin-btn" disabled>今日已签到</button>
        ) : (
          <p className="ok" id="already-checked">
            {msg || '今日已签到'}
          </p>
        )
      ) : state === 'done' ? (
        replaceButton ? (
          <button key="completed" className="checkin-btn" disabled>今日已签到</button>
        ) : (
          <p className="ok" id="checkin-success">
            {msg}
          </p>
        )
      ) : (
        <button key="action" className="checkin-btn" onClick={checkin} disabled={state === 'loading'}>
          {state === 'loading' ? '签到中...' : '立即签到'}
        </button>
      )}
    </div>
  );
}

function Router() {
  const path = location.pathname;
  if (path.startsWith('/oauth/github')) return <OAuthCallbackPage />;
  if (path.startsWith('/console')) return <ConsolePage />;
  if (path.startsWith('/checkin')) return <CheckinPage />;
  return <LoginPage />;
}

createRoot(document.getElementById('root')!).render(<Router />);
