import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

interface Props {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  children: ReactNode;
}

/** Native modal keeps keyboard focus inside and restores it to the opener on close. */
export function ProxyImportDialog({ open, busy, onClose, children }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    else if (!open && element.open) element.close();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      id="proxy-import"
      aria-labelledby="proxy-import-heading"
      onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}
      onClick={(event) => {
        if (busy || event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
      }}
      className="fixed inset-0 m-auto w-[calc(100%-2rem)] max-w-2xl overflow-hidden rounded-xl border border-slate-200 bg-white p-0 text-slate-900 shadow-2xl backdrop:bg-slate-950/45 backdrop:backdrop-blur-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
    >
      <div className="flex max-h-[calc(100dvh-2rem)] flex-col">
        <header className="flex shrink-0 items-center justify-between border-b border-slate-200 px-5 py-4 dark:border-slate-800">
          <div>
            <h2 id="proxy-import-heading" className="text-base font-semibold">添加代理</h2>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">导入后自动加入代理列表。</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="关闭添加代理" className="grid size-8 shrink-0 place-items-center rounded-md text-slate-500 hover:bg-slate-100 disabled:opacity-40 dark:text-slate-400 dark:hover:bg-slate-800"><X className="size-4" /></button>
        </header>
        <div className="min-h-0 overflow-y-auto p-4 sm:p-5">{children}</div>
        <footer className="flex shrink-0 justify-end border-t border-slate-200 px-5 py-3 dark:border-slate-800">
          <button type="button" onClick={onClose} disabled={busy} className="h-9 rounded-lg bg-blue-600 px-5 text-[13px] font-medium text-white hover:bg-blue-700 disabled:opacity-40">完成</button>
        </footer>
      </div>
    </dialog>
  );
}
