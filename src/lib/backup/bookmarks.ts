export const ALL_BOOKMARKS_ID = '__all_bookmarks__';

export interface BookmarkFolder {
  id: string;
  name: string;
  path: string;
  depth: number;
  count: number;
}

export interface BookmarkLink {
  id: string;
  name: string;
  url: string;
  folderId: string;
  folderPath: string;
  depth: number;
}

export interface BookmarkParseResult {
  source: 'browser' | 'chrome-html' | 'chrome-json';
  folders: BookmarkFolder[];
  links: BookmarkLink[];
}

interface ChromeBookmarkNode {
  type?: string;
  name?: string;
  title?: string;
  url?: string;
  children?: ChromeBookmarkNode[];
}

const CHROME_ROOT_LABELS: Record<string, string> = {
  bookmark_bar: '书签栏',
  other: '其他书签',
  synced: '移动设备书签',
};

export function parseBookmarkFile(text: string): BookmarkParseResult {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('书签文件是空的');

  if (trimmed.startsWith('{')) return parseChromeBookmarkJson(trimmed);
  return parseChromeBookmarkHtml(text);
}

function parseChromeBookmarkJson(text: string): BookmarkParseResult {
  let parsed: { roots?: Record<string, ChromeBookmarkNode> };
  try {
    parsed = JSON.parse(text) as { roots?: Record<string, ChromeBookmarkNode> };
  } catch {
    throw new Error('无法解析 Chrome Bookmarks JSON');
  }

  if (!parsed.roots) throw new Error('没有找到 Chrome 书签根节点');

  const acc = createAccumulator();
  const rootEntries = Object.entries(parsed.roots);

  for (const [key, node] of rootEntries) {
    const rootName = CHROME_ROOT_LABELS[key] || node.name?.trim() || key;
    const rootPath = [rootName];
    acc.rememberFolder(rootPath);

    for (const child of node.children ?? []) {
      walkChromeBookmarkNode(child, rootPath, acc);
    }
  }

  return { source: 'chrome-json', folders: acc.folders(), links: acc.links };
}

/**
 * 解析 chrome.bookmarks.getTree() 的实时书签树。
 * 顶层节点（书签栏 / 其他书签 / 移动设备书签）作为一级文件夹保留，层级与 Chrome 书签管理器一致。
 */
export function parseBookmarkTree(nodes: ChromeBookmarkNode[]): BookmarkParseResult {
  const acc = createAccumulator();

  for (const root of nodes) {
    for (const child of root.children ?? []) {
      const name = (child.title ?? '').trim() || '未命名';
      if (child.url) {
        acc.addLink([], child.title ?? '', child.url);
        continue;
      }
      acc.rememberFolder([name]);
      for (const grand of child.children ?? []) {
        walkChromeBookmarkNode(grand, [name], acc);
      }
    }
  }

  if (acc.links.length === 0) throw new Error('浏览器书签里还没有任何网址书签');
  return { source: 'browser', folders: acc.folders(), links: acc.links };
}

function walkChromeBookmarkNode(
  node: ChromeBookmarkNode,
  path: string[],
  acc: ReturnType<typeof createAccumulator>,
) {
  const nodeName = (node.name ?? node.title ?? '').trim();

  if (node.url) {
    acc.addLink(path, nodeName, node.url);
    return;
  }

  const nextPath = nodeName ? [...path, nodeName] : path;
  acc.rememberFolder(nextPath);

  for (const child of node.children ?? []) {
    walkChromeBookmarkNode(child, nextPath, acc);
  }
}

function parseChromeBookmarkHtml(text: string): BookmarkParseResult {
  const acc = createAccumulator();
  const stack: string[] = [];
  let pendingFolder: string | null = null;
  let sawBookmark = false;

  const tokenRe = /<(\/?DL)\b[^>]*>|<H3\b[^>]*>([\s\S]*?)<\/H3>|<A\b([^>]*)>([\s\S]*?)<\/A>/gi;

  for (const match of text.matchAll(tokenRe)) {
    const dlTag = match[1]?.toUpperCase();

    if (dlTag === 'DL') {
      if (pendingFolder) {
        stack.push(pendingFolder);
        acc.rememberFolder(stack);
        pendingFolder = null;
      }
      continue;
    }

    if (dlTag === '/DL') {
      if (stack.length > 0) stack.pop();
      pendingFolder = null;
      continue;
    }

    if (match[2] != null) {
      pendingFolder = cleanText(match[2]);
      continue;
    }

    const attrs = match[3];
    const label = match[4];
    const href = attrs ? attrOf(attrs, 'href') : '';

    if (href) {
      acc.addLink(stack, cleanText(label ?? ''), decodeEntities(href));
      sawBookmark = true;
    }
  }

  if (!sawBookmark) throw new Error('没有找到 Google/Chrome 书签链接');

  return { source: 'chrome-html', folders: acc.folders(), links: acc.links };
}

function createAccumulator() {
  const folderMap = new Map<string, BookmarkFolder>();
  const links: BookmarkLink[] = [];

  function rememberFolder(pathParts: string[]) {
    if (pathParts.length === 0) return;

    const path = pathParts.join(' / ');
    if (!folderMap.has(path)) {
      folderMap.set(path, {
        id: path,
        name: pathParts[pathParts.length - 1] ?? path,
        path,
        depth: pathParts.length,
        count: 0,
      });
    }
  }

  function addLink(pathParts: string[], name: string, rawUrl: string) {
    const url = normalizeHttpUrl(rawUrl);
    if (!url) return;

    for (let i = 1; i <= pathParts.length; i += 1) {
      const folderPath = pathParts.slice(0, i);
      rememberFolder(folderPath);
      const folder = folderMap.get(folderPath.join(' / '));
      if (folder) folder.count += 1;
    }

    const folderPath = pathParts.join(' / ');
    links.push({
      id: `bookmark-${links.length + 1}`,
      name: name.trim() || url,
      url,
      folderId: folderPath || ALL_BOOKMARKS_ID,
      folderPath,
      depth: pathParts.length,
    });
  }

  return {
    rememberFolder,
    addLink,
    get links() {
      return links;
    },
    folders() {
      return Array.from(folderMap.values());
    },
  };
}

function attrOf(attrs: string, name: string) {
  const match = attrs.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return decodeEntities(match?.[1] || match?.[2] || match?.[3] || '');
}

function cleanText(text: string) {
  return decodeEntities(text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function decodeEntities(text: string) {
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    '#39': "'",
    nbsp: ' ',
  };

  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (full, entity: string) => {
    const key = entity.toLowerCase();
    if (key.startsWith('#x')) return String.fromCodePoint(Number.parseInt(key.slice(2), 16));
    if (key.startsWith('#')) return String.fromCodePoint(Number.parseInt(key.slice(1), 10));
    return named[key] ?? full;
  });
}

function normalizeHttpUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}
