import { useState, useId } from 'react';
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
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { ConnectionConfig } from '../types.ts';

interface VaultModalProps {
  isOpen: boolean;
  onClose: () => void;
  siteCount: number;
  onSitesUpdated: (newSites: ConnectionConfig[]) => void;
}

export const VaultModal = ({
  isOpen,
  onClose,
  siteCount,
  onSitesUpdated,
}: VaultModalProps) => {
  const fileInputId = useId();
  const [activeTab, setActiveTab] = useState<'export' | 'import'>('export');

  // --- Export State ---
  const [exportPassword, setExportPassword] = useState('');
  const [exportPasswordConfirm, setExportPasswordConfirm] = useState('');
  const [showExportPassword, setShowExportPassword] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportedJson, setExportedJson] = useState<string | null>(null);
  const [copiedExport, setCopiedExport] = useState(false);

  // --- Import State ---
  const [importJson, setImportJson] = useState('');
  const [importPassword, setImportPassword] = useState('');
  const [showImportPassword, setShowImportPassword] = useState(false);
  const [mergeMode, setMergeMode] = useState<'merge' | 'replace'>('merge');
  const [isImporting, setIsImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);

  if (!isOpen) return null;

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

  // --- Handler: Import ---
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="bg-white dark:bg-dark-800 border border-slate-300 dark:border-dark-600 rounded-2xl shadow-2xl w-full max-w-2xl flex flex-col overflow-hidden text-slate-900 dark:text-slate-100 my-auto">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 dark:border-dark-700 flex items-center justify-between bg-slate-100 dark:bg-dark-750">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 rounded-xl border border-emerald-500/20">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold tracking-wide text-slate-900 dark:text-white">
                  Cofre Criptografado & Portabilidade Universal
                </h2>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30">
                  AES-256-GCM
                </span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Backup e migração segura de credenciais entre macOS, Windows e Linux
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
        <div className="flex border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/40 px-6">
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
            <span>Importar Conexões</span>
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-4">
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

          {/* TAB 2: IMPORT */}
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
