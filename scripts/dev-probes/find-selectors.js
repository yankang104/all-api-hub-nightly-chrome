
// 粘贴到 agentrouter.org 登录后页面的 Console 运行
// 目的：找右上角用户菜单和退出按钮的选择器

(function findSelectors() {
  const vis = el => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
  };
  const toSel = el => {
    const parts = [el.tagName.toLowerCase()];
    if (el.id) parts.push('#' + el.id);
    if (el.className && typeof el.className === 'string') {
      parts.push('.' + el.className.trim().split(/\s+/).filter(c => !/\d{4,}/.test(c)).slice(0, 4).join('.'));
    }
    const text = (el.innerText || el.getAttribute?.('aria-label') || el.title || '').trim().slice(0, 40);
    if (text) parts.push(`"${text}"`);
    return parts.join(' ');
  };

  // 右上角（屏幕右侧 1/3，上方 1/4 区域）的可点击元素
  const W = window.innerWidth, H = window.innerHeight;
  const topRight = [...document.querySelectorAll('button, a, [role="button"], img')]
    .filter(vis)
    .filter(el => {
      const r = el.getBoundingClientRect();
      return r.right > W * 0.6 && r.top < H * 0.25;
    })
    .map(toSel);

  // 所有包含"退出""登出""logout""sign out"文字的元素
  const logoutEls = [];
  document.querySelectorAll('*').forEach(el => {
    const t = (el.innerText || el.textContent || '').trim().toLowerCase();
    if ((t.includes('退出') || t.includes('登出') || t.includes('logout') || t.includes('sign out')) && el.children.length < 3) {
      logoutEls.push(toSel(el));
    }
  });

  // GitHub 按钮（如果在登录页上）
  const ghBtns = [...document.querySelectorAll('button, a')]
    .filter(el => /(github)/i.test(el.innerHTML + el.innerText))
    .map(toSel);

  // 只列出可能相关的键名，绝不读取或输出 token/用户值
  let storageKeys = [];
  try {
    storageKeys = Object.keys(localStorage).filter(k => /user|token|auth/i.test(k));
  } catch(e) { storageKeys = []; }

  // 页面框架
  const html = document.documentElement.outerHTML;
  const framework = [];
  if (/\bant-/.test(html)) framework.push('Ant Design');
  if (/\bsemi-/.test(html)) framework.push('Semi Design');
  if (/MuiButton/.test(html)) framework.push('MUI');
  if (/\bchakra/.test(html)) framework.push('Chakra');

  const result = {
    url: location.href,
    title: document.title,
    框架: framework.join(', ') || '未识别',
    右上角可点元素: topRight,
    退出相关元素: logoutEls,
    GitHub按钮: ghBtns,
    localStorage相关键名: storageKeys,
  };

  console.log('=== 选择器探测结果 ===');
  console.log(JSON.stringify(result, null, 2));
  console.log('=== 请把上面这段JSON复制给我 ===');
  return result;
})();
