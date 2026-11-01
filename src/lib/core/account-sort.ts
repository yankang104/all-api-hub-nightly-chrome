import type { Account } from '@/types';

export type AccountSortMode = 'name-asc' | 'name-desc' | 'added';
export const DEFAULT_ACCOUNT_SORT_MODE: AccountSortMode = 'name-asc';

export function normalizeAccountSortMode(value: unknown): AccountSortMode {
  return value === 'name-desc' || value === 'added' ? value : DEFAULT_ACCOUNT_SORT_MODE;
}

const accountNameCollator = new Intl.Collator('zh-CN', {
  sensitivity: 'base',
  numeric: true,
});

/** 只调整展示顺序；同名保持原顺序，不修改存储中的账号顺序。 */
export function sortAccounts(
  accounts: readonly Account[],
  mode: AccountSortMode = DEFAULT_ACCOUNT_SORT_MODE,
): Account[] {
  if (mode === 'added') return [...accounts];
  const direction = mode === 'name-desc' ? -1 : 1;
  return [...accounts].sort((a, b) => direction * accountNameCollator.compare(
    a.label || a.username,
    b.label || b.username,
  ));
}

export function sortAccountsByDisplayName(accounts: readonly Account[]): Account[] {
  return sortAccounts(accounts);
}
