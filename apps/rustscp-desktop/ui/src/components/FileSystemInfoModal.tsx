import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { HardDrive, Shield, X, Copy, Check, Server } from 'lucide-react';

interface FileSystemInfo {
  path: string;
  total_bytes: number;
  free_bytes: number;
  available_bytes: number;
  used_bytes: number;
  total_inodes: number | null;
  free_inodes: number | null;
  protocol_name: string;
  protocol_version: string;
  host_key_fingerprint_sha256: string | null;
  host_key_fingerprint_md5: string | null;
  cipher_name: string | null;
  compression_name: string | null;
}

interface FileSystemInfoModalProps {
  isOpen: boolean;
  onClose: () => void;
  sessionId: string;
  path: string;
}

export const FileSystemInfoModal: React.FC<FileSystemInfoModalProps> = ({
  isOpen,
  onClose,
  sessionId,
  path,
}) => {
  const { i18n } = useTranslation();
  const isPt = i18n.language.startsWith('pt');

  const [activeTab, setActiveTab] = useState<'space' | 'protocol'>('space');
  const [info, setInfo] = useState<FileSystemInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (isOpen) {
      loadInfo();
    }
  }, [isOpen, sessionId, path]);

  const loadInfo = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await invoke<FileSystemInfo>('get_filesystem_info', {
        sessionId,
        path: path || '/',
      });
      setInfo(res);
    } catch (err: any) {
      setError(err.toString());
    } finally {
      setLoading(false);
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const getUsedPercentage = () => {
    if (!info || info.total_bytes === 0) return 0;
    return Math.min(100, Math.round((info.used_bytes / info.total_bytes) * 100));
  };

  const handleCopyClipboard = () => {
    if (!info) return;
    const text = `RustSCP Server & Filesystem Information
Path: ${info.path}
Total Space: ${formatBytes(info.total_bytes)}
Used Space: ${formatBytes(info.used_bytes)} (${getUsedPercentage()}%)
Free Space: ${formatBytes(info.available_bytes)}
Protocol: ${info.protocol_name} (${info.protocol_version})
SSH Host Key (SHA-256): ${info.host_key_fingerprint_sha256 || 'N/A'}
SSH Host Key (MD5): ${info.host_key_fingerprint_md5 || 'N/A'}
Cipher: ${info.cipher_name || 'N/A'}
Compression: ${info.compression_name || 'N/A'}`;

    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!isOpen) return null;

  const usedPct = getUsedPercentage();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-white dark:bg-dark-800 border border-slate-300 dark:border-dark-600 rounded-xl shadow-2xl w-full max-w-2xl flex flex-col overflow-hidden text-slate-900 dark:text-slate-100 animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 dark:border-dark-800 flex items-center justify-between bg-slate-100 dark:bg-dark-750">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-amber-500/10 text-amber-600 dark:text-amber-400 rounded-lg border border-amber-500/20">
              <Server className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100 tracking-wide">
                {isPt ? 'Informações do Sistema & Disco' : 'Server & Filesystem Info'}
              </h2>
              <p className="text-xs text-slate-600 dark:text-slate-400 font-mono truncate max-w-md">{path || '/'}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-500 hover:text-slate-950 dark:text-slate-400 dark:hover:text-white p-1.5 rounded-lg hover:bg-slate-200 dark:hover:bg-dark-700 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab Headers */}
        <div className="flex items-center border-b border-slate-200 dark:border-dark-800 bg-slate-50 dark:bg-dark-900 px-6">
          <button
            onClick={() => setActiveTab('space')}
            className={`flex items-center gap-2 py-3 px-4 text-xs font-bold border-b-2 transition-colors ${
              activeTab === 'space'
                ? 'border-amber-500 text-amber-600 dark:text-amber-400 bg-amber-500/10'
                : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            <HardDrive className="w-4 h-4" />
            {isPt ? 'Espaço em Disco' : 'Space Available'}
          </button>
          <button
            onClick={() => setActiveTab('protocol')}
            className={`flex items-center gap-2 py-3 px-4 text-xs font-bold border-b-2 transition-colors ${
              activeTab === 'protocol'
                ? 'border-amber-500 text-amber-600 dark:text-amber-400 bg-amber-500/10'
                : 'border-transparent text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            <Shield className="w-4 h-4" />
            {isPt ? 'Protocolo & Segurança' : 'Protocol & Security'}
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-5 bg-white dark:bg-dark-900">
          {loading ? (
            <div className="py-12 flex flex-col items-center justify-center text-slate-500 dark:text-slate-400 gap-2">
              <Server className="w-8 h-8 animate-bounce text-amber-500 dark:text-amber-400" />
              <span className="text-xs font-medium">{isPt ? 'Carregando informações do sistema remoto...' : 'Querying remote filesystem stats...'}</span>
            </div>
          ) : error ? (
            <div className="p-4 bg-rose-500/10 border border-rose-500/20 text-rose-600 dark:text-rose-300 text-xs rounded-lg">
              {error}
            </div>
          ) : info ? (
            activeTab === 'space' ? (
              <div className="space-y-4">
                {/* Usage Bar */}
                <div>
                  <div className="flex justify-between text-xs font-semibold mb-1.5">
                    <span className="text-slate-700 dark:text-slate-300">{isPt ? 'Uso do Disco' : 'Disk Usage'}</span>
                    <span className="text-amber-600 dark:text-amber-400 font-mono font-bold">{usedPct}%</span>
                  </div>
                  <div className="w-full h-3 bg-slate-200 dark:bg-slate-950 rounded-full overflow-hidden border border-slate-300 dark:border-slate-800">
                    <div
                      className={`h-full transition-all duration-500 rounded-full ${
                        usedPct > 90 ? 'bg-rose-500' : usedPct > 75 ? 'bg-amber-500' : 'bg-emerald-500'
                      }`}
                      style={{ width: `${usedPct}%` }}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 pt-2">
                  <div className="bg-slate-50 dark:bg-dark-800/60 p-3 rounded-lg border border-slate-200 dark:border-slate-800/80">
                    <span className="text-slate-500 dark:text-slate-400 text-xs block mb-1 font-semibold">{isPt ? 'Espaço Total' : 'Total Space'}</span>
                    <span className="font-mono text-sm font-bold text-slate-900 dark:text-slate-100">{formatBytes(info.total_bytes)}</span>
                  </div>
                  <div className="bg-slate-50 dark:bg-dark-800/60 p-3 rounded-lg border border-slate-200 dark:border-slate-800/80">
                    <span className="text-slate-500 dark:text-slate-400 text-xs block mb-1 font-semibold">{isPt ? 'Espaço Disponível' : 'Available Space'}</span>
                    <span className="font-mono text-sm font-bold text-emerald-600 dark:text-emerald-400">{formatBytes(info.available_bytes)}</span>
                  </div>
                  <div className="bg-slate-50 dark:bg-dark-800/60 p-3 rounded-lg border border-slate-200 dark:border-slate-800/80">
                    <span className="text-slate-500 dark:text-slate-400 text-xs block mb-1 font-semibold">{isPt ? 'Espaço em Uso' : 'Used Space'}</span>
                    <span className="font-mono text-sm font-bold text-amber-600 dark:text-amber-400">{formatBytes(info.used_bytes)}</span>
                  </div>
                  <div className="bg-slate-50 dark:bg-dark-800/60 p-3 rounded-lg border border-slate-200 dark:border-slate-800/80">
                    <span className="text-slate-500 dark:text-slate-400 text-xs block mb-1 font-semibold">{isPt ? 'Inodes Livres / Total' : 'Free / Total Inodes'}</span>
                    <span className="font-mono text-sm font-bold text-slate-800 dark:text-slate-300">
                      {info.free_inodes ? `${info.free_inodes.toLocaleString()} / ${info.total_inodes?.toLocaleString()}` : 'N/A'}
                    </span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="bg-slate-50 dark:bg-dark-800/60 p-3 rounded-lg border border-slate-200 dark:border-slate-800/80 flex justify-between items-center">
                  <span className="text-slate-600 dark:text-slate-400 text-xs font-semibold">{isPt ? 'Protocolo' : 'Protocol'}</span>
                  <span className="font-mono text-xs text-slate-900 dark:text-slate-200 font-semibold">{info.protocol_name}</span>
                </div>
                <div className="bg-slate-50 dark:bg-dark-800/60 p-3 rounded-lg border border-slate-200 dark:border-slate-800/80 flex justify-between items-center">
                  <span className="text-slate-600 dark:text-slate-400 text-xs font-semibold">{isPt ? 'Versão SFTP/Protocolo' : 'Protocol Version'}</span>
                  <span className="font-mono text-xs text-slate-900 dark:text-slate-200 font-semibold">{info.protocol_version}</span>
                </div>
                <div className="bg-slate-50 dark:bg-dark-800/60 p-3 rounded-lg border border-slate-200 dark:border-slate-800/80">
                  <span className="text-slate-600 dark:text-slate-400 text-xs block mb-1 font-semibold">SSH Host Key Fingerprint (SHA-256)</span>
                  <span className="font-mono text-xs text-emerald-600 dark:text-emerald-400 break-all select-all font-semibold">
                    {info.host_key_fingerprint_sha256 || 'N/A'}
                  </span>
                </div>
                <div className="bg-slate-50 dark:bg-dark-800/60 p-3 rounded-lg border border-slate-200 dark:border-slate-800/80">
                  <span className="text-slate-600 dark:text-slate-400 text-xs block mb-1 font-semibold">SSH Host Key Fingerprint (MD5)</span>
                  <span className="font-mono text-xs text-amber-600 dark:text-amber-400 break-all select-all font-semibold">
                    {info.host_key_fingerprint_md5 || 'N/A'}
                  </span>
                </div>
                <div className="bg-slate-50 dark:bg-dark-800/60 p-3 rounded-lg border border-slate-200 dark:border-slate-800/80 flex justify-between items-center">
                  <span className="text-slate-600 dark:text-slate-400 text-xs font-semibold">{isPt ? 'Cifra de Criptografia' : 'Cipher'}</span>
                  <span className="font-mono text-xs text-slate-900 dark:text-slate-200 font-semibold">{info.cipher_name || 'N/A'}</span>
                </div>
              </div>
            )
          ) : null}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-dark-750 flex items-center justify-between select-none">
          <button
            onClick={handleCopyClipboard}
            disabled={!info}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-200 hover:bg-slate-300 text-slate-800 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-200 text-xs font-semibold border border-slate-300 dark:border-slate-700 transition-colors"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? (isPt ? 'Copiado!' : 'Copied!') : (isPt ? 'Copiar Informações' : 'Copy Information')}
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
  );
};
