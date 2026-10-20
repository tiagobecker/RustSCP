import React, { useState, useId, useRef } from 'react';
import {
  ShieldCheck,
  Lock,
  Download,
  Upload,
  Copy,
  Check,
  X,
  FileText,
  AlertTriangle,
  Key,
  RefreshCw,
  Eye,
  EyeOff,
  Database,
  FolderTree,
  Server,
  Filter,
  CheckCircle2,
  ArrowRight,
  Sparkles,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { ConnectionConfig, WinScpImportResult } from '../types.ts';

interface VaultModalProps {
  isOpen: boolean;
  onClose: () => void;
  siteCount: number;
  onSitesUpdated: (newSites: ConnectionConfig[]) => void;
  initialTab?: 'export' | 'import' | 'winscp';
}

export const VaultModal: React.FC<VaultModalProps> = ({
  isOpen,
  onClose,
  siteCount,
  onSitesUpdated,
  initialTab = 'export',
}) => {
  const fileInputId = useId();
  const winscpFileInputId = useId();
  const [activeTab, setActiveTab] = useState<'export' | 'import' | 'winscp'>(initialTab);

  // --- Export State ---
  const [exportPassword, setExportPassword] = useState('');
  const [exportPasswordConfirm, setExportPasswordConfirm] = useState('');
  const [showExportPassword, setShowExportPassword] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportedJson, setExportedJson] = useState<string | null>(null);
  const [copiedExport, setCopiedExport] = useState(false);

  // --- Import Vault State ---
  const [importJson, setImportJson] = useState('');
  const [importPassword, setImportPassword] = useState('');
  const [showImportPassword, setShowImportPassword] = useState(false);
  const [mergeMode, setMergeMode] = useState<'merge' | 'replace'>('merge');
  const [isImporting, setIsImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);

  // --- WinSCP Migration State ---
  const [winscpFilePath, setWinscpFilePath] = useState('/Users/tiagobecker/Downloads/WinSCP.ini');
  const [winscpContent, setWinscpContent] = useState('');
  const [winscpIsPath, setWinscpIsPath] = useState(true);
  const [winscpPreview, setWinscpPreview] = useState<WinScpImportResult | null>(null);
  const [winscpMergeMode, setWinscpMergeMode] = useState<'merge' | 'replace'>('merge');
  const [isWinscpLoading, setIsWinscpLoading] = useState(false);
  const [winscpProgressStage, setWinscpProgressStage] = useState<'idle' | 'reading' | 'decrypting' | 'saving' | 'done'>('idle');
  const [winscpStatusMessage, setWinscpStatusMessage] = useState<string>('');
  const [winscpError, setWinscpError] = useState<string | null>(null);
  const [winscpSuccess, setWinscpSuccess] = useState<string | null>(null);
  const [winscpCompletedMetrics, setWinscpCompletedMetrics] = useState<{
    total: number;
    folders: number;
    passwords: number;
    keys: number;
    mode: 'merge' | 'replace';
  } | null>(null);
  const [selectedFolderFilter, setSelectedFolderFilter] = useState<string>('all');
  const winscpActionAreaRef = useRef<HTMLDivElement | null>(null);

  // --- Handler: Export ---
  const handleExport = async () => {
    setExportError(null);
    if (!exportPassword) {
      setExportError('Por favor, informe uma senha para proteger o cofre.');
      return;
    }
    if (exportPassword.length < 6) {
      setExportError('A senha deve conter no mínimo 6 caracteres para segurança.');
      return;
    }
    if (exportPassword !== exportPasswordConfirm) {
      setExportError('As senhas digitadas não coincidem.');
      return;
    }

    setIsExporting(true);
    try {
      const json = await invoke<string>('export_sites_vault', {
        password: exportPassword,
      });
      setExportedJson(json);
    } catch (err: any) {
      setExportError(String(err));
    } finally {
      setIsExporting(false);
    }
  };

  const handleDownloadVaultFile = () => {
    if (!exportedJson) return;
    const blob = new Blob([exportedJson], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const timestamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `rustscp-vault-${timestamp}.rustscp-vault`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleCopyExportJson = () => {
    if (!exportedJson) return;
    navigator.clipboard.writeText(exportedJson);
    setCopiedExport(true);
    setTimeout(() => setCopiedExport(false), 2000);
  };

  // --- Handler: Import Vault ---
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      if (content) {
        setImportJson(content);
        setImportError(null);
      }
    };
    reader.readAsText(file);
  };

  const handleImport = async () => {
    setImportError(null);
    setImportSuccess(null);

    if (!importJson.trim()) {
      setImportError('Selecione um arquivo .rustscp-vault ou cole o JSON criptografado.');
      return;
    }
    if (!importPassword) {
      setImportError('Informe a senha com a qual o arquivo foi criptografado.');
      return;
    }

    setIsImporting(true);
    try {
      const updatedSites = await invoke<ConnectionConfig[]>('import_sites_vault', {
        vaultJson: importJson.trim(),
        password: importPassword,
        mergeMode,
      });

      onSitesUpdated(updatedSites);
      setImportSuccess(
        `Sucesso! O cofre foi decodificado e ${updatedSites.length} conexão(ões) estão ativas.`
      );
      setImportJson('');
      setImportPassword('');
    } catch (err: any) {
      setImportError(
        String(err).includes('DecryptionFailed') || String(err).includes('senha')
          ? 'Senha incorreta ou integridade do arquivo violada (Auth Tag inválida).'
          : String(err)
      );
    } finally {
      setIsImporting(false);
    }
  };

  // --- Handler: WinSCP Migration ---
  const handleWinscpFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const path = (file as any).path || file.name;
    if ((file as any).path) {
      setWinscpFilePath(path);
      setWinscpIsPath(true);
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      if (content) {
        setWinscpContent(content);
        if (!(file as any).path) {
          setWinscpIsPath(false);
        }
        setWinscpError(null);
      }
    };
    reader.readAsText(file);
  };

  const handleWinscpPreview = async () => {
    setWinscpError(null);
    setWinscpSuccess(null);
    setWinscpCompletedMetrics(null);
    setIsWinscpLoading(true);
    setWinscpProgressStage('reading');
    setWinscpStatusMessage('Analisando arquivo do WinSCP e desofuscando senhas...');
    try {
      const res = await invoke<WinScpImportResult>('preview_winscp_ini', {
        pathOrContent: winscpIsPath ? winscpFilePath.trim() : winscpContent,
        isPath: winscpIsPath,
      });
      setWinscpPreview(res);
      setWinscpProgressStage('idle');
      setTimeout(() => {
        winscpActionAreaRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 150);
    } catch (err: any) {
      setWinscpError(`Falha ao ler arquivo do WinSCP: ${err}`);
      setWinscpPreview(null);
      setWinscpProgressStage('idle');
    } finally {
      setIsWinscpLoading(false);
      setWinscpStatusMessage('');
    }
  };

  const handleWinscpImport = async () => {
    setWinscpError(null);
    setWinscpSuccess(null);
    setWinscpCompletedMetrics(null);
    setIsWinscpLoading(true);
    setWinscpProgressStage('reading');
    setWinscpStatusMessage('Iniciando importação e estruturação das conexões...');

    setTimeout(() => {
      winscpActionAreaRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }, 50);

    try {
      setWinscpProgressStage('decrypting');
      setWinscpStatusMessage('Descriptografando senhas, convertendo pastas e chaves SSH (.ppk)...');

      const updatedSites = await invoke<ConnectionConfig[]>('import_winscp_ini', {
        pathOrContent: winscpIsPath ? winscpFilePath.trim() : winscpContent,
        isPath: winscpIsPath,
        mergeMode: winscpMergeMode,
      });

      setWinscpProgressStage('saving');
      setWinscpStatusMessage('Gravando no cofre local criptografado com AES-256-GCM...');

      onSitesUpdated(updatedSites);

      const totalCount = winscpPreview?.total_sessions ?? Math.max(0, updatedSites.length - 1);
      const foldersCount = winscpPreview?.folders.length ?? 0;
      const passwordsCount = winscpPreview?.decrypted_passwords ?? 0;
      const keysCount = winscpPreview?.key_auth_sessions ?? 0;

      setWinscpCompletedMetrics({
        total: totalCount,
        folders: foldersCount,
        passwords: passwordsCount,
        keys: keysCount,
        mode: winscpMergeMode,
      });

      setWinscpProgressStage('done');
      setWinscpSuccess(
        `Migração concluída com sucesso! ${totalCount} conexões foram salvas e protegidas no cofre local.`
      );

      setTimeout(() => {
        winscpActionAreaRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
      }, 100);
    } catch (err: any) {
      setWinscpProgressStage('idle');
      setWinscpError(`Erro na importação: ${err}`);
      setTimeout(() => {
        winscpActionAreaRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
      }, 100);
    } finally {
      setIsWinscpLoading(false);
      setWinscpStatusMessage('');
    }
  };

  const filteredPreviewSites = winscpPreview?.sites.filter((s) => {
    if (selectedFolderFilter === 'all') return true;
    if (selectedFolderFilter === 'root') return !s.group;
    return s.group === selectedFolderFilter;
  });

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="bg-white dark:bg-dark-800 border border-slate-300 dark:border-dark-600 rounded-2xl shadow-2xl w-full max-w-3xl flex flex-col overflow-hidden text-slate-900 dark:text-slate-100 my-auto max-h-[90vh]">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 dark:border-dark-700 flex items-center justify-between bg-slate-100 dark:bg-dark-750">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 rounded-xl border border-emerald-500/20">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold tracking-wide text-slate-900 dark:text-white">
                  Cofre Criptografado & Migração
                </h2>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30">
                  AES-256-GCM
                </span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Backup seguro, portabilidade universal e migração fácil do WinSCP
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

        {/* Tab Switcher */}
        <div className="flex border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/40 px-6 gap-1">
          <button
            onClick={() => setActiveTab('winscp')}
            className={`flex items-center gap-2 px-4 py-3 text-xs font-semibold border-b-2 transition-all ${
              activeTab === 'winscp'
                ? 'border-amber-500 text-amber-600 dark:text-amber-400 bg-amber-500/10'
                : 'border-transparent text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
            }`}
          >
            <FolderTree className="w-3.5 h-3.5 text-amber-500" />
            <span>Migrar do WinSCP (.ini)</span>
            <span className="px-1.5 py-0.2 rounded text-[10px] bg-amber-500/20 text-amber-700 dark:text-amber-300 font-mono font-bold">
              1-Clique
            </span>
          </button>
          <button
            onClick={() => setActiveTab('export')}
            className={`flex items-center gap-2 px-4 py-3 text-xs font-semibold border-b-2 transition-all ${
              activeTab === 'export'
                ? 'border-sky-500 text-sky-600 dark:text-sky-400 bg-sky-500/5'
                : 'border-transparent text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
            }`}
          >
            <Download className="w-3.5 h-3.5" />
            <span>Exportar Cofre (.rustscp-vault)</span>
          </button>
          <button
            onClick={() => setActiveTab('import')}
            className={`flex items-center gap-2 px-4 py-3 text-xs font-semibold border-b-2 transition-all ${
              activeTab === 'import'
                ? 'border-emerald-500 text-emerald-600 dark:text-emerald-400 bg-emerald-500/5'
                : 'border-transparent text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
            }`}
          >
            <Upload className="w-3.5 h-3.5" />
            <span>Restaurar Cofre</span>
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-4 overflow-y-auto flex-1">
          {/* TAB 0: WINSCP MIGRATION */}
          {activeTab === 'winscp' && (
            <div className="space-y-4 text-xs">
              <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-xl space-y-1">
                <div className="flex items-center gap-2 font-semibold text-amber-700 dark:text-amber-300">
                  <FolderTree className="w-4 h-4 text-amber-500" />
                  <span>Migração e Importação Direta do WinSCP</span>
                </div>
                <p className="text-slate-600 dark:text-slate-400 text-[11px] leading-relaxed">
                  O RustSCP analisa o arquivo <code className="font-mono bg-amber-500/10 px-1 py-0.5 rounded">WinSCP.ini</code>,
                  preserva toda a <strong>hierarquia e organização de pastas</strong>, recupera <strong>todas as senhas ofuscadas</strong> em
                  texto limpo e remapeia <strong>chaves SSH / certificados (.ppk)</strong> automaticamente, blindando tudo no cofre com AES-256-GCM.
                </p>
              </div>

              {/* Top alert: only show here if preview is not loaded yet (e.g. file error during analyze) */}
              {!winscpPreview && winscpError && (
                <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-xl text-red-600 dark:text-red-400 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span>{winscpError}</span>
                </div>
              )}

              {/* Path or file picker */}
              <div className="space-y-3">
                <div>
                  <label className="block text-slate-700 dark:text-slate-300 font-semibold mb-1">
                    Caminho do arquivo de configuração do WinSCP (.ini):
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={winscpFilePath}
                      onChange={(e) => {
                        setWinscpFilePath(e.target.value);
                        setWinscpIsPath(true);
                      }}
                      placeholder="/Users/usuario/Downloads/WinSCP.ini ou C:\Users\...\WinSCP.ini"
                      className="flex-1 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl px-3 py-2 text-slate-900 dark:text-white font-mono text-[11px] placeholder-slate-400 focus:outline-none focus:border-amber-500 shadow-sm"
                    />
                    <input
                      id={winscpFileInputId}
                      type="file"
                      accept=".ini,text/plain"
                      onChange={handleWinscpFileUpload}
                      className="hidden"
                    />
                    <label
                      htmlFor={winscpFileInputId}
                      className="px-3.5 py-2 bg-slate-100 hover:bg-slate-200 text-slate-800 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-200 border border-slate-300 dark:border-slate-700 rounded-xl font-medium cursor-pointer flex items-center gap-1.5 transition-colors shrink-0 shadow-sm"
                      title="Escolher arquivo .ini"
                    >
                      <FileText className="w-4 h-4 text-amber-500" />
                      <span>Buscar .ini...</span>
                    </label>
                    <button
                      onClick={handleWinscpPreview}
                      disabled={isWinscpLoading || (!winscpFilePath && !winscpContent)}
                      className="px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white rounded-xl font-semibold flex items-center gap-1.5 transition-colors shadow-sm"
                    >
                      {isWinscpLoading ? (
                        <RefreshCw className="w-4 h-4 animate-spin" />
                      ) : (
                        <Filter className="w-4 h-4" />
                      )}
                      <span>Analisar</span>
                    </button>
                  </div>
                </div>

                {/* Preview Cards */}
                {winscpPreview && (
                  <div className="space-y-4 pt-2 animate-in fade-in duration-150">
                    <div className="grid grid-cols-4 gap-2.5">
                      <div className="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                        <span className="text-[10px] text-slate-500 uppercase font-semibold block">Total Conexões</span>
                        <span className="text-lg font-bold text-slate-900 dark:text-slate-100 font-mono">
                          {winscpPreview.total_sessions}
                        </span>
                      </div>
                      <div className="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                        <span className="text-[10px] text-amber-600 dark:text-amber-400 uppercase font-semibold block">Pastas / Grupos</span>
                        <span className="text-lg font-bold text-amber-600 dark:text-amber-400 font-mono">
                          {winscpPreview.folders.length}
                        </span>
                      </div>
                      <div className="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                        <span className="text-[10px] text-emerald-600 dark:text-emerald-400 uppercase font-semibold block">Senhas Decodificadas</span>
                        <span className="text-lg font-bold text-emerald-600 dark:text-emerald-400 font-mono">
                          {winscpPreview.decrypted_passwords}
                        </span>
                      </div>
                      <div className="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                        <span className="text-[10px] text-sky-600 dark:text-sky-400 uppercase font-semibold block">Chaves SSH Mapeadas</span>
                        <span className="text-lg font-bold text-sky-600 dark:text-sky-400 font-mono">
                          {winscpPreview.key_auth_sessions}
                        </span>
                      </div>
                    </div>

                    {/* Filter and Table Preview */}
                    <div className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
                      <div className="px-3 py-2 bg-slate-100 dark:bg-slate-900/80 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                        <span className="font-semibold text-slate-700 dark:text-slate-300 text-[11px] flex items-center gap-1.5">
                          <Server className="w-3.5 h-3.5 text-amber-500" />
                          <span>Pré-visualização das Conexões ({filteredPreviewSites?.length || 0})</span>
                        </span>
                        <div className="flex items-center gap-2">
                          <label className="text-[10px] text-slate-500">Filtrar por Pasta:</label>
                          <select
                            value={selectedFolderFilter}
                            onChange={(e) => setSelectedFolderFilter(e.target.value)}
                            className="bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded px-2 py-0.5 text-[11px] text-slate-800 dark:text-slate-200 focus:outline-none"
                          >
                            <option value="all">Todas as Pastas ({winscpPreview.total_sessions})</option>
                            <option value="root">Sem Pasta / Raiz</option>
                            {winscpPreview.folders.map((f) => (
                              <option key={f} value={f}>
                                📁 {f}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>

                      <div className="max-h-52 overflow-y-auto divide-y divide-slate-200 dark:divide-slate-800">
                        {filteredPreviewSites?.map((site) => (
                          <div
                            key={site.id}
                            className="px-3 py-2 text-[11px] flex items-center justify-between hover:bg-slate-50 dark:hover:bg-slate-900/40"
                          >
                            <div className="flex items-center gap-2 truncate">
                              <span className="font-semibold text-slate-900 dark:text-slate-100 truncate">
                                {site.name}
                              </span>
                              {site.group && (
                                <span className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-400 font-mono text-[9px]">
                                  📁 {site.group}
                                </span>
                              )}
                            </div>

                            <div className="flex items-center gap-3 text-slate-500 dark:text-slate-400 font-mono text-[10px] shrink-0">
                              <span className="uppercase font-semibold text-slate-700 dark:text-slate-300">
                                {site.protocol}
                              </span>
                              <span>
                                {site.username ? `${site.username}@` : ''}
                                {site.host}:{site.port}
                              </span>
                              {site.auth.type === 'Password' ? (
                                <span className="text-emerald-600 dark:text-emerald-400 font-sans text-[10px] flex items-center gap-0.5">
                                  <Lock className="w-3 h-3" />
                                  <span>Senha OK</span>
                                </span>
                              ) : site.auth.type === 'PrivateKey' ? (
                                <span className="text-sky-600 dark:text-sky-400 font-sans text-[10px] flex items-center gap-0.5">
                                  <Key className="w-3 h-3" />
                                  <span>Chave SSH</span>
                                </span>
                              ) : null}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Merge Mode Options */}
                    <div>
                      <label className="block text-slate-700 dark:text-slate-300 font-semibold mb-1">
                        Estratégia de Importação:
                      </label>
                      <div className="grid grid-cols-2 gap-3">
                        <button
                          type="button"
                          onClick={() => setWinscpMergeMode('merge')}
                          className={`p-2.5 rounded-xl border text-left transition-all shadow-sm ${
                            winscpMergeMode === 'merge'
                              ? 'border-amber-500 bg-amber-500/10 text-amber-700 dark:text-amber-300'
                              : 'border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                          }`}
                        >
                          <div className="font-semibold text-xs mb-0.5">⊕ Mesclar Conexões</div>
                          <div className="text-[10px] opacity-80">Mantém conexões existentes e adiciona as novas do WinSCP</div>
                        </button>

                        <button
                          type="button"
                          onClick={() => setWinscpMergeMode('replace')}
                          className={`p-2.5 rounded-xl border text-left transition-all shadow-sm ${
                            winscpMergeMode === 'replace'
                              ? 'border-red-500 bg-red-500/10 text-red-700 dark:text-red-300'
                              : 'border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                          }`}
                        >
                          <div className="font-semibold text-xs mb-0.5">↺ Substituir Todas</div>
                          <div className="text-[10px] opacity-80">Substitui a lista inteira pelas conexões importadas do WinSCP</div>
                        </button>
                      </div>
                    </div>

                    {/* Process Diagnostics & Action Bar */}
                    <div ref={winscpActionAreaRef} className="pt-3 space-y-3 border-t border-slate-200 dark:border-slate-800/80">
                      {/* 1. In-progress diagnostic card */}
                      {isWinscpLoading && (
                        <div className="p-3.5 bg-amber-500/10 border border-amber-500/30 rounded-xl space-y-2 animate-in fade-in duration-200 shadow-sm">
                          <div className="flex items-center justify-between text-amber-700 dark:text-amber-300 font-semibold text-xs">
                            <div className="flex items-center gap-2">
                              <RefreshCw className="w-4 h-4 animate-spin text-amber-600 dark:text-amber-400 shrink-0" />
                              <span>Processando migração do WinSCP...</span>
                            </div>
                            <span className="text-[10px] font-mono uppercase tracking-wider bg-amber-500/20 text-amber-700 dark:text-amber-300 px-2 py-0.5 rounded-full font-semibold">
                              {winscpProgressStage === 'decrypting' ? 'Etapa 2/3: Cifras & Pastas' : winscpProgressStage === 'saving' ? 'Etapa 3/3: Cofre AES' : 'Etapa 1/3: Leitura'}
                            </span>
                          </div>

                          <div className="text-[11px] text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
                            <Sparkles className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                            <span>{winscpStatusMessage || 'Aguarde um momento enquanto os dados são estruturados...'}</span>
                          </div>

                          {/* Progress bar */}
                          <div className="w-full bg-slate-200 dark:bg-slate-800 rounded-full h-1.5 overflow-hidden">
                            <div className="bg-amber-500 h-1.5 rounded-full animate-pulse w-full"></div>
                          </div>
                        </div>
                      )}

                      {/* 2. Success diagnostic card directly above/next to the button */}
                      {winscpCompletedMetrics && (
                        <div className="p-4 bg-emerald-500/10 border border-emerald-500/30 rounded-xl space-y-3 animate-in fade-in duration-200 shadow-sm">
                          <div className="flex items-start justify-between">
                            <div className="flex items-center gap-2.5 text-emerald-700 dark:text-emerald-300 font-bold text-sm">
                              <div className="p-1.5 bg-emerald-500/20 rounded-lg">
                                <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
                              </div>
                              <div>
                                <div>Migração Concluída com Sucesso!</div>
                                <div className="text-[11px] font-normal text-slate-600 dark:text-slate-400">
                                  {winscpSuccess || 'Todas as conexões foram processadas e criptografadas no cofre local.'}
                                </div>
                              </div>
                            </div>
                            <span className="text-[10px] font-mono px-2 py-0.5 bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 rounded font-semibold uppercase">
                              Cofre Atualizado
                            </span>
                          </div>

                          {/* Diagnostic metric pills */}
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1">
                            <div className="p-2 rounded-lg bg-white/70 dark:bg-slate-900/60 border border-emerald-500/20 text-center">
                              <div className="text-base font-bold text-slate-900 dark:text-slate-100 font-mono">
                                {winscpCompletedMetrics.total}
                              </div>
                              <div className="text-[10px] text-slate-500">Conexões Salvas</div>
                            </div>
                            <div className="p-2 rounded-lg bg-white/70 dark:bg-slate-900/60 border border-emerald-500/20 text-center">
                              <div className="text-base font-bold text-amber-600 dark:text-amber-400 font-mono">
                                {winscpCompletedMetrics.folders}
                              </div>
                              <div className="text-[10px] text-slate-500">Pastas / Grupos</div>
                            </div>
                            <div className="p-2 rounded-lg bg-white/70 dark:bg-slate-900/60 border border-emerald-500/20 text-center">
                              <div className="text-base font-bold text-emerald-600 dark:text-emerald-400 font-mono">
                                {winscpCompletedMetrics.passwords}
                              </div>
                              <div className="text-[10px] text-slate-500">Senhas Decodificadas</div>
                            </div>
                            <div className="p-2 rounded-lg bg-white/70 dark:bg-slate-900/60 border border-emerald-500/20 text-center">
                              <div className="text-base font-bold text-sky-600 dark:text-sky-400 font-mono">
                                {winscpCompletedMetrics.keys}
                              </div>
                              <div className="text-[10px] text-slate-500">Chaves SSH Mapeadas</div>
                            </div>
                          </div>

                          <div className="flex items-center justify-between pt-1 text-[11px] text-slate-600 dark:text-slate-400">
                            <span className="flex items-center gap-1">
                              <Lock className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                              <span>Blindagem criptográfica: AES-256-GCM + PBKDF2</span>
                            </span>
                            <span className="font-mono text-[10px]">
                              Modo: {winscpCompletedMetrics.mode === 'merge' ? 'Mesclar (+ existentes)' : 'Substituição total'}
                            </span>
                          </div>
                        </div>
                      )}

                      {/* 3. Error diagnostic card */}
                      {winscpError && (
                        <div className="p-3.5 bg-red-500/10 border border-red-500/30 rounded-xl text-red-600 dark:text-red-400 space-y-1 animate-in fade-in duration-200">
                          <div className="flex items-center gap-2 font-semibold">
                            <AlertTriangle className="w-4 h-4 shrink-0" />
                            <span>Erro no processo de importação</span>
                          </div>
                          <div className="text-[11px] pl-6">{winscpError}</div>
                        </div>
                      )}

                      {/* 4. Action Buttons */}
                      <div className="flex items-center justify-between pt-1 gap-3">
                        <div className="text-[11px] text-slate-500 dark:text-slate-400">
                          {winscpCompletedMetrics ? (
                            <span className="text-emerald-600 dark:text-emerald-400 font-medium flex items-center gap-1.5">
                              <Check className="w-4 h-4 shrink-0" />
                              <span>Conexões prontas para uso! Clique no botão ao lado para voltar às conexões.</span>
                            </span>
                          ) : (
                            <span>{winscpPreview.total_sessions} conexões identificadas para migração</span>
                          )}
                        </div>

                        <div className="flex items-center gap-2.5 shrink-0">
                          {winscpCompletedMetrics ? (
                            <>
                              <button
                                type="button"
                                onClick={handleWinscpImport}
                                disabled={isWinscpLoading}
                                className="px-3 py-2.5 bg-slate-200 hover:bg-slate-300 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 rounded-xl text-xs font-semibold transition-colors"
                              >
                                Reimportar
                              </button>
                              <button
                                type="button"
                                onClick={onClose}
                                className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl font-bold flex items-center gap-2 shadow-lg transition-all text-xs"
                              >
                                <span>Ver Conexões no RustSCP</span>
                                <ArrowRight className="w-4 h-4" />
                              </button>
                            </>
                          ) : (
                            <button
                              onClick={handleWinscpImport}
                              disabled={isWinscpLoading}
                              className="px-5 py-2.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white rounded-xl font-bold flex items-center gap-2 shadow-lg transition-all text-xs"
                            >
                              {isWinscpLoading ? (
                                <RefreshCw className="w-4 h-4 animate-spin" />
                              ) : (
                                <CheckCircle2 className="w-4 h-4" />
                              )}
                              <span>Importar {winscpPreview.total_sessions} Conexões para o RustSCP</span>
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 1: EXPORT */}
          {activeTab === 'export' && (
            <div className="space-y-4 text-xs">
              <div className="p-3 bg-sky-500/10 border border-sky-500/20 rounded-xl space-y-1">
                <div className="flex items-center gap-2 font-semibold text-sky-700 dark:text-sky-300">
                  <Lock className="w-4 h-4" />
                  <span>Proteção Criptográfica Autenticada</span>
                </div>
                <p className="text-slate-600 dark:text-slate-400 text-[11px] leading-relaxed">
                  Todas as {siteCount} conexão(ões) (incluindo senhas, chaves SSH, hosts, IPs e certificados) serão
                  cifradas usando chave de 256 bits derivada por PBKDF2-HMAC-SHA256 (100.000 iterações).
                  O arquivo gerado é 100% universal e seguro para armazenar na nuvem ou transferir entre computadores.
                </p>
              </div>

              {exportError && (
                <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-xl text-red-600 dark:text-red-400 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span>{exportError}</span>
                </div>
              )}

              {!exportedJson ? (
                <div className="space-y-3">
                  <div>
                    <label className="block text-slate-700 dark:text-slate-300 font-semibold mb-1">
                      Defina a Senha de Criptografia do Cofre:
                    </label>
                    <div className="relative">
                      <input
                        type={showExportPassword ? 'text' : 'password'}
                        value={exportPassword}
                        onChange={(e) => setExportPassword(e.target.value)}
                        placeholder="Digite uma senha forte para cifrar o cofre"
                        className="w-full bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl px-3 py-2 text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:border-sky-500 pr-9 shadow-sm"
                      />
                      <button
                        type="button"
                        onClick={() => setShowExportPassword(!showExportPassword)}
                        className="absolute right-2.5 top-2.5 text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300"
                      >
                        {showExportPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="block text-slate-700 dark:text-slate-300 font-semibold mb-1">Confirme a Senha:</label>
                    <input
                      type={showExportPassword ? 'text' : 'password'}
                      value={exportPasswordConfirm}
                      onChange={(e) => setExportPasswordConfirm(e.target.value)}
                      placeholder="Repita a senha"
                      className="w-full bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl px-3 py-2 text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:border-sky-500 shadow-sm"
                    />
                  </div>

                  <div className="pt-2 flex justify-end">
                    <button
                      onClick={handleExport}
                      disabled={isExporting || siteCount === 0}
                      className="px-4 py-2.5 bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white rounded-xl font-semibold flex items-center gap-2 shadow-sm transition-colors"
                    >
                      {isExporting ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Lock className="w-4 h-4" />}
                      <span>Criptografar e Gerar Cofre</span>
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-xl space-y-1 text-emerald-700 dark:text-emerald-300">
                    <div className="flex items-center gap-2 font-semibold">
                      <Check className="w-4 h-4" />
                      <span>Cofre Criptografado com Sucesso!</span>
                    </div>
                    <p className="text-slate-600 dark:text-slate-400 text-[11px]">
                      O cofre está protegido pela senha escolhida. Baixe o arquivo universal ou copie o conteúdo para importá-lo em qualquer máquina.
                    </p>
                  </div>

                  <div className="flex gap-2">
                    <button
                      onClick={handleDownloadVaultFile}
                      className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl font-semibold flex items-center justify-center gap-2 shadow-sm transition-colors"
                    >
                      <Download className="w-4 h-4" />
                      <span>Salvar Arquivo .rustscp-vault</span>
                    </button>

                    <button
                      onClick={handleCopyExportJson}
                      className="px-4 py-2.5 bg-slate-200 hover:bg-slate-300 text-slate-800 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-200 border border-slate-300 dark:border-slate-700 rounded-xl font-medium flex items-center gap-2 transition-colors shadow-sm"
                    >
                      {copiedExport ? <Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400" /> : <Copy className="w-4 h-4" />}
                      <span>{copiedExport ? 'Copiado!' : 'Copiar Texto Cifrado'}</span>
                    </button>
                  </div>

                  <button
                    onClick={() => {
                      setExportedJson(null);
                      setExportPassword('');
                      setExportPasswordConfirm('');
                    }}
                    className="text-xs text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 underline pt-1 block"
                  >
                    Gerar nova exportação com outra senha
                  </button>
                </div>
              )}
            </div>
          )}

          {/* TAB 2: RESTORE VAULT */}
          {activeTab === 'import' && (
            <div className="space-y-4 text-xs">
              <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-xl space-y-1">
                <div className="flex items-center gap-2 font-semibold text-emerald-700 dark:text-emerald-300">
                  <Database className="w-4 h-4" />
                  <span>Restauração & Importação Multiplataforma</span>
                </div>
                <p className="text-slate-600 dark:text-slate-400 text-[11px] leading-relaxed">
                  Importe cofres gerados em qualquer versão do RustSCP no macOS, Windows ou Linux. O arquivo será
                  validado com a Auth Tag criptográfica e decodificado apenas com a senha correta.
                </p>
              </div>

              {importError && (
                <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-xl text-red-600 dark:text-red-400 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span>{importError}</span>
                </div>
              )}

              {importSuccess && (
                <div className="p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-xl text-emerald-700 dark:text-emerald-300 flex items-center gap-2">
                  <Check className="w-4 h-4 shrink-0" />
                  <span>{importSuccess}</span>
                </div>
              )}

              <div className="space-y-3">
                {/* File Uploader */}
                <div>
                  <label className="block text-slate-700 dark:text-slate-300 font-semibold mb-1">
                    Selecione o Arquivo .rustscp-vault ou .json:
                  </label>
                  <div className="flex gap-2">
                    <input
                      id={fileInputId}
                      type="file"
                      accept=".rustscp-vault,.json,application/json"
                      onChange={handleFileUpload}
                      className="hidden"
                    />
                    <label
                      htmlFor={fileInputId}
                      className="px-4 py-2 bg-slate-200 hover:bg-slate-300 text-slate-800 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-200 border border-slate-300 dark:border-slate-700 rounded-xl font-medium cursor-pointer flex items-center gap-2 transition-colors shrink-0 shadow-sm"
                    >
                      <FileText className="w-4 h-4 text-sky-500 dark:text-sky-400" />
                      <span>Escolher Arquivo...</span>
                    </label>
                    <span className="text-slate-500 dark:text-slate-400 self-center truncate text-[11px]">
                      {importJson ? `Arquivo carregado (${importJson.length} bytes)` : 'Nenhum arquivo selecionado'}
                    </span>
                  </div>
                </div>

                {/* Or Paste JSON */}
                <div>
                  <label className="block text-slate-700 dark:text-slate-300 font-semibold mb-1">
                    Ou Cole o Texto Cifrado do Cofre:
                  </label>
                  <textarea
                    rows={3}
                    value={importJson}
                    onChange={(e) => setImportJson(e.target.value)}
                    placeholder='{"magic":"RUSTSCP_VAULT","version":1,"ciphertext_hex":"..."}'
                    className="w-full bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl p-2.5 font-mono text-[11px] text-slate-900 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-600 focus:outline-none focus:border-emerald-500 shadow-sm"
                  />
                </div>

                {/* Password */}
                <div>
                  <label className="block text-slate-700 dark:text-slate-300 font-semibold mb-1">Senha de Descriptografia:</label>
                  <div className="relative">
                    <input
                      type={showImportPassword ? 'text' : 'password'}
                      value={importPassword}
                      onChange={(e) => setImportPassword(e.target.value)}
                      placeholder="Senha com a qual o cofre foi exportado"
                      className="w-full bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-xl px-3 py-2 text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:border-emerald-500 pr-9 shadow-sm"
                    />
                    <button
                      type="button"
                      onClick={() => setShowImportPassword(!showImportPassword)}
                      className="absolute right-2.5 top-2.5 text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300"
                    >
                      {showImportPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                {/* Merge Mode */}
                <div>
                  <label className="block text-slate-700 dark:text-slate-300 font-semibold mb-1">Modo de Importação:</label>
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() => setMergeMode('merge')}
                      className={`p-2.5 rounded-xl border text-left transition-all shadow-sm ${
                        mergeMode === 'merge'
                          ? 'border-emerald-500 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                          : 'border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                      }`}
                    >
                      <div className="font-semibold text-xs mb-0.5">⊕ Mesclar Conexões</div>
                      <div className="text-[10px] opacity-80">Preserva conexões locais existentes e adiciona as novas</div>
                    </button>

                    <button
                      type="button"
                      onClick={() => setMergeMode('replace')}
                      className={`p-2.5 rounded-xl border text-left transition-all shadow-sm ${
                        mergeMode === 'replace'
                          ? 'border-amber-500 bg-amber-500/10 text-amber-700 dark:text-amber-300'
                          : 'border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                      }`}
                    >
                      <div className="font-semibold text-xs mb-0.5">↺ Substituir Todas</div>
                      <div className="text-[10px] opacity-80">Substitui a lista de sites pelas do cofre importado</div>
                    </button>
                  </div>
                </div>

                <div className="pt-2 flex justify-end">
                  <button
                    onClick={handleImport}
                    disabled={isImporting || !importJson || !importPassword}
                    className="px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-xl font-semibold flex items-center gap-2 shadow-sm transition-colors"
                  >
                    {isImporting ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Key className="w-4 h-4" />}
                    <span>Descriptografar e Importar</span>
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-950/70 flex items-center justify-between text-xs text-slate-600 dark:text-slate-400">
          <span className="font-mono text-[11px] flex items-center gap-1.5 text-slate-600 dark:text-slate-400">
            <Lock className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
            <span>NIST SP 800-38D / RFC 8018 Compliant</span>
          </span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-200 rounded-lg transition-colors border border-slate-300 dark:border-slate-700 font-medium shadow-sm"
          >
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
};
