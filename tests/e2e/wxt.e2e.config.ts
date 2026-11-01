import { defineConfig } from 'wxt';
import baseConfig from '../../wxt.config';

export default defineConfig({
  ...baseConfig,
  srcDir: 'src',
  publicDir: 'public',
  outDir: '.output',
});
