import React, { useState, useEffect } from 'react';
import { 
  X, 
  Save, 
  FileCode, 
  Check, 
  Search, 
  
} from 'lucide-react';

interface FileEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  fileName: string;
  filePath: string;
  initialContent: string;
  onSave: (path: string, content: string) => Promise<void>;
}

export const FileEditorModal: React.FC<FileEditorModalProps> = ({
  isOpen,
  onClose,
  fileName,
  filePath,
  initialContent,
  onSave,
}) => {
  const [content, setContent] = useState<string>('');
  const [isDirty, setIsDirty] = useState<boolean>(false);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [saveSuccess, setSaveSuccess] = useState<boolean>(false);
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [showSearch, setShowSearch] = useState<boolean>(false);

  useEffect(() => {
    setContent(initialContent);
    setIsDirty(false);
  }, [initialContent, filePath]);

  if (!isOpen) return null;

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setContent(e.target.value);
    setIsDirty(true);
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await onSave(filePath, content);
      setIsDirty(false);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
    } catch (err) {
      alert(`Falha ao salvar: ${err}`);
    } finally {
      setIsSaving(false);
    }
  };

  // Keyboard shortcut Ctrl+S / Cmd+S
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      handleSave();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      setShowSearch(!showSearch);
    }
  };

  const lineCount = content.split('\n').length;

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div 
        onKeyDown={handleKeyDown}
        className="bg-white dark:bg-dark-800 border border-slate-300 dark:border-dark-600 rounded-xl max-w-5xl w-full shadow-2xl flex flex-col h-[680px] overflow-hidden text-slate-900 dark:text-slate-100"
      >
        {/* Editor Header */}
        <div className="px-5 py-3 border-b border-slate-200 dark:border-dark-700 flex items-center justify-between bg-slate-100 dark:bg-dark-750 select-none">
          <div className="flex items-center space-x-2.5">
            <div className="p-1.5 rounded bg-sky-500/10 text-sky-600 dark:text-sky-400 border border-sky-500/20">
              <FileCode className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <span className="font-bold text-slate-900 dark:text-slate-100 text-xs">{fileName}</span>
                {isDirty && (
                  <span className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-700 dark:text-amber-300 border border-amber-500/30 text-[10px] font-mono font-medium">
                    Não Salvo
                  </span>
                )}
              </div>
              <span className="text-[11px] text-slate-500 dark:text-slate-400 font-mono truncate max-w-lg block">
                {filePath}
              </span>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            <button
              onClick={() => setShowSearch(!showSearch)}
              title="Buscar (Ctrl+F)"
              className="p-1.5 rounded hover:bg-slate-200 dark:hover:bg-dark-600 text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white transition-colors"
            >
              <Search className="w-4 h-4" />
            </button>

            <button
              onClick={handleSave}
              disabled={isSaving || !isDirty}
              className="flex items-center space-x-1.5 px-3 py-1.5 rounded bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-white text-xs font-bold transition-all shadow-md"
            >
              {saveSuccess ? <Check className="w-3.5 h-3.5" /> : <Save className="w-3.5 h-3.5" />}
              <span>{saveSuccess ? 'Salvo!' : isSaving ? 'Salvando...' : 'Salvar no Servidor'}</span>
            </button>

            <button onClick={onClose} className="text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white p-1.5 rounded-md hover:bg-slate-200 dark:hover:bg-dark-700 transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Quick Search Bar */}
        {showSearch && (
          <div className="bg-slate-100 dark:bg-dark-900 border-b border-slate-200 dark:border-dark-700 px-4 py-2 flex items-center space-x-2">
            <Search className="w-3.5 h-3.5 text-slate-400" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Localizar texto no arquivo..."
              className="bg-white dark:bg-dark-800 border border-slate-300 dark:border-dark-700 rounded px-2.5 py-1 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:border-sky-500 w-72"
            />
            <button 
              onClick={() => setShowSearch(false)}
              className="text-xs text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200 font-medium"
            >
              Fechar
            </button>
          </div>
        )}

        {/* Text Area Code Body */}
        <div className="flex-1 flex overflow-hidden bg-slate-900 dark:bg-dark-950 font-mono text-xs">
          {/* Line Numbers Simulation */}
          <div className="w-12 bg-slate-950/80 dark:bg-dark-900/90 text-slate-400 dark:text-slate-500 text-right pr-2 pt-3 select-none border-r border-slate-800 dark:border-dark-700/60 font-mono text-[11px] overflow-hidden">
            {Array.from({ length: Math.min(lineCount, 500) }).map((_, i) => (
              <div key={i} className="leading-5">{i + 1}</div>
            ))}
          </div>

          <textarea
            value={content}
            onChange={handleTextChange}
            spellCheck={false}
            className="flex-1 bg-transparent text-slate-100 dark:text-slate-200 p-3 leading-5 resize-none focus:outline-none overflow-auto font-mono text-xs selection:bg-sky-500/30"
          />
        </div>

        {/* Editor Status Bar */}
        <div className="h-6 bg-slate-100 dark:bg-dark-900 border-t border-slate-200 dark:border-dark-700 px-4 flex items-center justify-between text-[11px] text-slate-600 dark:text-slate-400 font-mono select-none">
          <div className="flex items-center space-x-4">
            <span>Linhas: {lineCount}</span>
            <span>Tamanho: {content.length} bytes</span>
            <span>Codificação: UTF-8</span>
          </div>

          <div className="flex items-center space-x-2">
            <span>Modo: Edição Direta Remota</span>
          </div>
        </div>
      </div>
    </div>
  );
};
