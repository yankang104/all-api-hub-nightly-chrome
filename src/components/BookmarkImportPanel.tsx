import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Bookmark,
  Check,
  ChevronRight,
  FileUp,
  Folder,
  Globe,
  Home,
  Loader2,
  RotateCw,
  Search,
  Square,
} from 'lucide-react';
import type { SiteConfig } from '@/types';
import { parseBookmarkFile, parseBookmarkTree, type BookmarkLink, type BookmarkParseResult } from '@/lib/backup/bookmarks';
import { siteFromBookmark } from '@/lib/backup/bookmark-import';
import { matchBookmarkSiteUrl } from '@/lib/site/bookmark-url-match';
import { isSecureLoginUrl } from '@/lib/site/site-security';
import { cn } from '@/lib/core/cn';

interface Props {
  sites: SiteConfig[];
  disabled?: boolean;
  onImport: (
    sites: Omit<SiteConfig, 'id'>[],
    options: { overwriteExisting: boolean },
  ) => Promise<void>;
}

interface LoadedBookmarks extends BookmarkParseResult {
  /** 来源标签：浏览器书签或文件名 */
  label: string;
}

export function BookmarkImportPanel({ sites, disabled, onImport }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [loaded, setLoaded] = useState<LoadedBookmarks | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [currentPath, setCurrentPath] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [duplicateMode, setDuplicateMode] = useState<'skip' | 'overwrite'>('skip');
  const [direction, setDirection] = useState(1);
  const [busy, setBusy] = useState(false);

  function applyLoaded(next: LoadedBookmarks) {
    setLoaded(next);
    setCurrentPath('');
    setQuery('');
    setSelected(new Set());
    setDirection(1);
    setError('');
  }

  async function loadBrowser() {
    setLoading(true);
    setError('');
    try {
      if (typeof chrome === 'undefined' || !chrome.bookmarks?.getTree) {
        throw new Error('当前环境读不到浏览器书签，请改用书签文件导入');
      }
      const tree = await chrome.bookmarks.getTree();
      applyLoaded({ ...parseBookmarkTree(tree), label: '浏览器书签' });
    } catch (err) {
      setLoaded(null);
      setError(err instanceof Error ? err.message : '读取浏览器书签失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadBrowser();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleFile(file?: File) {
    if (!file) return;
    setLoading(true);
    try {
      applyLoaded({ ...parseBookmarkFile(await file.text()), label: file.name });
    } catch (err) {
      setLoaded(null);
      setError(err instanceof Error ? err.message : '无法读取书签文件');
    } finally {
      setLoading(false);
    }
  }

  const crumbs = currentPath ? currentPath.split(' / ') : [];
  const currentDepth = crumbs.length;
  const searching = query.trim().length > 0;

  const childFolders = useMemo(() => {
    if (!loaded) return [];
    return loaded.folders.filter(
      (f) => f.depth === currentDepth + 1 && (currentPath ? f.path.startsWith(`${currentPath} / `) : true),
    );
  }, [loaded, currentDepth, currentPath]);

  const visibleLinks = useMemo(() => {
    if (!loaded) return [];
    const q = query.trim().toLowerCase();
    if (!q) return loaded.links.filter((link) => link.folderPath === currentPath);
    return loaded.links.filter(
      (link) =>
        link.name.toLowerCase().includes(q) ||
        link.url.toLowerCase().includes(q) ||
        link.folderPath.toLowerCase().includes(q),
    );
  }, [loaded, query, currentPath]);

  const importableLinks = useMemo(() => loaded?.links.filter((link) => isSecureLoginUrl(link.url)) ?? [], [loaded]);
  const matchesById = useMemo(() => new Map(importableLinks.map((link) => (
    [link.id, matchBookmarkSiteUrl(link.url, sites)] as const
  ))), [importableLinks, sites]);
  const selectableLinks = useMemo(() => importableLinks.filter((link) => {
    const match = matchesById.get(link.id);
    if (!match || match.kind === 'ambiguous') return false;
    return duplicateMode === 'overwrite' || match.kind === 'none';
  }), [importableLinks, matchesById, duplicateMode]);
  const selectableIds = useMemo(() => new Set(selectableLinks.map((link) => link.id)), [selectableLinks]);
  const visibleSelectableLinks = useMemo(() => visibleLinks.filter((link) => selectableIds.has(link.id)), [visibleLinks, selectableIds]);
  const selectedLinks = useMemo(() => selectableLinks.filter((link) => selected.has(link.id)), [selectableLinks, selected]);
  const visibleSelectedCount = visibleSelectableLinks.filter((link) => selected.has(link.id)).length;
  const allVisibleSelected = visibleSelectableLinks.length > 0 && visibleSelectedCount === visibleSelectableLinks.length;
  const allBookmarksSelected = selectableLinks.length > 0 && selectedLinks.length === selectableLinks.length;
  const unsupportedBookmarkCount = (loaded?.links.length ?? 0) - importableLinks.length;
  const existingBookmarkCount = importableLinks.filter((link) => {
    const match = matchesById.get(link.id);
    return match && match.kind !== 'none' && match.kind !== 'ambiguous';
  }).length;
  const ambiguousBookmarkCount = importableLinks.filter((link) => matchesById.get(link.id)?.kind === 'ambiguous').length;

  function navigate(path: string, dir: number) {
    setDirection(dir);
    setCurrentPath(path);
    setQuery('');
  }

  function toggleLink(id: string) {
    if (!selectableIds.has(id)) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleVisible() {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const link of visibleSelectableLinks) {
        if (allVisibleSelected) next.delete(link.id);
        else next.add(link.id);
      }
      return next;
    });
  }

  function toggleAllBookmarks() {
    setSelected((prev) => {
      if (selectableLinks.length > 0 && selectableLinks.every((link) => prev.has(link.id))) return new Set();
      return new Set(selectableLinks.map((link) => link.id));
    });
  }

  async function submit() {
    if (selectedLinks.length === 0 || busy || disabled) return;
    setBusy(true);
    setError('');
    try {
      const sitesToImport: Omit<SiteConfig, 'id'>[] = [];
      for (const link of selectedLinks) {
        const site = siteFromBookmark(link);
        if (!site) continue;
        sitesToImport.push(site);
      }
      if (sitesToImport.length === 0) throw new Error('所选书签没有可导入的 HTTPS 或本机 localhost HTTP 地址');
      await onImport(sitesToImport, { overwriteExisting: duplicateMode === 'overwrite' });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '书签导入失败');
    } finally {
      setBusy(false);
    }
  }

  const viewKey = searching ? `q:${query.trim()}` : currentPath || '__root__';

  return (
    <section className="overflow-hidden rounded-xl bg-ink-50 ring-1 ring-black/5 dark:bg-ink-900/60 dark:ring-white/10">
      {/* 头部：来源与操作 */}
      <div className="flex items-center justify-between gap-2 px-3 pt-3">
        <div className="flex min-w-0 items-center gap-2">
          <motion.span
            initial={{ rotate: -12, scale: 0.8 }}
            animate={{ rotate: 0, scale: 1 }}
            transition={{ type: 'spring', stiffness: 300, damping: 18 }}
            className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-500/10 text-brand-600 dark:text-brand-400"
          >
            <Bookmark className="size-4" />
          </motion.span>
          <div className="min-w-0">
            <h4 className="text-xs font-semibold text-ink-900 dark:text-ink-50">从书签导入</h4>
            <p className="truncate text-[11px] text-ink-800/45 dark:text-ink-100/35">
              {loaded ? `${loaded.label} · ${loaded.links.length} 个链接` : '与 Chrome 书签管理器结构一致'}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <input
            ref={inputRef}
            type="file"
            accept=".html,.htm,.json"
            className="hidden"
            onChange={(e) => {
              void handleFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          <motion.button
            whileTap={{ scale: 0.9, rotate: -30 }}
            type="button"
            title="重新读取浏览器书签"
            disabled={disabled || busy || loading}
            onClick={() => void loadBrowser()}
            className="rounded-lg p-2 text-ink-800/55 hover:bg-black/5 disabled:opacity-40 dark:text-ink-100/55 dark:hover:bg-white/10"
          >
            <RotateCw className={cn('size-4', loading && 'animate-spin')} />
          </motion.button>
          <motion.button
            whileTap={{ scale: 0.9 }}
            type="button"
            title="从导出的书签文件导入（HTML / JSON）"
            disabled={disabled || busy}
            onClick={() => inputRef.current?.click()}
            className="rounded-lg p-2 text-ink-800/55 hover:bg-black/5 disabled:opacity-40 dark:text-ink-100/55 dark:hover:bg-white/10"
          >
            <FileUp className="size-4" />
          </motion.button>
        </div>
      </div>

      <div className="space-y-2.5 p-3">
        {error && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex items-center justify-between gap-2 rounded-lg bg-rose-500/10 px-3 py-2 text-[11px] leading-relaxed text-rose-700 dark:text-rose-300"
          >
            <span>{error}</span>
            <button type="button" onClick={() => void loadBrowser()} className="shrink-0 font-medium hover:underline">
              重试
            </button>
          </motion.div>
        )}

        {loading && !loaded && (
          <div className="flex items-center justify-center gap-2 py-10 text-xs text-ink-800/45 dark:text-ink-100/35">
            <Loader2 className="size-4 animate-spin" />
            正在读取浏览器书签...
          </div>
        )}

        {loaded && (
          <>
            {unsupportedBookmarkCount > 0 && (
              <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-800 dark:text-amber-300">
                {unsupportedBookmarkCount} 个地址不符合导入安全规则，已从选择中排除（HTTPS 和本机 localhost HTTP 可导入）。
              </p>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white px-3 py-2 ring-1 ring-black/5 dark:bg-ink-950/40 dark:ring-white/10">
              <div className="flex items-center gap-2 text-[11px]">
                <span className="font-medium text-ink-800/65 dark:text-ink-100/55">重复站点</span>
                <button
                  type="button"
                  aria-pressed={duplicateMode === 'skip'}
                  onClick={() => setDuplicateMode('skip')}
                  className={cn('rounded-md px-2 py-1 transition-colors', duplicateMode === 'skip' ? 'bg-brand-500/10 font-semibold text-brand-700 dark:text-brand-300' : 'text-ink-800/50 hover:bg-ink-50 dark:text-ink-100/40 dark:hover:bg-white/5')}
                >
                  跳过已有
                </button>
                <button
                  type="button"
                  aria-pressed={duplicateMode === 'overwrite'}
                  onClick={() => setDuplicateMode('overwrite')}
                  className={cn('rounded-md px-2 py-1 transition-colors', duplicateMode === 'overwrite' ? 'bg-brand-500/10 font-semibold text-brand-700 dark:text-brand-300' : 'text-ink-800/50 hover:bg-ink-50 dark:text-ink-100/40 dark:hover:bg-white/5')}
                >
                  更新已有站点
                </button>
              </div>
              <span className="text-[10px] text-ink-800/40 dark:text-ink-100/30">
                更新只替换名称和登录地址，保留原配置 · 已匹配 {existingBookmarkCount} · 歧义 {ambiguousBookmarkCount}
              </span>
            </div>

            {/* 搜索 */}
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-800/30 dark:text-ink-100/25" />
              <input
                className="h-9 w-full rounded-lg bg-white pl-8 pr-2.5 text-xs text-ink-900 outline-none ring-1 ring-black/5 transition-shadow placeholder:text-ink-800/30 focus:ring-2 focus:ring-brand-500/45 dark:bg-ink-950/40 dark:text-ink-50 dark:ring-white/10 dark:placeholder:text-ink-100/25"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索全部书签：站点名 / 域名 / 文件夹"
              />
            </div>

            {/* 面包屑 */}
            {!searching && (
              <div className="flex items-center gap-1 overflow-x-auto whitespace-nowrap text-[11px]">
                <button
                  type="button"
                  onClick={() => navigate('', -1)}
                  className={cn(
                    'flex items-center gap-1 rounded-md px-1.5 py-1 font-medium transition-colors',
                    crumbs.length === 0
                      ? 'text-ink-900 dark:text-ink-50'
                      : 'text-brand-600 hover:bg-brand-500/10 dark:text-brand-400',
                  )}
                >
                  <Home className="size-3" />
                  全部书签
                </button>
                {crumbs.map((part, i) => (
                  <Fragment key={i}>
                    <ChevronRight className="size-3 shrink-0 text-ink-800/25 dark:text-ink-100/20" />
                    {i === crumbs.length - 1 ? (
                      <span className="px-1.5 py-1 font-medium text-ink-900 dark:text-ink-50">{part}</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => navigate(crumbs.slice(0, i + 1).join(' / '), -1)}
                        className="rounded-md px-1.5 py-1 font-medium text-brand-600 transition-colors hover:bg-brand-500/10 dark:text-brand-400"
                      >
                        {part}
                      </button>
                    )}
                  </Fragment>
                ))}
              </div>
            )}

            {/* 文件夹与书签列表，进入/返回带方向滑动 */}
            <div className="overflow-hidden rounded-lg bg-white ring-1 ring-black/5 dark:bg-ink-950/40 dark:ring-white/10">
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={viewKey}
                  initial={{ opacity: 0, x: 26 * direction }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -26 * direction }}
                  transition={{ duration: 0.16, ease: 'easeOut' }}
                  className="max-h-56 overflow-y-auto"
                >
                  {!searching &&
                    childFolders.map((folder, i) => (
                      <motion.button
                        key={folder.id}
                        type="button"
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: Math.min(i * 0.03, 0.24) }}
                        onClick={() => navigate(folder.path, 1)}
                        className="flex w-full items-center gap-2.5 border-b border-black/5 px-3 py-2 text-left transition-colors hover:bg-ink-50 dark:border-white/5 dark:hover:bg-white/[0.04]"
                      >
                        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400">
                          <Folder className="size-3.5" />
                        </span>
                        <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink-900 dark:text-ink-50">
                          {folder.name}
                        </span>
                        <span className="shrink-0 text-[10px] text-ink-800/35 dark:text-ink-100/25">
                          {folder.count} 个链接
                        </span>
                        <ChevronRight className="size-3.5 shrink-0 text-ink-800/25 dark:text-ink-100/20" />
                      </motion.button>
                    ))}

                  {visibleLinks.map((link, i) => {
                    const match = matchesById.get(link.id);
                    const secure = isSecureLoginUrl(link.url);
                    const ambiguous = match?.kind === 'ambiguous';
                    const exists = !!match && match.kind !== 'none' && !ambiguous;
                    const selectable = secure && !ambiguous && (duplicateMode === 'overwrite' || !exists);
                    const detail = !secure
                      ? '请使用 HTTPS（本机 localhost 可使用 HTTP）'
                      : ambiguous
                        ? `匹配到 ${match.sites.length} 个相同地址的站点，请先整理重复项`
                        : exists
                          ? duplicateMode === 'overwrite'
                            ? `将更新「${match.site.name}」的名称和登录地址`
                            : '站点已存在；选择“更新已有站点”可覆盖名称和登录地址'
                          : '将新建站点';
                    return (
                    <motion.div
                      key={link.id}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: Math.min((childFolders.length + i) * 0.03, 0.3) }}
                    >
                      <BookmarkRow link={link} checked={selected.has(link.id)} selectable={selectable} detail={detail} onToggle={() => toggleLink(link.id)} />
                    </motion.div>
                    );
                  })}

                  {!searching && childFolders.length === 0 && visibleLinks.length === 0 && (
                    <div className="px-3 py-8 text-center text-xs text-ink-800/40 dark:text-ink-100/30">
                      这个文件夹是空的
                    </div>
                  )}
                  {searching && visibleLinks.length === 0 && (
                    <div className="px-3 py-8 text-center text-xs text-ink-800/40 dark:text-ink-100/30">
                      没有匹配的书签
                    </div>
                  )}
                </motion.div>
              </AnimatePresence>
            </div>

            {/* 选择与导入 */}
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <button
                  type="button"
                  onClick={toggleAllBookmarks}
                  disabled={!selectableLinks.length || busy || disabled}
                  className="inline-flex items-center gap-1.5 text-[11px] font-medium text-brand-600 hover:underline disabled:opacity-40 dark:text-brand-400"
                >
                  {allBookmarksSelected ? <Check className="size-3.5" /> : <Square className="size-3.5" />}
                  {allBookmarksSelected ? '取消全选' : '全选全部书签'}
                </button>
                <button
                  type="button"
                  onClick={toggleVisible}
                  disabled={visibleSelectableLinks.length === 0 || busy || disabled}
                  className="inline-flex items-center gap-1.5 text-[11px] font-medium text-brand-600 hover:underline disabled:opacity-40 dark:text-brand-400"
                >
                  {allVisibleSelected ? <Check className="size-3.5" /> : <Square className="size-3.5" />}
                  {allVisibleSelected ? '取消当前列表' : '选择当前列表'}
                </button>
              </div>
              <span className="text-[11px] text-ink-800/45 dark:text-ink-100/35">
                已选 {selectedLinks.length} / 可选择 {selectableLinks.length} · 共 {loaded.links.length}
              </span>
            </div>

            <motion.button
              whileTap={{ scale: 0.98 }}
              type="button"
              disabled={selectedLinks.length === 0 || busy || disabled}
              onClick={submit}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white shadow-lg shadow-brand-500/20 transition-colors hover:bg-brand-600 disabled:opacity-40 disabled:shadow-none"
            >
              <FileUp className="size-4" />
              {busy ? '导入中...' : `导入选中站点 (${selectedLinks.length})`}
            </motion.button>
          </>
        )}
      </div>
    </section>
  );
}

