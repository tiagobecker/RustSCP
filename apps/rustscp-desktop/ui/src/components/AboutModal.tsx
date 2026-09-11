import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { 
  X, 
  Info, 
  Check, 
  Copy, 
  ShieldCheck, 
  Terminal, 
  Cpu, 
  Calendar, 
  Hash, 
  Sparkles
} from 'lucide-react';

interface AboutModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const AboutModal: React.FC<AboutModalProps> = ({ isOpen, onClose }) => {
  const { i18n } = useTranslation();
  const isPt = i18n.language.startsWith('pt');
  const [copied, setCopied] = useState<boolean>(false);

  if (!isOpen) return null;

  const version = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.1.0';
  const buildTimestamp = typeof __BUILD_TIMESTAMP__ !== 'undefined' ? __BUILD_TIMESTAMP__ : '2026-09-09 20:25:00';
  const buildNumber = typeof __BUILD_NUMBER__ !== 'undefined' ? __BUILD_NUMBER__ : '20260909-202500';
  const buildTarget = typeof __BUILD_TARGET__ !== 'undefined' ? __BUILD_TARGET__ : 'macOS (Tauri WKWebView)';

  const handleCopyDiagnostics = async () => {
    const info = `RustSCP Version: ${version}\nBuild Number: ${buildNumber}\nBuild Timestamp: ${buildTimestamp}\nTarget: ${buildTarget}\nEngine: Tauri v2 + Rust Core VFS + Tokio`;
    try {
      await navigator.clipboard.writeText(info);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy to clipboard:', err);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-xs z-50 flex items-center justify-center p-3 animate-in fade-in duration-150">
      <div className="bg-white dark:bg-dark-800 border border-slate-300 dark:border-dark-600 rounded-2xl shadow-2xl max-w-lg w-full flex flex-col overflow-hidden text-slate-900 dark:text-slate-100">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 dark:border-dark-700 bg-slate-50 dark:bg-dark-850 flex items-center justify-between select-none">
          <div className="flex items-center space-x-2.5">
            <div className="p-2 rounded-xl bg-rust-500/15 text-rust-600 dark:text-rust-400 border border-rust-500/30 shadow-xs">
              <Info className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
                {isPt ? 'Sobre o RustSCP' : 'About RustSCP'}
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {isPt ? 'Versionador & Diagnóstico de Compilação' : 'Versioner & Build Diagnostics'}
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-slate-200 dark:hover:bg-dark-700 text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-5 overflow-y-auto max-h-[80vh]">
          {/* Brand Presentation */}
          <div className="flex items-center space-x-4 bg-gradient-to-r from-rust-500/10 via-amber-500/5 to-transparent p-4 rounded-xl border border-rust-500/20">
            <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-rust-500 to-amber-600 flex items-center justify-center text-white shadow-lg shrink-0">
              <Sparkles className="w-7 h-7" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <h2 className="text-lg font-black tracking-tight text-slate-900 dark:text-white">
                  RustSCP
                </h2>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-rust-500 text-white shadow-xs">
                  v{version}
                </span>
              </div>
              <p className="text-xs text-slate-600 dark:text-slate-300 mt-0.5">
                {isPt 
                  ? 'Gerenciador Dual-Pane de Alta Performance SSH / SFTP / S3' 
                  : 'High-Performance Dual-Pane SSH / SFTP / S3 Commander'}
              </p>
            </div>
          </div>

          {/* Live Build Versioner Card */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-600 dark:text-slate-400 uppercase tracking-wider flex items-center space-x-1.5">
                <Hash className="w-3.5 h-3.5 text-rust-500" />
                <span>{isPt ? 'Versionador de Compilação' : 'Build Versioner'}</span>
              </span>
              <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-100 dark:bg-emerald-950/80 text-emerald-800 dark:text-emerald-300 border border-emerald-300 dark:border-emerald-700/60">
                <ShieldCheck className="w-3.5 h-3.5" />
                <span>{isPt ? 'Última Versão Compilada' : 'Latest Build Active'}</span>
              </span>
            </div>

            <div className="bg-slate-100 dark:bg-dark-900 rounded-xl border border-slate-200 dark:border-dark-700 p-4 space-y-3 font-mono text-xs">
              <div className="flex items-center justify-between border-b border-slate-200 dark:border-dark-800 pb-2">
                <span className="text-slate-500 dark:text-slate-400 flex items-center space-x-1.5 font-sans font-medium">
                  <Calendar className="w-3.5 h-3.5 text-slate-400" />
                  <span>{isPt ? 'Data / Hora da Compilação' : 'Build Timestamp'}</span>
                </span>
                <span className="font-bold text-slate-900 dark:text-slate-100 bg-white dark:bg-dark-800 px-2 py-0.5 rounded border border-slate-200 dark:border-dark-700">
                  {buildTimestamp}
                </span>
              </div>

              <div className="flex items-center justify-between border-b border-slate-200 dark:border-dark-800 pb-2">
                <span className="text-slate-500 dark:text-slate-400 flex items-center space-x-1.5 font-sans font-medium">
                  <Hash className="w-3.5 h-3.5 text-slate-400" />
                  <span>{isPt ? 'Número da Compilação (Build ID)' : 'Build ID'}</span>
                </span>
                <span className="font-bold text-rust-600 dark:text-rust-400">
                  {buildNumber}
                </span>
              </div>

              <div className="flex items-center justify-between border-b border-slate-200 dark:border-dark-800 pb-2">
                <span className="text-slate-500 dark:text-slate-400 flex items-center space-x-1.5 font-sans font-medium">
                  <Cpu className="w-3.5 h-3.5 text-slate-400" />
                  <span>{isPt ? 'Ambiente Alvo' : 'Target Architecture'}</span>
                </span>
                <span className="text-slate-800 dark:text-slate-200 font-sans">
                  {buildTarget}
                </span>
              </div>

              <div className="flex items-center justify-between pt-0.5">
                <span className="text-slate-500 dark:text-slate-400 flex items-center space-x-1.5 font-sans font-medium">
                  <Terminal className="w-3.5 h-3.5 text-slate-400" />
                  <span>{isPt ? 'Engine & Núcleo' : 'Core Runtime'}</span>
                </span>
                <span className="text-slate-800 dark:text-slate-200 font-sans text-[11px]">
                  Rust 1.85+ · Tauri v2 · Tokio VFS
                </span>
              </div>
            </div>
          </div>

          {/* Features Highlights */}
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-dark-850 border border-slate-200 dark:border-dark-700">
              <span className="font-bold text-slate-800 dark:text-slate-200 block">Modo Commander</span>
              <span className="text-slate-500 dark:text-slate-400 text-[11px]">
                {isPt ? 'Dois painéis remotos com abas e resize dinâmico' : 'Dual remote panels with tabs & dynamic resize'}
              </span>
            </div>
            <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-dark-850 border border-slate-200 dark:border-dark-700">
              <span className="font-bold text-slate-800 dark:text-slate-200 block">Zero Cópia Local</span>
              <span className="text-slate-500 dark:text-slate-400 text-[11px]">
                {isPt ? 'Streaming direto em memória RAM entre servidores' : 'Direct in-memory RAM streaming between servers'}
              </span>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 border-t border-slate-200 dark:border-dark-700 bg-slate-50 dark:bg-dark-850 flex items-center justify-between select-none">
          <button
            onClick={handleCopyDiagnostics}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-200 hover:bg-slate-300 dark:bg-dark-700 dark:hover:bg-dark-600 text-slate-800 dark:text-slate-200 border border-slate-300 dark:border-dark-600 transition-colors cursor-pointer"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5 text-slate-500" />}
            <span>{copied ? (isPt ? 'Copiado!' : 'Copied!') : (isPt ? 'Copiar Diagnóstico' : 'Copy Diagnostics')}</span>
          </button>

          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg text-xs font-bold bg-rust-500 hover:bg-rust-600 text-white shadow-xs transition-colors cursor-pointer"
          >
            {isPt ? 'Fechar' : 'Close'}
          </button>
        </div>
      </div>
    </div>
  );
};
