import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** 合并 className，后者覆盖前者的冲突 Tailwind 类 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
