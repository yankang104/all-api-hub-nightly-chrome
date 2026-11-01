import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

/**
 * 构建戳：每次 build 都会变，用来确认「加载的是不是刚构建的那份」。
 *
 * 之前 version_name 是写死的 '0.2.2-nightly-20260810'，改完代码重新构建
 * 它还是那串字符 —— 扩展页面和签到日志第一行都看不出新旧，
 * 分不清「改动没生效」还是「忘了重新加载扩展」。
 *
 * 用构建时刻（本地时区，精确到分钟）作为后缀，重新加载后一眼可辨。
 */
function buildStamp(): string {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
}

// https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],

  manifest: {
    name: '自助签到中转站',
    description: '多站点多账号签到管理：一键自动关公告、填账密、登录',
    version: '0.2.2',
    version_name: `0.2.2-build-${buildStamp()}`,
    action: {
      default_title: '打开自助签到中转站',
    },
    permissions: [
      'storage',
      'tabs',
      // Read browser-discovered rel=icon URLs for the site cards.
      'favicon',
      'scripting',
      // 同站多账号切换：后台只清当前任务站点的 Cookie（含 HttpOnly）。
      'cookies',
      // 浏览器级鼠标轨迹：普通登录、OAuth、签到与专用挑战求解器使用真实坐标事件；
      // 挑战流程只操作页面公开控件，不注入或伪造验证结果。
      'debugger',
      // 导入站点：读取浏览器书签树，结构与 Chrome 书签管理器一致
      'bookmarks',
      // 代理签到：chrome.proxy 是全局设置，任务结束后会立即还原
      'proxy',
      // 代理认证：onAuthRequired 自动应答，凭据只在内存里
      'webRequest',
      'webRequestAuthProvider',
      // 后台签到队列超时看门狗，管理页关闭后仍能清理卡住的任务
      'alarms',
      // 捕获代理/DNS/连接错误，及时还原网络并给出准确失败原因
      'webNavigation',
    ],
    // 自动登录需要注入任意用户导入的站点，故使用 <all_urls>。
    // content script 会先检查本 tab 是否有待执行任务，无任务立即退出，开销极小。
    host_permissions: ['<all_urls>'],
    icons: {
      16: 'icon/16.png',
      32: 'icon/32.png',
      48: 'icon/48.png',
      96: 'icon/96.png',
      128: 'icon/128.png',
    },
  },

  vite: () => ({
    plugins: [tailwindcss()],
  }),
});
