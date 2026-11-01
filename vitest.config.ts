import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * 单测只覆盖纯函数：额度换算、签到守恒差分、请求头扇出、错误分类。
 *
 * 涉及 DOM 与 chrome API 的部分继续交给 tests/ 下的 Playwright 脚本，
 * 那里跑的是真实浏览器 + 真实扩展，比 jsdom 打桩更可信。
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'jsdom',
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
