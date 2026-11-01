// 粘贴到 agentrouter 弹滑块验证码的页面 Console 运行。
// 目的：dump 滑块验证码的 DOM 结构，供接入扩展时定位「背景图 / 拼图块 / 拖动把手」。
// 只输出结构信息，绝不读取 token / 密码等敏感值。

(function probeSlider() {
  const vis = (el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && r.width > 0 && r.height > 0;
  };

  const brief = (el) => {
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      cls: typeof el.className === 'string'
        ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 6).join('.')
        : undefined,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    };
  };

  const KEY = /slide|slider|geetest|gt_|drag|captcha|puzzle|piece|block|verify|缺口|滑块|拖动|验证/i;

  // 1. 疑似滑块相关元素（可见的），按元素面积从小到大排（内层小元素优先）
  const suspects = [...document.querySelectorAll('*')]
    .filter(vis)
    .filter((el) => KEY.test(`${el.id} ${el.className}`))
    .map((el) => ({ ...brief(el), area: Math.round(el.getBoundingClientRect().width * el.getBoundingClientRect().height) }))
    .sort((a, b) => a.area - b.area)
    .slice(0, 40);

  // 2. 可见的 canvas / img（背景图与拼图块通常在这两类里）
  const canvases = [...document.querySelectorAll('canvas')].filter(vis).map(brief);
  const imgs = [...document.querySelectorAll('img')]
    .filter(vis)
    .filter((el) => KEY.test(`${el.id} ${el.className}`) || KEY.test(el.src || ''))
    .map((el) => ({ ...brief(el), src: (el.src || '').slice(0, 160) }))
    .slice(0, 20);

  // 3. 极验（geetest）特征：window 全局对象 + iframe
  const gtGlobals = Object.keys(window).filter((k) => /geetest|^gt|slide/i.test(k)).slice(0, 20);
  const iframes = [...document.querySelectorAll('iframe')]
    .filter(vis)
    .map((el) => ({ ...brief(el), src: (el.src || '').slice(0, 160) }))
    .slice(0, 10);

  // 4. 疑似滑块元素的外层 HTML（截断，避免把 base64 图片整段打印出来）
  const htmlSamples = suspects.slice(0, 8).map((s) => {
    const el = [...document.querySelectorAll('*')].find((n) => {
      const r = n.getBoundingClientRect();
      return vis(n) && `${n.id} ${n.className}`.includes(s.cls || s.id || '') && Math.round(r.x) === s.rect.x && Math.round(r.y) === s.rect.y;
    });
    if (!el) return { ...s, html: null };
    const html = el.outerHTML.replace(/data:image\/[^"') ]+/g, 'data:image/...').replace(/src="[^"]{200,}"/g, 'src="(long)"');
    return { ...s, html: html.slice(0, 600) };
  });

  const result = {
    url: location.href,
    title: document.title,
    dpr: window.devicePixelRatio,
    疑似滑块元素: suspects,
    滑块元素HTML样本: htmlSamples,
    可见canvas: canvases,
    相关图片: imgs,
    极验全局对象: gtGlobals,
    可见iframe: iframes,
  };

  console.log('=== 滑块验证码探测结果 ===');
  console.log(JSON.stringify(result, null, 2));
  console.log('=== 请把上面这段 JSON 完整复制给我 ===');
  return result;
})();
