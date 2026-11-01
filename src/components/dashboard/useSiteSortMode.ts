import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_SITE_SORT_MODE, normalizeSiteSortMode, type SiteSortMode } from '@/lib/core/site-sort';

export const SITE_SORT_STORAGE_KEY = 'siteSortMode';

// 与账号排序独立保存，切换名称顺序不会覆盖手动排序数据。
let saveQueue: Promise<void> = Promise.resolve();

export function useSiteSortMode() {
  const [mode, setMode] = useState<SiteSortMode>(DEFAULT_SITE_SORT_MODE);
  const revision = useRef(0);

  useEffect(() => {
    let disposed = false;
    const readRevision = revision.current;
    const listener = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
      if (areaName !== 'local' || !(SITE_SORT_STORAGE_KEY in changes)) return;
      revision.current += 1;
      setMode(normalizeSiteSortMode(changes[SITE_SORT_STORAGE_KEY].newValue));
    };
    chrome.storage.onChanged.addListener(listener);
    void chrome.storage.local.get(SITE_SORT_STORAGE_KEY).then((stored) => {
      if (!disposed && revision.current === readRevision) {
        setMode(normalizeSiteSortMode(stored[SITE_SORT_STORAGE_KEY]));
      }
    }).catch(() => {
      // 读取失败不覆盖本页选择，也不把默认值写回。
    });
    return () => {
      disposed = true;
      chrome.storage.onChanged.removeListener(listener);
    };
  }, []);

  const setSortMode = useCallback((value: SiteSortMode): Promise<void> => {
    const nextMode = normalizeSiteSortMode(value);
    revision.current += 1;
    setMode(nextMode);
    const saved = saveQueue.then(() => chrome.storage.local.set({ [SITE_SORT_STORAGE_KEY]: nextMode }));
    saveQueue = saved.catch(() => {});
    return saved;
  }, []);

  return [mode, setSortMode] as const;
}
