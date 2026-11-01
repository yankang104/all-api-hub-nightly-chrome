import { createServer } from 'node:http';
import { FIXTURE_USERS, FIXTURE_ALICE_USERNAME } from '../learned-flow-fixture.mjs';

// 学习时保持干净；只在回放时启用未演示过的公告、验证和会话变化。
function runtimeClient(config) {
  const report = (kind) => fetch('/runtime/' + kind, { method: 'POST' });
  function notice() {
    if (!config.notices) return;
    const overlay = document.createElement('div');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#0008;display:grid;place-items:center';
    overlay.innerHTML = '<section style="background:white;padding:30px"><h2>系统公告</h2><p>服务维护说明，请阅读后关闭。</p><button type="button">我知道了</button></section>';
    overlay.querySelector('button').onclick = () => { overlay.remove(); void report('notice-closed'); };
    document.body.append(overlay);
  }
  function challenge(done) {
    void report('challenge-mounted');
    const box = document.createElement('form');
    box.id = 'captcha-box';
    box.innerHTML = '<label>人机验证：13 + 8 = ? <input name="captcha" placeholder="答案"></label>';
    let pending = false;
    box.querySelector('input').addEventListener('input', async (event) => {
      if (pending || event.target.value.trim() !== '21') return;
      pending = true;
      await report('challenge-solved');
      box.remove();
      done();
    });
    document.querySelector('main').prepend(box);
  }
  notice();
  if (config.lotteryMode) {
    const draw = document.querySelector('#draw');
    if (!draw) return;
    draw.disabled = true;
    draw.textContent = '今日已抽';
    setTimeout(() => { draw.disabled = false; draw.textContent = '开始抽奖'; }, config.loadingMs || 800);
    draw.onclick = async () => {
      draw.disabled = true;
      const data = await (await fetch('/api/draw', { method: 'POST' })).json();
      setTimeout(() => {
        document.querySelector('#lottery-result').textContent = data.message;
        draw.textContent = '今日已抽';
      }, config.drawResultDelayMs || 1800);
    };
    return;
  }
  const open = document.querySelector('#open-checkin');
  if (!open) return;
  open.onclick = async () => {
    const response = await report('advance');
    const data = await response.json();
    if (data.expired && !config.silentExpired) { location.href = '/login'; return; }
    if (data.user) document.querySelector('#current-user').textContent = data.user;
    open.disabled = true;
    const reveal = () => { document.querySelector('#checkin-panel').hidden = false; };
    const prepare = () => {
      if (config.challenge) challenge(reveal);
      else reveal();
    };
    if (config.challengeDelayMs) setTimeout(prepare, config.challengeDelayMs);
    else prepare();
    notice();
  };
  document.querySelector('#claim').onclick = async () => {
    const button = document.querySelector('#claim');
    button.disabled = true;
    const response = await fetch('/api/checkin', { method: 'POST' });
    const data = await response.json();
    document.querySelector('#checkin-result').textContent = data.message;
  };
}

export async function startRuntimeFixture() {
  let config = {};
  let mutationUsed = false;
  const claimed = new Set();
  const events = [];
  const server = createServer(async (req, res) => {
    const path = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    let user = /(?:^|;\s*)fixture_user=([^;]+)/.exec(req.headers.cookie || '')?.[1] || null;
    events.push({ t: Date.now(), method: req.method, path, user });
    const json = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };
    const redirect = (to) => { res.writeHead(303, { Location: to }); res.end(); };
    const setUser = (name) => res.setHeader('Set-Cookie', 'fixture_user=' + (name || '') + '; Path=/; HttpOnly; SameSite=Lax' + (name ? '' : '; Max-Age=0'));
    const mutate = (at) => {
      if (config.mutateAt !== at || mutationUsed) return false;
      mutationUsed = true;
      user = config.mutation === 'swap' ? FIXTURE_ALICE_USERNAME : null;
      setUser(user);
      return true;
    };
    if (path === '/api/user/self') {
      if (!FIXTURE_USERS[user]) return json(401, { success: false, message: '请先登录' });
      return json(200, { success: true, data: { id: FIXTURE_USERS[user].id, username: user, quota: 1000, used_quota: 0 } });
    }
    if (path === '/api/checkin' || path === '/api/draw') {
      if (req.method !== 'POST') return json(405, { success: false });
      if (!FIXTURE_USERS[user]) return json(401, { success: false, message: '请先登录' });
      const already = claimed.has(user);
      claimed.add(user);
      return json(200, { success: true, message: path === '/api/draw'
        ? already || config.lotteryNoticeOnly ? '今日梦火抽签次数已耗尽' : '抽奖成功'
        : already ? '今日已签到' : '签到成功' });
    }
    if (path.startsWith('/api/')) return json(404, { success: false });
    if (path === '/runtime/advance') {
      mutate('open');
      return json(200, { expired: !user, user });
    }
    if (path === '/runtime/challenge-solved') {
      mutate('challenge');
      return json(200, { success: true });
    }
    if (path.startsWith('/runtime/')) return json(200, { success: true });
    if (path === '/session' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const data = new URLSearchParams(body);
      const name = data.get('username');
      if (FIXTURE_USERS[name]?.password !== data.get('password')) return json(401, { success: false });
      setUser(name);
      return redirect('/console');
    }
    if (path === '/logout') { setUser(null); return redirect('/login'); }
    if (path === '/checkin') mutate('enter');
    if (path !== '/login' && !FIXTURE_USERS[user]) return redirect('/login');
    if (path === '/login' && FIXTURE_USERS[user]) return redirect('/console');
    const account = '<div id="logged-in">已登录</div><p>当前账号：<span id="current-user">' + user + '</span></p>';
    let body;
    if (path === '/login') body = '<h1>登录</h1><form action="/session" method="post"><label>用户名<input id="username" name="username" autocomplete="username"></label><label>密码<input id="password" name="password" type="password" autocomplete="current-password"></label><button id="login-submit">登录</button></form>';
    else if (path === '/console') body = account + '<a id="nav-profile" href="/profile">个人资料</a>';
    else if (path === '/profile') body = account + '<h1>个人资料</h1><p>用户 ID：' + FIXTURE_USERS[user].id + '</p><a id="nav-checkin" href="/checkin">去签到</a>';
    else if (path === '/checkin') body = account + '<h1>每日签到</h1><button id="open-checkin">打开签到面板</button><section id="checkin-panel" hidden><button id="claim">立即签到</button><p id="checkin-result"></p></section>';
    else if (path === '/lottery') body = account + '<h1>浮梦引光</h1><p>今日已抽 0 次 Draw completed</p><button id="draw">开始抽奖</button><p id="lottery-result"></p><a href="/logout">退出登录</a>';
    else { res.writeHead(404); return res.end(); }
    const script = '(' + runtimeClient.toString() + ')(' + JSON.stringify(config) + ')';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html lang="zh"><meta charset="utf-8"><title>运行时防护验收站</title><body><main>' + body + '</main><script>' + script + '</script></body></html>');
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return {
    origin: 'http://127.0.0.1:' + server.address().port,
    reset: (options = {}) => { config = options; mutationUsed = false; claimed.clear(); events.length = 0; },
    events: () => events.map((event) => ({ ...event })),
    close: () => new Promise((done) => server.close(done)),
  };
}
