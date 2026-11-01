/** 从 Chrome 书签里找出指定文件夹（模糊匹配名称）下的所有站点 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const BM = join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data', 'Default', 'Bookmarks');
const keyword = process.argv[2] ?? '公益';

const root = JSON.parse(readFileSync(BM, 'utf8')).roots;

/** 收集所有文件夹名，便于确认关键词是否命中 */
const folders = [];
function walkFolders(node, path = []) {
  if (node.type === 'folder') {
    const p = [...path, node.name];
    folders.push(p.join(' / '));
    for (const c of node.children ?? []) walkFolders(c, p);
  }
}
for (const key of Object.keys(root)) walkFolders(root[key], []);

console.log('=== 所有书签文件夹 ===');
folders.forEach((f) => console.log('  ' + f));

/** 找到名字含关键词的文件夹，列出其下所有链接 */
function findFolder(node, path = []) {
  const out = [];
  if (node.type === 'folder') {
    const p = [...path, node.name];
    if (node.name.includes(keyword)) out.push({ path: p.join(' / '), node });
    for (const c of node.children ?? []) out.push(...findFolder(c, p));
  }
  return out;
}
const hits = [];
for (const key of Object.keys(root)) hits.push(...findFolder(root[key], []));

console.log(`\n=== 名称含「${keyword}」的文件夹 ===`);
for (const { path, node } of hits) {
  console.log(`\n▸ ${path}`);
  const links = [];
  (function collect(n) {
    for (const c of n.children ?? []) {
      if (c.type === 'url') links.push({ name: c.name, url: c.url });
      else collect(c);
    }
  })(node);
  links.forEach((l, i) => console.log(`  ${String(i + 1).padStart(2)}. ${l.name}\n      ${l.url}`));
  console.log(`  共 ${links.length} 个站点`);
}
if (hits.length === 0) console.log('  （未找到，请从上面的文件夹列表里告诉我准确名称）');
