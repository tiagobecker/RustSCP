import React, { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { Link2, X } from 'lucide-react';

interface SymlinkModalProps {
  isOpen: boolean;
  onClose: () => void;
  sessionId: string;
  currentDir: string;
  selectedItemPath?: string;
  onSuccess: () => void;
}

export const SymlinkModal: React.FC<SymlinkModalProps> = ({
  isOpen,
  onClose,
  sessionId,
  currentDir,
  selectedItemPath,
  onSuccess,
}) => {
  const { i18n } = useTranslation();
  const isPt = i18n.language.startsWith('pt');

  const [linkName, setLinkName] = useState('');
  const [targetPath, setTargetPath] = useState(selectedItemPath || '');
  const [isSymbolic, setIsSymbolic] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleCreate = async () => {
    if (!linkName.trim() || !targetPath.trim()) return;
    setIsSubmitting(true);
    setError(null);

    try {
      const fullLinkPath = linkName.startsWith('/')
        ? linkName.trim()
        : `${currentDir.replace(/\/$/, '')}/${linkName.trim()}`;

      await invoke('create_symlink', {
        sessionId,
        linkPath: fullLinkPath,
        targetPath: targetPath.trim(),
        isSymbolic,
      });

      onSuccess();
      onClose();
    } catch (err: any) {
      setError(err.toString());
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-white dark:bg-dark-800 border border-slate-300 dark:border-dark-600 rounded-xl shadow-2xl w-full max-w-md flex flex-col overflow-hidden text-slate-900 dark:text-slate-100 animate-in fade-in zoom-in-95 duration-150">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-dark-700 flex items-center justify-between bg-slate-100 dark:bg-dark-750">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 rounded-lg border border-cyan-500/20">
              <Link2 className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold tracking-wide text-slate-900 dark:text-slate-100">
                {isPt ? 'Criar Link Simbólico / Hardlink' : 'Create Symbolic Link / Hardlink'}
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {isPt ? 'Atalho apontando para outro arquivo ou pasta' : 'Shortcut pointing to target file or directory'}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white p-1.5 rounded-lg hover:bg-slate-200 dark:hover:bg-dark-700 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
              {isPt ? 'Nome do Link (Atalho)' : 'Link Name (Shortcut)'}
            </label>
            <input
              type="text"
              value={linkName}
              onChange={(e) => setLinkName(e.target.value)}
              placeholder="my_symlink"
              className="w-full bg-white dark:bg-dark-900 border border-slate-300 dark:border-dark-700 rounded-lg px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:border-cyan-500 shadow-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
              {isPt ? 'Apontar para o Alvo (Target Path)' : 'Point to Target (Target Path)'}
            </label>
            <input
              type="text"
              value={targetPath}
              onChange={(e) => setTargetPath(e.target.value)}
              placeholder="/var/www/html or relative path"
              className="w-full bg-white dark:bg-dark-900 border border-slate-300 dark:border-dark-700 rounded-lg px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:border-cyan-500 font-mono shadow-sm"
            />
          </div>

          <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer select-none pt-1">
            <input
              type="checkbox"
              checked={isSymbolic}
              onChange={(e) => setIsSymbolic(e.target.checked)}
              className="rounded border-slate-300 dark:border-slate-700 bg-white dark:bg-dark-900 text-cyan-600 dark:text-cyan-500 focus:ring-0"
            />
            {isPt ? 'Link Simbólico (Recomendado - desmarque para Hardlink)' : 'Symbolic Link (Recommended - uncheck for Hardlink)'}
          </label>

          {error && (
            <div className="p-3 bg-rose-500/10 border border-rose-500/20 text-rose-600 dark:text-rose-300 text-xs rounded-lg">
              {error}
            </div>
          )}
        </div>

        <div className="px-6 py-3 border-t border-slate-200 dark:border-dark-700 bg-slate-100 dark:bg-dark-750 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-slate-200 hover:bg-slate-300 text-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 text-xs font-medium border border-slate-300 dark:border-slate-700 transition-colors"
          >
            {isPt ? 'Cancelar' : 'Cancel'}
          </button>
          <button
            onClick={handleCreate}
            disabled={isSubmitting || !linkName.trim() || !targetPath.trim()}
            className="px-4 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white text-xs font-medium transition-colors shadow-sm"
          >
            {isSubmitting ? (isPt ? 'Criando...' : 'Creating...') : (isPt ? 'Criar Link' : 'Create Link')}
          </button>
        </div>
      </div>
    </div>
  );
};
