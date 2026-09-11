import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { 
  X, 
  Archive, 
  Check, 
  FileText, 
  ArrowDownToLine, 
  RefreshCw 
} from 'lucide-react';

interface CompressionModalProps {
  isOpen: boolean;
  onClose: () => void;
  mode: 'compress' | 'extract';
  currentDir: string;
  targetItems?: string[]; // for compress
  archivePath?: string; // for extract
  isRemote: boolean;
  onCompress: (items: string[], format: string, outputName: string) => Promise<void>;
  onExtract: (archivePath: string, destSubfolder?: string) => Promise<void>;
}

export const CompressionModal: React.FC<CompressionModalProps> = ({
  isOpen,
  onClose,
  mode,
  currentDir,
  targetItems = [],
  archivePath = '',
  isRemote,
  onCompress,
  onExtract,
}) => {
  const { i18n } = useTranslation();
  const isPt = i18n.language.startsWith('pt');

  // Compress state
  const [format, setFormat] = useState<string>('tar.gz');
  const [outputName, setOutputName] = useState<string>('');

  // Extract state
  const [destSubfolder, setDestSubfolder] = useState<string>('');
  const [extractToFolder, setExtractToFolder] = useState<boolean>(true);

  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string>('');

  useEffect(() => {
    if (mode === 'compress') {
      const firstItem = targetItems[0]?.split('/').pop()?.split('\\').pop() || 'archive';
      const stem = firstItem.includes('.') ? firstItem.substring(0, firstItem.lastIndexOf('.')) : firstItem;
      const ext = format === 'zip' ? '.zip' : format === 'tar.bz2' ? '.tar.bz2' : format === 'tar.xz' ? '.tar.xz' : format === 'tar' ? '.tar' : '.tar.gz';
      setOutputName(`${stem}${ext}`);
    } else if (mode === 'extract' && archivePath) {
      const base = archivePath.split('/').pop()?.split('\\').pop() || '';
      const folderName = base.replace(/\.(tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz|tar|zip)$/i, '');
      setDestSubfolder(folderName);
    }
    setErrorMessage('');
  }, [mode, targetItems, archivePath, format]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsProcessing(true);
    setErrorMessage('');
    try {
      if (mode === 'compress') {
        const itemNames = targetItems.map((p) => p.split('/').pop()?.split('\\').pop() || p);
        await onCompress(itemNames, format, outputName);
      } else {
        await onExtract(archivePath, extractToFolder ? destSubfolder : undefined);
      }
      onClose();
    } catch (err: any) {
      setErrorMessage(String(err));
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-3 animate-in fade-in duration-150">
      <div className="bg-white dark:bg-dark-800 border border-slate-300 dark:border-dark-600 rounded-xl shadow-2xl max-w-lg w-full overflow-hidden flex flex-col text-slate-900 dark:text-slate-100">
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-slate-200 dark:border-dark-600 bg-slate-100 dark:bg-dark-750 flex items-center justify-between select-none">
          <div className="flex items-center space-x-2.5">
            <div className="p-2 rounded-lg bg-rust-500/15 text-rust-500 dark:text-rust-400 border border-rust-500/30">
              {mode === 'compress' ? <Archive className="w-5 h-5" /> : <ArrowDownToLine className="w-5 h-5" />}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
                  {mode === 'compress' 
                    ? (isPt ? 'Compactar Arquivos' : 'Compress Files') 
                    : (isPt ? 'Extrair Arquivo Compactado' : 'Extract Archive')}
                </h3>
                <span className="text-[10px] px-1.5 py-0.2 rounded bg-slate-200 dark:bg-dark-700 text-slate-700 dark:text-slate-300 font-mono">
                  {isRemote ? (isPt ? 'Remoto' : 'Remote') : 'Local'}
                </span>
              </div>
              <span className="text-[11px] text-slate-500 dark:text-slate-400 font-mono truncate max-w-xs block">
                {currentDir}
              </span>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-slate-200 dark:hover:bg-dark-700 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-5 space-y-4 text-xs">
          {mode === 'compress' ? (
            <>
              {/* Selected Items Summary */}
              <div className="bg-slate-50 dark:bg-dark-900 border border-slate-200 dark:border-dark-600 rounded-lg p-3 space-y-1.5">
                <span className="text-slate-600 dark:text-slate-400 font-medium">
                  {isPt ? 'Itens Selecionados para Compactação:' : 'Items to Compress:'}
                </span>
                <div className="max-h-24 overflow-y-auto space-y-1 pr-1">
                  {targetItems.map((item, idx) => (
                    <div key={idx} className="flex items-center space-x-1.5 text-slate-800 dark:text-slate-200 font-mono text-[11px] truncate">
                      <FileText className="w-3.5 h-3.5 text-rust-500 dark:text-rust-400 shrink-0" />
                      <span className="truncate">{item.split('/').pop()?.split('\\').pop()}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Format Selection */}
              <div className="space-y-1.5">
                <label className="font-semibold text-slate-700 dark:text-slate-300">
                  {isPt ? 'Formato de Compactação' : 'Archive Format'}
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { id: 'tar.gz', label: '.tar.gz', desc: 'Tar + Gzip (Linux Standard)' },
                    { id: 'zip', label: '.zip', desc: 'Universal (Windows / Mac / Linux)' },
                    { id: 'tar.bz2', label: '.tar.bz2', desc: 'Bzip2 (High Ratio)' },
                    { id: 'tar.xz', label: '.tar.xz', desc: 'XZ (Maximum Compression)' },
                  ].map((fmt) => (
                    <button
                      type="button"
                      key={fmt.id}
                      onClick={() => setFormat(fmt.id)}
                      className={`p-2.5 rounded-lg border text-left transition-all ${
                        format === fmt.id
                          ? 'bg-rust-500/15 border-rust-500 text-rust-600 dark:text-rust-400 shadow-sm'
                          : 'bg-slate-50 dark:bg-dark-700/60 border-slate-200 dark:border-dark-600 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-dark-700'
                      }`}
                    >
                      <div className="font-mono font-bold text-xs">{fmt.label}</div>
                      <div className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5 truncate">{fmt.desc}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Output Name */}
              <div className="space-y-1">
                <label className="font-semibold text-slate-700 dark:text-slate-300">
                  {isPt ? 'Nome do Arquivo Gerado' : 'Archive Output Name'}
                </label>
                <input
                  type="text"
                  value={outputName}
                  onChange={(e) => setOutputName(e.target.value)}
                  className="w-full bg-white dark:bg-dark-900 border border-slate-300 dark:border-dark-600 rounded-lg px-3 py-2 text-slate-900 dark:text-slate-100 font-mono focus:outline-none focus:border-rust-500 text-xs shadow-sm"
                />
              </div>
            </>
          ) : (
            <>
              {/* Extract Source Archive */}
              <div className="bg-slate-50 dark:bg-dark-900 border border-slate-200 dark:border-dark-600 rounded-lg p-3 space-y-1">
                <span className="text-slate-600 dark:text-slate-400 font-medium">
                  {isPt ? 'Arquivo a ser extraído:' : 'Archive to Extract:'}
                </span>
                <div className="font-mono text-rust-600 dark:text-rust-300 truncate font-semibold">
                  {archivePath.split('/').pop()?.split('\\').pop()}
                </div>
              </div>

              {/* Extract Destination Options */}
              <div className="space-y-2">
                <label className="flex items-center space-x-2 cursor-pointer text-slate-700 dark:text-slate-300">
                  <input
                    type="checkbox"
                    checked={extractToFolder}
                    onChange={(e) => setExtractToFolder(e.target.checked)}
                    className="rounded border-slate-300 dark:border-dark-600 text-rust-500 focus:ring-rust-500"
                  />
                  <span>{isPt ? 'Extrair dentro de uma subpasta' : 'Extract into subfolder'}</span>
                </label>

                {extractToFolder && (
                  <div className="space-y-1 pl-5">
                    <label className="text-[11px] text-slate-600 dark:text-slate-400">
                      {isPt ? 'Nome da subpasta:' : 'Subfolder name:'}
                    </label>
                    <input
                      type="text"
                      value={destSubfolder}
                      onChange={(e) => setDestSubfolder(e.target.value)}
                      className="w-full bg-white dark:bg-dark-900 border border-slate-300 dark:border-dark-600 rounded-lg px-3 py-1.5 text-slate-900 dark:text-slate-100 font-mono focus:outline-none focus:border-rust-500 text-xs shadow-sm"
                    />
                  </div>
                )}
              </div>
            </>
          )}

          {/* Error Message */}
          {errorMessage && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-2.5 text-red-600 dark:text-red-400 text-xs">
              {errorMessage}
            </div>
          )}

          {/* Footer Buttons */}
          <div className="pt-2 border-t border-slate-200 dark:border-dark-700 flex items-center justify-end space-x-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg bg-slate-200 hover:bg-slate-300 text-slate-700 dark:bg-dark-700 dark:hover:bg-dark-600 dark:text-slate-300 font-semibold text-xs border border-slate-300 dark:border-slate-600 transition-colors"
            >
              {isPt ? 'Cancelar' : 'Cancel'}
            </button>

            <button
              type="submit"
              disabled={isProcessing}
              className="flex items-center space-x-1.5 px-4 py-2 rounded-lg bg-rust-600 hover:bg-rust-500 disabled:opacity-40 text-white font-bold text-xs transition-all shadow-md"
            >
              {isProcessing ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  <span>{isPt ? 'Processando...' : 'Processing...'}</span>
                </>
              ) : (
                <>
                  <Check className="w-3.5 h-3.5" />
                  <span>
                    {mode === 'compress' 
                      ? (isPt ? 'Iniciar Compactação' : 'Start Compression') 
                      : (isPt ? 'Extrair Arquivos' : 'Extract Files')}
                  </span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
