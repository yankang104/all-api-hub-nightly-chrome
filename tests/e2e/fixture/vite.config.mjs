import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * 独立构建测试站点，产物给 Playwright 用静态服务器托管。
 * 不从 'vite' 导入 defineConfig —— vite 只是 wxt 的间接依赖，直接 import 解析不到。
 */
export default {
  root: here,
  base: './',
  build: { outDir: 'dist', emptyOutDir: true },
  esbuild: { jsx: 'automatic' },
};
