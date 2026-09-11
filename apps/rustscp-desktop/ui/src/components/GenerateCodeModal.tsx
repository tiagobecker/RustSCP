import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { Code, Copy, Check, X, Terminal, Globe, FileCode } from 'lucide-react';

interface ConnectionConfig {
  id: string;
  name: string;
  protocol: string;
  host: string;
  port: number;
  username: string;
  auth: any;
  remote_root: string;
}

interface GenerateCodeModalProps {
  isOpen: boolean;
  onClose: () => void;
  config: ConnectionConfig | null;
  remotePath: string;
  localPath: string;
}

export const GenerateCodeModal: React.FC<GenerateCodeModalProps> = ({
  isOpen,
  onClose,
  config,
  remotePath,
  localPath,
}) => {
  const { i18n } = useTranslation();
  const isPt = i18n.language.startsWith('pt');

  const [selectedLang, setSelectedLang] = useState<string>('batch_script');
  const [generatedCode, setGeneratedCode] = useState<string>('');
  const [copied, setCopied] = useState(false);

  const languages = [
    { id: 'batch_script', label: isPt ? 'Script em Lote (.bat/.sh)' : 'Batch Automation Script', icon: Terminal },
    { id: 'session_url', label: isPt ? 'URL de Sessão (URI)' : 'Session URL (URI)', icon: Globe },
    { id: 'curl', label: 'cURL Command', icon: Terminal },
    { id: 'python', label: 'Python (Paramiko)', icon: FileCode },
    { id: 'bash_rsync', label: 'Rsync Bash', icon: Terminal },
    { id: 'dotnet', label: '.NET C# Assembly', icon: Code },
  ];

  useEffect(() => {
    if (isOpen && config) {
      loadCode(selectedLang);
    }
  }, [isOpen, selectedLang, config, remotePath, localPath]);

  const loadCode = async (lang: string) => {
    if (!config) return;
    try {
      const code = await invoke<string>('generate_automation_code', {
        config,
        targetLang: lang,
        remotePath: remotePath || '/',
        localPath: localPath || '.',
      });
      setGeneratedCode(code);
    } catch (err: any) {
      setGeneratedCode(`// Error generating code: ${err.toString()}`);
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(generatedCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!isOpen || !config) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-white dark:bg-dark-800 border border-slate-300 dark:border-dark-600 rounded-xl shadow-2xl w-full max-w-3xl flex flex-col max-h-[85vh] overflow-hidden text-slate-900 dark:text-slate-100 animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 dark:border-dark-800 flex items-center justify-between bg-slate-100 dark:bg-dark-750">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-500/10 text-blue-600 dark:text-blue-400 rounded-lg border border-blue-500/20">
              <Code className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100 tracking-wide">
                {isPt ? 'Gerar Código de Automação & URL' : 'Generate Automation Code & URL'}
              </h2>
              <p className="text-xs text-slate-600 dark:text-slate-400">
                {isPt
                  ? 'Gere scripts prontos para rodar em lote, APIs ou linha de comando'
                  : 'Generate ready-to-run automation scripts, APIs, or CLI commands'}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-500 hover:text-slate-950 dark:text-slate-400 dark:hover:text-white p-1.5 rounded-lg hover:bg-slate-200 dark:hover:bg-dark-700 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Language Tabs */}
        <div className="flex items-center gap-1.5 px-6 py-3 border-b border-slate-200 dark:border-dark-800 bg-slate-50 dark:bg-dark-900/60 overflow-x-auto select-none">
          {languages.map((lang) => {
            const Icon = lang.icon;
            const active = selectedLang === lang.id;
            return (
              <button
                key={lang.id}
                onClick={() => setSelectedLang(lang.id)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap border ${
                  active
                    ? 'bg-blue-600 text-white shadow-sm border-blue-600'
                    : 'border-slate-200 dark:border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-200/70 dark:hover:bg-slate-800'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {lang.label}
              </button>
            );
          })}
        </div>

        {/* Code Content View */}
        <div className="flex-1 bg-slate-950 p-5 overflow-auto relative">
          <pre className="font-mono text-xs text-emerald-300/90 leading-relaxed whitespace-pre-wrap select-text">
            {generatedCode}
          </pre>
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-dark-750 flex items-center justify-between select-none">
          <span className="text-xs text-slate-600 dark:text-slate-400 font-mono">
            {config.name} ({config.protocol}://{config.host})
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopy}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold transition-colors shadow-md"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-300" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? (isPt ? 'Copiado!' : 'Copied!') : (isPt ? 'Copiar Código' : 'Copy Code')}
            </button>
            <button
              onClick={onClose}
              className="px-4 py-1.5 rounded-lg bg-slate-200 hover:bg-slate-300 text-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 text-xs font-semibold border border-slate-300 dark:border-slate-700 transition-colors"
            >
              {isPt ? 'Fechar' : 'Close'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
