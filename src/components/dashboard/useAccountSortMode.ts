import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_ACCOUNT_SORT_MODE,
  normalizeAccountSortMode,
  type AccountSortMode,
} from '@/lib/core/account-sort';

export const ACCOUNT_SORT_STORAGE_KEY = 'accountSortMode';

// 同一页面中快速连续切换时按选择顺序写入，避免旧请求最后完成。
let saveQueue: Promise<void> = Promise.resolve();

export function useAccountSortMode() {
  const [mode, setMode] = useState<AccountSortMode>(DEFAULT_ACCOUNT_SORT_MODE);
  const revision = useRef(0);

  useEffect(() => {
    let disposed = false;
    const readRevision = revision.current;
    const listener = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
      if (areaName !== 'local' || !(ACCOUNT_SORT_STORAGE_KEY in changes)) return;
      revision.current += 1;
      setMode(normalizeAccountSortMode(changes[ACCOUNT_SORT_STORAGE_KEY].newValue));
    };
    chrome.storage.onChanged.addListener(listener);
    void chrome.storage.local.get(ACCOUNT_SORT_STORAGE_KEY).then((stored) => {
      // 初次读取较慢时，不覆盖用户刚选的值或其他页面同步过来的更新。
      if (!disposed && revision.current === readRevision) {
        setMode(normalizeAccountSortMode(stored[ACCOUNT_SORT_STORAGE_KEY]));
      }
    }).catch(() => {
      // 读取失败时保持默认或本页刚选的值；不将默认值回写到存储。
    });
    return () => {
      disposed = true;
      chrome.storage.onChanged.removeListener(listener);
    };
  }, []);

  const setSortMode = useCallback((value: AccountSortMode): Promise<void> => {
    const nextMode = normalizeAccountSortMode(value);
    revision.current += 1;
    setMode(nextMode);
    const saved = saveQueue.then(() => chrome.storage.local.set({ [ACCOUNT_SORT_STORAGE_KEY]: nextMode }));
    // 单次写入失败不能阻断后续选择的保存；失败仍交给调用者提示。
    saveQueue = saved.catch(() => {});
    return saved;
  }, []);

  return [mode, setSortMode] as const;
}
