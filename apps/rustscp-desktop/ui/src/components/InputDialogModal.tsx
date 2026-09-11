import React, { useState, useEffect, useRef } from 'react';
import { FolderPlus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export interface InputDialogProps {
  isOpen: boolean;
  title: string;
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: (value: string) => void | Promise<void>;
  onClose: () => void;
}

export const InputDialogModal: React.FC<InputDialogProps> = ({
  isOpen,
  title,
  message,
  defaultValue = '',
  placeholder = '',
  confirmText,
  cancelText,
  onConfirm,
  onClose,
}) => {
  const { i18n } = useTranslation();
  const isPt = i18n.language.startsWith('pt');
  const [value, setValue] = useState<string>(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setValue(defaultValue);
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 50);
    }
  }, [isOpen, defaultValue]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (value.trim()) {
      onConfirm(value.trim());
    }
  };

  return (
    <div 
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-in fade-in duration-100"
      onClick={onClose}
    >
      <div 
        className="w-full max-w-md bg-white dark:bg-dark-800 rounded-xl shadow-2xl border border-slate-200 dark:border-dark-600 overflow-hidden flex flex-col animate-in zoom-in-95 duration-100"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-200 dark:border-dark-700 bg-slate-50 dark:bg-dark-750">
          <div className="flex items-center space-x-2.5">
            <div className="p-1.5 rounded-lg bg-rust-500/15 text-rust-600 dark:text-rust-400">
              <FolderPlus className="w-5 h-5" />
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

        <form onSubmit={handleSubmit}>
          <div className="p-5 space-y-3 text-xs">
            {message && (
              <div className="text-slate-600 dark:text-slate-300 font-medium">
                {message}
              </div>
            )}
            <input
              ref={inputRef}
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={placeholder}
              className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-dark-600 bg-white dark:bg-dark-900 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-rust-500/40 focus:border-rust-500 font-mono shadow-xs"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </div>

          <div className="flex items-center justify-end space-x-2.5 px-5 py-3.5 bg-slate-50 dark:bg-dark-750 border-t border-slate-200 dark:border-dark-700 text-xs">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-1.5 rounded-lg border border-slate-300 dark:border-dark-600 bg-white dark:bg-dark-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-dark-650 transition-colors font-medium cursor-pointer shadow-xs"
            >
              {cancelText || (isPt ? 'Cancelar (Esc)' : 'Cancel (Esc)')}
            </button>
            <button
              type="submit"
              disabled={!value.trim()}
              className="px-4 py-1.5 rounded-lg font-medium transition-colors bg-rust-600 hover:bg-rust-700 disabled:opacity-40 text-white cursor-pointer shadow-sm"
            >
              {confirmText || (isPt ? 'Criar Pasta' : 'Create')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
