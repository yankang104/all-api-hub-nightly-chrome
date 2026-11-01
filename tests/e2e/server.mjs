/** 测试用静态服务器 + 假签到接口 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.map': 'application/json',
};

/**
 * 签到状态存在内存里，按「是否已签」建模。
 * 每次 startServer 都是全新状态。
 *
 * 另外模拟 relogin 式签到：退出接口会把 loggedOut 置位，
 * 第二次登录时若检测到 loggedOut 就发奖励 —— 与 Agent Router 的行为一致。
 */
export function startServer(dir, port) {
  let checked = false;
  let logoutCount = 0;
  let reloginRewarded = false;
  let oauthAuthenticated = false;
  let batchActive = 0;
  let batchMaxActive = 0;
  let batchEvents = [];
  let redirectHits = 0;

  const server = createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];

    // 同一台本地服务器分别通过 localhost 和 127.0.0.1 访问，构造不同 origin。
    // hold 页让任务保持运行；target 页放置同名表单，用于确认跨 origin 后不会填入凭据。
    if (url === '/gate-hold') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><head><title>Gate hold</title></head><body><p id="gate-hold">Waiting</p></body></html>');
      return;
    }
    if (url === '/gate-target') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>Gate target</title></head><body>
        <input id="gate-username" autocomplete="off">
        <input id="gate-password" type="password" autocomplete="off">
        <button id="gate-submit" type="button">Submit</button>
        <script>
          document.body.dataset.inputEvents = '0';
          for (const input of document.querySelectorAll('input')) {
            input.addEventListener('input', () => {
              document.body.dataset.inputEvents = String(Number(document.body.dataset.inputEvents) + 1);
            });
          }
        </script>
      </body></html>`);
      return;
    }

    // 假签到接口
    if (url === '/api/checkin/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ checked }));
      return;
    }
    if (url === '/api/checkin') {
      const already = checked;
      checked = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(already ? { already: true, message: '今日已签到，请勿重复' } : { success: true, message: '签到成功，获得 $1 额度' }));
      return;
    }
    if (url === '/api/checkin/fail') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: '签到请求被拒绝' }));
      return;
    }
    if (url === '/api/checkin/fail-code-zero') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, code: 0, message: '显式失败优先' }));
      return;
    }
    if (url === '/api/checkin/html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><body><form>登录后签到成功</form></body></html>');
      return;
    }
    if (url === '/api/checkin/redirect') {
      res.writeHead(307, { Location: `http://127.0.0.1:${port}/api/checkin/redirect-target` });
      res.end();
      return;
    }
    if (url === '/api/checkin/redirect-target') {
      redirectHits++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // 模拟 Agent Router 的权威身份接口：只有 GitHub 回调确实建立了
    // 服务端会话时才返回当前用户，避免仅凭 localStorage 误判登录成功。
    if (url === '/api/user/self') {
      const hasOAuthCookie = (req.headers.cookie ?? '')
        .split(';')
        .some((part) => part.trim() === 'fixture_oauth_session=demo-user');
      if (!oauthAuthenticated || !hasOAuthCookie) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: '未登录' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        data: { id: 99, username: 'demo_user' },
      }));
      return;
    }

    // 两个可观测的延迟接口：若后台错误地并发启动批任务，batchMaxActive 会大于 1。
    if (url === '/api/batch/first' || url === '/api/batch/second') {
      const id = url.endsWith('/first') ? 'first' : 'second';
      const delay = id === 'first' ? 2_500 : 100;
      batchActive++;
      batchMaxActive = Math.max(batchMaxActive, batchActive);
      batchEvents.push(`start:${id}`);
      setTimeout(() => {
        batchEvents.push(`end:${id}`);
        batchActive--;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: `${id} completed` }));
      }, delay);
      return;
    }

    // 退出接口（relogin 方式用）
    if (url === '/api/logout') {
      logoutCount++;
      oauthAuthenticated = false;
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': 'fixture_oauth_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
      });
      res.end(JSON.stringify({ success: true, message: '已退出' }));
      return;
    }
    // 第二次登录时前端会来问奖励发没发
    if (url === '/api/relogin/reward') {
      const rewarded = logoutCount > 0 && !reloginRewarded;
      if (rewarded) reloginRewarded = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ rewarded, logoutCount }));
      return;
    }

    // GitHub 已授权时可能从 about:blank 直接回本站。回调响应建立服务端
    // 会话，再由 SPA 写入前端状态并跳到控制台。
    if (url === '/oauth/github') {
      oauthAuthenticated = true;
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Set-Cookie': 'fixture_oauth_session=demo-user; Path=/; HttpOnly; SameSite=Lax',
      });
      res.end(readFileSync(join(dir, 'index.html')));
      return;
    }

    // 静态资源；未命中的路径都回 index.html（SPA 靠 pathname 分流）
    let file = join(dir, url);
    if (!existsSync(file) || url === '/') file = join(dir, 'index.html');
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });

  return new Promise((resolve) =>
    server.listen(port, () =>
      resolve({
        server,
        reset: () => {
          checked = false;
          logoutCount = 0;
          reloginRewarded = false;
          oauthAuthenticated = false;
          batchActive = 0;
          batchMaxActive = 0;
          batchEvents = [];
          redirectHits = 0;
        },
        setChecked: (value = true) => {
          checked = value;
        },
        isChecked: () => checked,
        getLogoutCount: () => logoutCount,
        wasRewarded: () => reloginRewarded,
        getBatchMaxActive: () => batchMaxActive,
        getBatchEvents: () => [...batchEvents],
        getRedirectHits: () => redirectHits,
      }),
    ),
  );
}
