import React, { useState } from 'react';
import { X, Hash, Copy, Check } from 'lucide-react';

interface ChecksumModalProps {
  isOpen: boolean;
  onClose: () => void;
  fileName: string;
  filePath: string;
  onCalculate: (algo: string) => Promise<string>;
}

export const ChecksumModal: React.FC<ChecksumModalProps> = ({
  isOpen,
  onClose,
  fileName,
  filePath,
  onCalculate,
}) => {
  const [algo, setAlgo] = useState<string>('SHA-256');
  const [hash, setHash] = useState<string>('');
  const [isCalculating, setIsCalculating] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);

  if (!isOpen) return null;

  const handleCompute = async () => {
    setIsCalculating(true);
    try {
      const res = await onCalculate(algo);
      setHash(res);
    } catch (err) {
      alert(`Erro: ${err}`);
    } finally {
      setIsCalculating(false);
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(hash);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-dark-800 border border-slate-300 dark:border-dark-600 rounded-xl max-w-lg w-full shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-5 py-3 border-b border-slate-200 dark:border-dark-700 flex items-center justify-between bg-slate-100 dark:bg-dark-750">
          <div className="flex items-center space-x-2">
            <Hash className="w-4 h-4 text-sky-500 dark:text-sky-400" />
            <h3 className="font-bold text-slate-900 dark:text-slate-100 text-xs">Calcular Checksum / Hash</h3>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white p-1 rounded-md hover:bg-slate-200 dark:hover:bg-dark-700 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4 text-xs">
          <div>
            <span className="text-slate-500 dark:text-slate-400 font-semibold block">Arquivo:</span>
            <span className="font-mono text-slate-900 dark:text-slate-200 block truncate">{fileName} ({filePath})</span>
          </div>

          <div className="flex items-center space-x-3">
            <label className="font-semibold text-slate-700 dark:text-slate-300">Algoritmo:</label>
            <select
              value={algo}
              onChange={(e) => setAlgo(e.target.value)}
              className="bg-white dark:bg-dark-900 border border-slate-300 dark:border-dark-700 rounded px-2.5 py-1 text-slate-900 dark:text-slate-200 focus:outline-none focus:border-sky-500"
            >
              <option value="SHA-256">SHA-256 (Padrão Seguro)</option>
              <option value="MD5">MD5 (Legado)</option>
            </select>

            <button
              onClick={handleCompute}
              disabled={isCalculating}
              className="px-3 py-1 rounded bg-sky-600 hover:bg-sky-500 text-white font-semibold shadow-sm disabled:opacity-50"
            >
              {isCalculating ? 'Calculando...' : 'Calcular'}
            </button>
          </div>

          {hash && (
            <div className="space-y-1">
              <span className="font-semibold text-slate-700 dark:text-slate-300">Hash Calculado:</span>
              <div className="flex items-center space-x-2 bg-slate-100 dark:bg-black/80 p-2.5 rounded border border-slate-300 dark:border-dark-700 font-mono text-[11px] text-emerald-600 dark:text-emerald-400 break-all select-all">
                <span className="flex-1">{hash}</span>
                <button
                  onClick={handleCopy}
                  className="p-1 rounded hover:bg-slate-200 dark:hover:bg-dark-700 text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white transition-colors"
                >
                  {copied ? <Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-2.5 border-t border-slate-200 dark:border-dark-700 bg-slate-100 dark:bg-dark-750 flex items-center justify-end">
          <button onClick={onClose} className="px-3 py-1 rounded text-slate-700 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white hover:bg-slate-200 dark:hover:bg-dark-700 transition-colors font-medium">
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
};
