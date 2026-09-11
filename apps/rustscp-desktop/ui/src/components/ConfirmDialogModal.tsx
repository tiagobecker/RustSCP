import React, { useEffect, useRef } from 'react';
import { AlertTriangle, Trash2, X, AlertCircle, Folder } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  subMessage?: string;
  items?: string[];
  confirmText?: string;
  cancelText?: string;
  variant?: 'danger' | 'warning' | 'info';
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}

export const ConfirmDialogModal: React.FC<ConfirmDialogProps> = ({
  isOpen,
  title,
  message,
  subMessage,
  items = [],
  confirmText,
  cancelText,
  variant = 'danger',
  onConfirm,
  onClose,
}) => {
  const { i18n } = useTranslation();
  const isPt = i18n.language.startsWith('pt');
  const confirmBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    // Auto-focus confirm button when modal opens
    const timer = setTimeout(() => {
      confirmBtnRef.current?.focus();
    }, 50);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        onConfirm();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onConfirm, onClose]);

  if (!isOpen) return null;

  const isDanger = variant === 'danger';
  const isWarning = variant === 'warning';

  return (
    <div 
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-in fade-in duration-100"
      onClick={onClose}
    >
      <div 
        className="w-full max-w-lg bg-white dark:bg-dark-800 rounded-xl shadow-2xl border border-slate-200 dark:border-dark-600 overflow-hidden flex flex-col animate-in zoom-in-95 duration-100"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-200 dark:border-dark-700 bg-slate-50 dark:bg-dark-750">
          <div className="flex items-center space-x-2.5">
            <div className={`p-1.5 rounded-lg ${
              isDanger 
                ? 'bg-red-500/15 text-red-600 dark:text-red-400' 
                : isWarning 
                ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400' 
                : 'bg-sky-500/15 text-sky-600 dark:text-sky-400'
            }`}>
              {isDanger ? (
                <Trash2 className="w-5 h-5" />
              ) : isWarning ? (
                <AlertTriangle className="w-5 h-5" />
              ) : (
                <AlertCircle className="w-5 h-5" />
              )}
            </div>
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {title}
            </h3>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-200/50 dark:hover:bg-dark-700 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-5 space-y-4 text-xs">
          {/* Main Message */}
          <div className="text-slate-700 dark:text-slate-200 leading-relaxed whitespace-pre-line font-medium">
            {message}
          </div>

          {/* SubMessage / Warning Box */}
          {subMessage && (
            <div className={`p-3 rounded-lg border flex items-start space-x-2.5 ${
              isDanger 
                ? 'bg-red-500/10 border-red-500/30 text-red-700 dark:text-red-300' 
                : isWarning
                ? 'bg-amber-500/10 border-amber-500/30 text-amber-800 dark:text-amber-300'
                : 'bg-sky-500/10 border-sky-500/30 text-sky-800 dark:text-sky-300'
            }`}>
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <div className="whitespace-pre-line font-medium leading-relaxed">
                {subMessage}
              </div>
            </div>
          )}

          {/* Items List (if any) */}
          {items.length > 0 && (
            <div className="space-y-1.5">
              <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                {isPt ? `Item(ns) selecionado(s) (${items.length}):` : `Selected item(s) (${items.length}):`}
              </span>
              <div className="max-h-36 overflow-y-auto rounded-md bg-slate-100 dark:bg-dark-900/70 border border-slate-200 dark:border-dark-700 p-2 space-y-1 divide-y divide-slate-200/50 dark:divide-dark-800">
                {items.map((item, idx) => (
                  <div key={idx} className="flex items-center space-x-2 pt-1 first:pt-0 font-mono text-[11px] text-slate-700 dark:text-slate-300 truncate">
                    <Folder className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                    <span className="truncate" title={item}>{item}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer Buttons */}
        <div className="flex items-center justify-end space-x-2.5 px-5 py-3.5 bg-slate-50 dark:bg-dark-750 border-t border-slate-200 dark:border-dark-700">
          <button
            type="button"
            onClick={onClose}
            className="px-3.5 py-1.5 rounded-lg border border-slate-300 dark:border-dark-600 bg-white dark:bg-dark-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-dark-650 hover:text-slate-900 dark:hover:text-white transition-colors font-medium cursor-pointer shadow-xs"
          >
            {cancelText || (isPt ? 'Cancelar (Esc)' : 'Cancel (Esc)')}
          </button>
          <button
            ref={confirmBtnRef}
            type="button"
            onClick={onConfirm}
            className={`px-4 py-1.5 rounded-lg font-medium transition-colors flex items-center space-x-1.5 cursor-pointer shadow-sm text-white ${
              isDanger 
                ? 'bg-red-600 hover:bg-red-700 focus:ring-2 focus:ring-red-500/40' 
                : isWarning 
                ? 'bg-amber-600 hover:bg-amber-700 focus:ring-2 focus:ring-amber-500/40'
                : 'bg-sky-600 hover:bg-sky-700 focus:ring-2 focus:ring-sky-500/40'
            }`}
          >
            {isDanger && <Trash2 className="w-3.5 h-3.5" />}
            <span>{confirmText || (isPt ? 'Confirmar (Enter)' : 'Confirm (Enter)')}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
