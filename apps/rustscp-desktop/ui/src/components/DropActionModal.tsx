import React, { useEffect, useRef } from 'react';
import { Copy, Scissors, ArrowRight, X, File, Folder, HardDrive, Globe, ShieldAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export interface DropActionModalProps {
  isOpen: boolean;
  onClose: () => void;
  sourceSessionId: string;
  sourceSessionName?: string;
  sourcePaths: string[];
  destSessionId: string;
  destSessionName?: string;
  destDir: string;
  onConfirm: (action: 'copy' | 'move') => void;
}

export const DropActionModal: React.FC<DropActionModalProps> = ({
  isOpen,
  onClose,
  sourceSessionId,
  sourceSessionName,
  sourcePaths,
  destSessionId,
  destSessionName,
  destDir,
  onConfirm,
}) => {
  const { i18n } = useTranslation();
  const isPt = i18n.language.startsWith('pt');
  const copyBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    const timer = setTimeout(() => {
      copyBtnRef.current?.focus();
    }, 50);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const count = sourcePaths.length;
  const isFromDesktop = sourceSessionId === 'local' && !sourceSessionName;
  const sourceLabel = sourceSessionName || (isFromDesktop ? (isPt ? 'Desktop / Mac Finder' : 'Desktop / OS Files') : 'Local');
  const destLabel = destSessionName || (destSessionId === 'local' ? (isPt ? 'Meu Computador' : 'Local Computer') : (isPt ? 'Servidor Remoto' : 'Remote Server'));

  const previewItems = sourcePaths.slice(0, 4).map((p) => {
    const name = p.split('/').filter(Boolean).pop() || p;
    const isDir = !p.includes('.') || p.endsWith('/');
    return { path: p, name, isDir };
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-in fade-in duration-100"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg bg-white dark:bg-dark-800 rounded-2xl shadow-2xl border border-slate-200 dark:border-dark-600 overflow-hidden flex flex-col animate-in zoom-in-95 duration-100"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-dark-700 bg-slate-50/80 dark:bg-dark-750">
          <div className="flex items-center space-x-3">
            <div className="p-2 rounded-xl bg-rust-500/15 text-rust-600 dark:text-rust-400">
              <Copy className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
                {isPt ? 'Soltar & Transferir Arquivos' : 'Drop & Transfer Files'}
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {isPt ? 'Escolha como deseja enviar os itens para o destino' : 'Choose how you want to send items to the destination'}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-200/50 dark:hover:bg-dark-700 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-4 text-xs">
          {/* Source -> Destination visual badges */}
          <div className="flex items-center justify-between p-3.5 rounded-xl bg-slate-100 dark:bg-dark-900 border border-slate-200/70 dark:border-dark-700">
            <div className="flex items-center space-x-2.5 min-w-0 flex-1">
              <div className="p-1.5 rounded-lg bg-slate-200 dark:bg-dark-700 text-slate-700 dark:text-slate-300 shrink-0">
                {sourceSessionId === 'local' ? <HardDrive className="w-4 h-4" /> : <Globe className="w-4 h-4" />}
              </div>
              <div className="min-w-0">
                <span className="text-[10px] uppercase font-bold text-slate-400 tracking-wider block">
                  {isPt ? 'Origem' : 'Source'}
                </span>
                <span className="font-semibold text-slate-800 dark:text-slate-200 truncate block">
                  {sourceLabel}
                </span>
              </div>
            </div>

            <div className="px-3 text-slate-400 dark:text-slate-500 shrink-0">
              <ArrowRight className="w-4 h-4" />
            </div>

            <div className="flex items-center space-x-2.5 min-w-0 flex-1">
              <div className="p-1.5 rounded-lg bg-rust-500/15 text-rust-600 dark:text-rust-400 shrink-0">
                {destSessionId === 'local' ? <HardDrive className="w-4 h-4" /> : <Globe className="w-4 h-4" />}
              </div>
              <div className="min-w-0">
                <span className="text-[10px] uppercase font-bold text-slate-400 tracking-wider block">
                  {isPt ? 'Destino' : 'Destination'}
                </span>
                <span className="font-semibold text-slate-800 dark:text-slate-200 truncate block">
                  {destLabel}
                </span>
              </div>
            </div>
          </div>

          {/* Destination Path indicator */}
          <div className="flex items-center space-x-2 px-3 py-2 rounded-lg bg-slate-50 dark:bg-dark-750 border border-slate-200 dark:border-dark-700 font-mono text-[11px] text-slate-600 dark:text-slate-300 truncate">
            <Folder className="w-3.5 h-3.5 text-amber-500 shrink-0" />
            <span className="text-slate-400">{isPt ? 'Pasta de destino:' : 'Target directory:'}</span>
            <span className="font-bold truncate">{destDir}</span>
          </div>

          {/* List of items preview */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                {isPt ? `Itens selecionados (${count}):` : `Selected items (${count}):`}
              </span>
            </div>
            <div className="max-h-36 overflow-y-auto space-y-1.5 p-2 rounded-xl bg-slate-50 dark:bg-dark-900 border border-slate-200 dark:border-dark-700 font-mono text-[11px]">
              {previewItems.map((item, idx) => (
                <div key={idx} className="flex items-center space-x-2 text-slate-700 dark:text-slate-300 truncate">
                  {item.isDir ? (
                    <Folder className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                  ) : (
                    <File className="w-3.5 h-3.5 text-sky-500 shrink-0" />
                  )}
                  <span className="truncate">{item.name}</span>
                </div>
              ))}
              {count > 4 && (
                <div className="text-[10px] text-slate-400 italic pt-1">
                  {isPt ? `... e mais ${count - 4} outros itens` : `... and ${count - 4} more items`}
                </div>
              )}
            </div>
          </div>

          {/* Safety Notice */}
          <div className="flex items-start space-x-2.5 p-2.5 rounded-xl bg-sky-50 dark:bg-sky-950/30 border border-sky-200 dark:border-sky-800/40 text-[11px] text-sky-800 dark:text-sky-300">
            <ShieldAlert className="w-4 h-4 shrink-0 text-sky-600 dark:text-sky-400 mt-0.5" />
            <div>
              <span className="font-semibold block">
                {isPt ? 'Dica de Segurança:' : 'Safety Tip:'}
              </span>
              <span>
                {isPt
                  ? 'Escolha "Copiar" para manter o arquivo de origem seguro no seu computador. "Recortar / Mover" removerá o arquivo da origem após o envio.'
                  : 'Choose "Copy" to safely preserve the source file on your computer. "Cut / Move" will delete the source file after sending.'}
              </span>
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="flex items-center justify-end space-x-2.5 px-6 py-4 border-t border-slate-200 dark:border-dark-700 bg-slate-50 dark:bg-dark-750">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl border border-slate-300 dark:border-dark-600 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-dark-700 font-medium transition-colors cursor-pointer"
          >
            {isPt ? 'Cancelar' : 'Cancel'}
          </button>

          <button
            type="button"
            onClick={() => {
              onConfirm('move');
              onClose();
            }}
            className="px-4 py-2 rounded-xl border border-amber-500/50 bg-amber-50 dark:bg-amber-500/10 hover:bg-amber-100 dark:hover:bg-amber-500/20 text-amber-700 dark:text-amber-300 font-semibold flex items-center space-x-1.5 transition-colors cursor-pointer"
          >
            <Scissors className="w-3.5 h-3.5" />
            <span>{isPt ? 'Recortar / Mover' : 'Cut / Move'}</span>
          </button>

          <button
            ref={copyBtnRef}
            type="button"
            onClick={() => {
              onConfirm('copy');
              onClose();
            }}
            className="px-5 py-2 rounded-xl bg-rust-600 hover:bg-rust-700 text-white font-bold shadow-md shadow-rust-600/20 flex items-center space-x-1.5 transition-colors cursor-pointer"
          >
            <Copy className="w-3.5 h-3.5" />
            <span>{isPt ? 'Copiar para Destino' : 'Copy to Destination'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
