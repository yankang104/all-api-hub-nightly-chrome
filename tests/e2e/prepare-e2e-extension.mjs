import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TESTS = dirname(fileURLToPath(import.meta.url));
const ROOT = join(TESTS, '..', '..');
const GENERATED_ROOT = join(TESTS, '.wxt');
const WORKSPACE = join(GENERATED_ROOT, 'e2e-workspace');
const GENERATED_PATHS = [
  GENERATED_ROOT,
  join(TESTS, '.output-e2e'),
  join(TESTS, '.wxt-e2e-workspace'),
];

if (GENERATED_PATHS.some((path) => dirname(path) !== TESTS)) {
  throw new Error('拒绝清理 tests 目录之外的路径');
}

await Promise.all(GENERATED_PATHS.map((path) => rm(path, { recursive: true, force: true })));
await mkdir(WORKSPACE, { recursive: true });
await Promise.all([
  cp(join(ROOT, 'src'), join(WORKSPACE, 'src'), { recursive: true }),
  cp(join(ROOT, 'public'), join(WORKSPACE, 'public'), { recursive: true }),
]);

console.log(WORKSPACE);