function BookmarkRow({ link, checked, selectable, detail, onToggle }: { link: BookmarkLink; checked: boolean; selectable: boolean; detail: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={!selectable}
      className="flex w-full items-start gap-2.5 border-b border-black/5 px-3 py-2 text-left transition-colors last:border-b-0 hover:bg-ink-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/5 dark:hover:bg-white/[0.04]"
    >
      <span
        className={cn(
          'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border text-white transition-colors',
          checked ? 'border-brand-500 bg-brand-500' : 'border-black/15 bg-transparent dark:border-white/15',
        )}
      >
        {checked && <Check className="size-3" />}
      </span>
      <Globe className="mt-0.5 size-3.5 shrink-0 text-ink-800/25 dark:text-ink-100/20" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-ink-900 dark:text-ink-50">{link.name}</span>
        <span className="block truncate text-[11px] text-ink-800/45 dark:text-ink-100/35">{link.url}</span>
        <span className={cn('mt-0.5 block truncate text-[10px]', selectable ? 'text-ink-800/40 dark:text-ink-100/30' : 'text-amber-700 dark:text-amber-300')}>{detail}</span>
        {link.folderPath && (
          <span className="block truncate text-[10px] text-ink-800/35 dark:text-ink-100/25">{link.folderPath}</span>
        )}
      </span>
    </button>
  );
}
