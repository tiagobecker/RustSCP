import React, { useState, useRef } from 'react';
import { 
  X, 
  Server, 
  Cloud, 
  Lock, 
  FolderPlus, 
  Trash2, 
  Eye, 
  EyeOff, 
  Check,
  HardDrive,
  ShieldCheck,
  Download,
  Upload,
  Pencil,
  Save,
  Plus,
  FolderOpen,
  XCircle,
} from 'lucide-react';
import { ConnectionConfig, Protocol } from '../types.ts';
import { VaultModal } from './VaultModal.tsx';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';

interface LoginDialogProps {
  isOpen: boolean;
  onClose: () => void;
  savedSites: ConnectionConfig[];
  onConnect: (config: ConnectionConfig) => Promise<void>;
  onSaveSite: (config: ConnectionConfig) => Promise<void>;
  onDeleteSite: (id: string) => Promise<void>;
  onSitesUpdated?: (sites: ConnectionConfig[]) => void;
}

export const LoginDialog: React.FC<LoginDialogProps> = ({
  isOpen,
  onClose,
  savedSites,
  onConnect,
  onSaveSite,
  onDeleteSite,
  onSitesUpdated,
}) => {
  const { t } = useTranslation();
  const [isVaultModalOpen, setIsVaultModalOpen] = useState(false);

  const [selectedSiteId, setSelectedSiteId] = useState<string>('new');
  const [protocol, setProtocol] = useState<Protocol>('sftp');
  const [siteName, setSiteName] = useState<string>('My Server');
  const [host, setHost] = useState<string>('');
  const [port, setPort] = useState<number>(22);
  const [username, setUsername] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [privateKeyPath, setPrivateKeyPath] = useState<string>('');
  const [remoteRoot, setRemoteRoot] = useState<string>('/');
  const [showPassword, setShowPassword] = useState<boolean>(false);
  const [isConnecting, setIsConnecting] = useState<boolean>(false);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [saveSuccess, setSaveSuccess] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string>('');

  const connectAttemptIdRef = useRef<number>(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!isOpen) return null;

  const handleProtocolChange = (p: Protocol) => {
    setProtocol(p);
    if (p === 'sftp' || p === 'scp') setPort(22);
    else if (p === 'ftp') setPort(21);
    else if (p === 's3') setPort(443);
  };

  const handleSelectSite = (site: ConnectionConfig) => {
    setSelectedSiteId(site.id);
    setSiteName(site.name);
    setProtocol(site.protocol);
    setHost(site.host);
    setPort(site.port);
    setUsername(site.username);
    setRemoteRoot(site.remote_root);
    if (site.auth.type === 'Password') {
      setPassword(site.auth.value);
      setPrivateKeyPath('');
    } else if (site.auth.type === 'PrivateKey') {
      setPrivateKeyPath(site.auth.value.path || '');
      setPassword('');
    }
  };

  const handleNewSite = () => {
    setSelectedSiteId('new');
    setSiteName('Nova Conexão');
    setProtocol('sftp');
    setHost('');
    setPort(22);
    setUsername('');
    setPassword('');
    setPrivateKeyPath('');
    setRemoteRoot('');
  };

  const buildConfig = (): ConnectionConfig => {
    return {
      id: selectedSiteId === 'new' ? `site-${Date.now()}` : selectedSiteId,
      name: siteName || (host ? `${protocol.toUpperCase()} - ${host}` : 'New Site'),
      protocol,
      host: host.trim(),
      port,
      username: username.trim(),
      auth: privateKeyPath.trim()
        ? { type: 'PrivateKey', value: { path: privateKeyPath.trim() } }
        : password
        ? { type: 'Password', value: password }
        : { type: 'None', value: '' },
      remote_root: remoteRoot.trim(),
    };
  };

  const handleConnect = async () => {
    setErrorMessage('');
    if (!host && protocol !== 'local') {
      setErrorMessage('Por favor, informe o endereço do Host ou Endpoint.');
      return;
    }
    const currentAttempt = ++connectAttemptIdRef.current;
    setIsConnecting(true);
    try {
      const cfg = buildConfig();
      await onConnect(cfg);
      if (connectAttemptIdRef.current === currentAttempt) {
        onClose();
      }
    } catch (err: any) {
      if (connectAttemptIdRef.current === currentAttempt) {
        setErrorMessage(err.toString());
      }
    } finally {
      if (connectAttemptIdRef.current === currentAttempt) {
        setIsConnecting(false);
      }
    }
  };

  const handleCancelConnect = () => {
    connectAttemptIdRef.current++;
    setIsConnecting(false);
    setErrorMessage('Tentativa de conexão cancelada pelo usuário. Você pode corrigir a porta, host ou credenciais e tentar novamente.');
  };

  const handleClose = () => {
    if (isConnecting) {
      handleCancelConnect();
    }
    onClose();
  };

  const handleSave = async () => {
    setErrorMessage('');
    if (!host && protocol !== 'local') {
      setErrorMessage('Por favor, informe o endereço do Host ou Endpoint antes de salvar.');
      return;
    }
    setIsSaving(true);
    try {
      const cfg = buildConfig();
      await onSaveSite(cfg);
      setSelectedSiteId(cfg.id);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2500);
    } catch (err: any) {
      setErrorMessage(err.toString());
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    await onDeleteSite(id);
    if (selectedSiteId === id) {
      handleNewSite();
    }
  };

  const handlePickPrivateKey = async () => {
    try {
      const selected = await invoke<string | null>('pick_key_file');
      if (selected) {
        setPrivateKeyPath(selected);
      }
    } catch (err) {
      console.warn('Native picker failed or not in Tauri environment:', err);
      fileInputRef.current?.click();
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 animate-in fade-in duration-150">
      <div className="bg-white dark:bg-dark-800 border border-slate-300 dark:border-dark-600 rounded-xl max-w-4xl w-full shadow-2xl flex flex-col h-[580px] overflow-hidden">
        {/* Title Bar */}
        <div className="px-5 py-3 border-b border-slate-200 dark:border-dark-700 flex items-center justify-between bg-slate-100 dark:bg-dark-750 select-none">
          <div className="flex items-center space-x-2.5">
            <img src="/icon.png" alt="RustSCP" className="w-5 h-5 object-contain" />
            <h3 className="font-bold text-slate-900 dark:text-slate-100 text-sm">
              {t('loginDialog.title')} / {t('loginDialog.connect')}
            </h3>
          </div>
          <button 
            type="button"
            onClick={handleClose} 
            className="text-slate-500 hover:text-slate-950 dark:text-slate-400 dark:hover:text-white p-1 rounded-md hover:bg-slate-200 dark:hover:bg-dark-700 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Dialog Body */}
        <div className="flex flex-1 overflow-hidden">
          {/* Left: Saved Sites Tree */}
          <div className="w-64 bg-slate-50 dark:bg-dark-900 border-r border-slate-200 dark:border-dark-700 flex flex-col p-3 select-none">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-bold text-slate-700 dark:text-slate-400 uppercase tracking-wider">
                {t('loginDialog.savedSites')}
              </span>
              <button
                type="button"
                onClick={handleNewSite}
                title={t('loginDialog.newConnection')}
                className="flex items-center space-x-1 px-2 py-0.5 rounded bg-rust-500/15 text-rust-700 dark:text-rust-400 hover:bg-rust-500/25 border border-rust-500/30 text-xs font-semibold transition-colors"
              >
                <FolderPlus className="w-3 h-3" />
                <span>{t('loginDialog.newConnection')}</span>
              </button>
            </div>

            <div className="flex-1 overflow-y-auto space-y-1">
              <button
                type="button"
                onClick={handleNewSite}
                className={`w-full text-left px-2.5 py-1.5 rounded text-xs flex items-center space-x-2 transition-colors ${
                  selectedSiteId === 'new'
                    ? 'bg-rust-600 text-white font-semibold shadow-sm'
                    : 'text-slate-700 dark:text-slate-300 hover:bg-slate-200/80 dark:hover:bg-dark-800 hover:text-slate-950 dark:hover:text-white'
                }`}
              >
                <Server className="w-3.5 h-3.5" />
                <span>[ {t('loginDialog.newConnection')} ]</span>
              </button>

              {savedSites.map((site) => (
                <div
                  key={site.id}
                  onClick={() => handleSelectSite(site)}
                  className={`group flex items-center justify-between px-2.5 py-1.5 rounded text-xs cursor-pointer transition-colors ${
                    selectedSiteId === site.id
                      ? 'bg-rust-500/15 text-rust-700 dark:text-rust-300 border border-rust-500/40 font-semibold'
                      : 'text-slate-700 dark:text-slate-300 hover:bg-slate-200/80 dark:hover:bg-dark-800 hover:text-slate-950 dark:hover:text-white'
                  }`}
                >
                  <div className="flex items-center space-x-2 truncate">
                    {site.protocol === 's3' ? (
                      <Cloud className="w-3.5 h-3.5 text-amber-500 dark:text-amber-400 shrink-0" />
                    ) : site.protocol === 'local' ? (
                      <HardDrive className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                    ) : (
                      <Lock className="w-3.5 h-3.5 text-rust-600 dark:text-rust-500 shrink-0" />
                    )}
                    <span className="truncate">{site.name}</span>
                  </div>

                  {site.id !== 'local' && (
                    <div className="flex items-center space-x-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleSelectSite(site);
                        }}
                        title={t('loginDialog.editMode')}
                        className="p-1 hover:text-sky-600 dark:hover:text-sky-400 text-slate-500 dark:text-slate-400 rounded hover:bg-slate-200 dark:hover:bg-dark-700"
                      >
                        <Pencil className="w-3 h-3" />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDelete(site.id);
                        }}
                        title={t('dualPane.delete')}
                        className="p-1 hover:text-rose-600 dark:hover:text-rose-400 text-slate-500 dark:text-slate-400 rounded hover:bg-slate-200 dark:hover:bg-dark-700"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Vault & Portability Actions */}
            <div className="pt-2.5 mt-2 border-t border-slate-200 dark:border-dark-700/80 space-y-1.5 shrink-0">
              <div className="flex items-center justify-between px-1 text-[10px] text-emerald-700 dark:text-emerald-400 font-mono">
                <span className="flex items-center gap-1">
                  <ShieldCheck className="w-3 h-3" />
                  <span>{t('loginDialog.vaultBadge')}</span>
                </span>
                <span className="text-slate-500 text-[9px]">Universal</span>
              </div>

              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  onClick={() => setIsVaultModalOpen(true)}
                  className="flex items-center justify-center gap-1 px-2 py-1.5 rounded bg-white hover:bg-slate-100 dark:bg-dark-800 dark:hover:bg-dark-700 text-slate-800 dark:text-slate-300 hover:text-slate-950 dark:hover:text-white text-[11px] font-medium border border-slate-200 dark:border-dark-600 transition-colors shadow-sm"
                  title="Exportar conexões cifradas para Mac, Windows e Linux"
                >
                  <Download className="w-3 h-3 text-sky-600 dark:text-sky-400" />
                  <span>{t('loginDialog.exportVault')}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setIsVaultModalOpen(true)}
                  className="flex items-center justify-center gap-1 px-2 py-1.5 rounded bg-white hover:bg-slate-100 dark:bg-dark-800 dark:hover:bg-dark-700 text-slate-800 dark:text-slate-300 hover:text-slate-950 dark:hover:text-white text-[11px] font-medium border border-slate-200 dark:border-dark-600 transition-colors shadow-sm"
                  title="Importar arquivo de cofre .rustscp-vault"
                >
                  <Upload className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
                  <span>{t('loginDialog.importVault')}</span>
                </button>
              </div>
            </div>
          </div>

          {/* Right: Connection Properties Form */}
          <div className="flex-1 p-5 overflow-y-auto space-y-4 bg-white dark:bg-dark-850">
            {/* Header: Modo Edição ou Nova Conexão */}
            <div className="flex items-center justify-between pb-3 border-b border-slate-200 dark:border-dark-700">
              <div className="flex items-center space-x-2">
                {selectedSiteId !== 'new' ? (
                  <div className="flex items-center space-x-2">
                    <span className="flex items-center gap-1 px-2.5 py-1 rounded bg-amber-500/15 text-amber-800 dark:text-amber-400 border border-amber-500/30 text-xs font-semibold">
                      <Pencil className="w-3.5 h-3.5" />
                      {t('loginDialog.editMode')}
                    </span>
                    <span className="text-xs text-slate-900 dark:text-slate-200 font-semibold truncate max-w-[220px]">
                      {siteName || t('loginDialog.newConnection')}
                    </span>
                  </div>
                ) : (
                  <span className="flex items-center gap-1 px-2.5 py-1 rounded bg-sky-500/15 text-sky-800 dark:text-sky-400 border border-sky-500/30 text-xs font-semibold">
                    <Plus className="w-3.5 h-3.5" />
                    {t('loginDialog.newConnection')}
                  </span>
                )}
              </div>

              {selectedSiteId !== 'new' && (
                <button
                  type="button"
                  onClick={handleNewSite}
                  className="text-xs text-slate-600 dark:text-slate-400 hover:text-slate-950 dark:hover:text-white flex items-center space-x-1 px-2.5 py-1 rounded bg-slate-100 hover:bg-slate-200 dark:bg-dark-700/70 dark:hover:bg-dark-700 border border-slate-200 dark:border-dark-600 transition-colors shadow-sm"
                  title="Limpar formulário e criar uma nova conexão"
                >
                  <Plus className="w-3.5 h-3.5 text-rust-600 dark:text-rust-400" />
                  <span>{t('loginDialog.newConnection')}</span>
                </button>
              )}
            </div>

            {errorMessage && (
              <div className="p-3 bg-rose-500/15 border border-rose-500/30 rounded-lg text-rose-700 dark:text-rose-300 text-xs font-medium flex items-start gap-2">
                <XCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-600 dark:text-rose-400" />
                <span className="flex-1">{errorMessage}</span>
              </div>
            )}

            {/* Site Name & Protocol */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  {t('loginDialog.siteName')}
                </label>
                <input
                  type="text"
                  value={siteName}
                  onChange={(e) => setSiteName(e.target.value)}
                  placeholder="Ex: Hetzner Production VPS"
                  className="w-full bg-slate-50/50 dark:bg-dark-900 border border-slate-300 dark:border-dark-600 rounded px-2.5 py-1.5 text-xs text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 shadow-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  {t('loginDialog.protocol')}
                </label>
                <select
                  value={protocol}
                  onChange={(e) => handleProtocolChange(e.target.value as Protocol)}
                  className="w-full bg-slate-50/50 dark:bg-dark-900 border border-slate-300 dark:border-dark-600 rounded px-2.5 py-1.5 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 shadow-sm"
                >
                  <option value="sftp">SFTP - SSH File Transfer Protocol</option>
                  <option value="scp">SCP - Secure Copy Protocol</option>
                  <option value="s3">Amazon S3 / Cloudflare R2 / MinIO</option>
                  <option value="ftp">FTP - File Transfer Protocol</option>
                  <option value="local">Local Filesystem</option>
                </select>
              </div>
            </div>

            {/* Host & Port */}
            <div className="grid grid-cols-4 gap-4">
              <div className="col-span-3">
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  {protocol === 's3' ? 'S3 Endpoint URL / Host' : t('loginDialog.host')}
                </label>
                <input
                  type="text"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder={
                    protocol === 's3'
                      ? 'https://s3.amazonaws.com ou https://<account>.r2.cloudflarestorage.com'
                      : 'vps.servidor.com ou 192.168.1.100'
                  }
                  className="w-full bg-slate-50/50 dark:bg-dark-900 border border-slate-300 dark:border-dark-600 rounded px-2.5 py-1.5 text-xs font-mono text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 shadow-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">{t('loginDialog.port')}</label>
                <input
                  type="number"
                  value={port}
                  onChange={(e) => setPort(parseInt(e.target.value) || 22)}
                  className="w-full bg-slate-50/50 dark:bg-dark-900 border border-slate-300 dark:border-dark-600 rounded px-2.5 py-1.5 text-xs font-mono text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 shadow-sm"
                />
              </div>
            </div>

            {/* User & Password / Secret */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  {protocol === 's3' ? 'Access Key ID' : t('loginDialog.username')}
                </label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder={protocol === 's3' ? 'AKIAIOSFODNN7EXAMPLE' : 'root ou ubuntu'}
                  className="w-full bg-slate-50/50 dark:bg-dark-900 border border-slate-300 dark:border-dark-600 rounded px-2.5 py-1.5 text-xs font-mono text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 shadow-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  {protocol === 's3' ? 'Secret Access Key' : t('loginDialog.password')}
                </label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••••••"
                    className="w-full bg-slate-50/50 dark:bg-dark-900 border border-slate-300 dark:border-dark-600 rounded px-2.5 py-1.5 text-xs font-mono text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 shadow-sm pr-8"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-2 top-2 text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200"
                  >
                    {showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>
            </div>

            {/* Private Key & Remote Directory */}
            {protocol !== 's3' && (
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                    {t('loginDialog.privateKey')}
                  </label>
                  <div className="flex items-center space-x-2">
                    <input
                      type="text"
                      value={privateKeyPath}
                      onChange={(e) => setPrivateKeyPath(e.target.value)}
                      placeholder="~/.ssh/id_ed25519 ou /path/to/key.pem"
                      className="flex-1 bg-slate-50/50 dark:bg-dark-900 border border-slate-300 dark:border-dark-600 rounded px-2.5 py-1.5 text-xs font-mono text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 shadow-sm"
                    />
                    <button
                      type="button"
                      onClick={handlePickPrivateKey}
                      className="px-3 py-1.5 rounded bg-slate-100 hover:bg-slate-200 dark:bg-dark-700 dark:hover:bg-dark-650 text-slate-700 dark:text-slate-300 hover:text-slate-950 dark:hover:text-white text-xs font-medium border border-slate-300 dark:border-dark-600 flex items-center space-x-1.5 shrink-0 transition-colors shadow-sm"
                      title={t('loginDialog.browseKey')}
                    >
                      <FolderOpen className="w-3.5 h-3.5 text-sky-600 dark:text-sky-400" />
                      <span>{t('loginDialog.browseKey')}</span>
                    </button>
                  </div>
                  <input
                    type="file"
                    ref={fileInputRef}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        setPrivateKeyPath((file as any).path || file.name);
                      }
                    }}
                    className="hidden"
                  />
                  <span className="text-[10px] text-slate-500 dark:text-slate-400 block mt-1">
                    {t('loginDialog.keyFileHelper')}
                  </span>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                    {t('loginDialog.remoteRoot')}
                  </label>
                  <input
                    type="text"
                    value={remoteRoot}
                    onChange={(e) => setRemoteRoot(e.target.value)}
                    placeholder="Padrão do Servidor (Home do Usuário ~)"
                    className="w-full bg-slate-50/50 dark:bg-dark-900 border border-slate-300 dark:border-dark-600 rounded px-2.5 py-1.5 text-xs font-mono text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 shadow-sm"
                  />
                  <span className="text-[10px] text-slate-500 dark:text-slate-400 block mt-1">
                    {t('loginDialog.remoteRootHelper')}
                  </span>
                </div>
              </div>
            )}

            {protocol === 's3' && (
              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  {t('loginDialog.defaultBucket')}
                </label>
                <input
                  type="text"
                  value={remoteRoot}
                  onChange={(e) => setRemoteRoot(e.target.value)}
                  placeholder="meu-bucket ou deixe vazio para listar todos"
                  className="w-full bg-slate-50/50 dark:bg-dark-900 border border-slate-300 dark:border-dark-600 rounded px-2.5 py-1.5 text-xs font-mono text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 shadow-sm"
                />
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-200 dark:border-dark-700 bg-slate-100 dark:bg-dark-750 flex items-center justify-between select-none">
          <div className="flex items-center gap-2.5">
            <div className="flex items-center gap-1.5 px-2.5 py-1 bg-emerald-500/15 border border-emerald-500/30 text-emerald-800 dark:text-emerald-400 rounded-lg text-xs font-mono">
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>{t('loginDialog.vaultBadge')}</span>
            </div>
            {saveSuccess && (
              <span className="text-xs text-emerald-700 dark:text-emerald-400 font-medium flex items-center gap-1">
                <Check className="w-3.5 h-3.5" />
                <span>{t('loginDialog.savedSuccess')}</span>
              </span>
            )}
            {isConnecting && (
              <span className="text-xs text-rust-700 dark:text-rust-400 flex items-center gap-1.5 font-medium animate-pulse">
                <Server className="w-3.5 h-3.5 animate-spin" />
                <span>{t('loginDialog.connecting')} {host || '...'}</span>
              </span>
            )}
          </div>

          <div className="flex items-center space-x-2">
            {isConnecting ? (
              <button
                type="button"
                onClick={handleCancelConnect}
                className="px-4 py-1.5 rounded text-xs font-bold bg-rose-600 hover:bg-rose-500 text-white shadow-lg transition-all flex items-center space-x-1.5 border border-rose-500/40 animate-in fade-in duration-100"
                title={t('loginDialog.cancelConnecting')}
              >
                <XCircle className="w-3.5 h-3.5" />
                <span>{t('loginDialog.cancelConnecting')}</span>
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={handleClose}
                  className="px-3.5 py-1.5 rounded text-xs font-medium text-slate-600 dark:text-slate-400 hover:text-slate-950 dark:hover:text-slate-200 hover:bg-slate-200 dark:hover:bg-dark-700 transition-colors"
                >
                  {t('loginDialog.cancel')}
                </button>
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={isSaving}
                  className="flex items-center space-x-1.5 px-3.5 py-1.5 rounded bg-white hover:bg-slate-50 dark:bg-dark-700 dark:hover:bg-dark-650 text-slate-800 dark:text-slate-200 hover:text-slate-950 dark:hover:text-white text-xs font-semibold border border-slate-300 dark:border-dark-600 transition-colors shadow-sm disabled:opacity-50"
                  title={selectedSiteId !== 'new' ? t('loginDialog.saveChanges') : t('loginDialog.save')}
                >
                  <Save className="w-3.5 h-3.5 text-sky-600 dark:text-sky-400" />
                  <span>{selectedSiteId !== 'new' ? t('loginDialog.saveChanges') : t('loginDialog.save')}</span>
                </button>
                <button
                  type="button"
                  onClick={handleConnect}
                  className="px-5 py-1.5 rounded text-xs font-bold bg-rust-600 hover:bg-rust-500 text-white shadow-lg transition-all flex items-center space-x-1.5 border border-rust-500/40"
                >
                  <Server className="w-3.5 h-3.5" />
                  <span>{t('loginDialog.connect')}</span>
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Vault Modal for Universal Export / Import */}
      {isVaultModalOpen && (
        <VaultModal
          isOpen={isVaultModalOpen}
          onClose={() => setIsVaultModalOpen(false)}
          siteCount={savedSites.filter((s) => s.id !== 'local').length}
          onSitesUpdated={(newSites) => {
            if (onSitesUpdated) onSitesUpdated(newSites);
          }}
        />
      )}
    </div>
  );
};
