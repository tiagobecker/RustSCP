import React, { useMemo, useRef, useState } from 'react';
import {
  Server,
  Cloud,
  HardDrive,
  Trash2,
  Eye,
  EyeOff,
  Check,
  Plus,
  FolderOpen,
  AlertCircle,
  Search,
  ArrowDownUp,
  KeyRound,
  Loader2,
  X,
} from 'lucide-react';
import { ConnectionConfig, Protocol } from '../types.ts';
import { VaultModal } from './VaultModal.tsx';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { Modal } from './ui/Modal.tsx';
import { Button, Disclosure, Field, Segmented, TextInput } from './ui/controls.tsx';
import { plainTextInputProps } from '../utils/inputHardening.ts';
import { STORED_SECRET, isStoredSecret } from '../utils/secrets.ts';

interface LoginDialogProps {
  isOpen: boolean;
  onClose: () => void;
  savedSites: ConnectionConfig[];
  /** `attempt.cancelled` flips to true if the user stops the attempt; the caller should then drop the session. */
  onConnect: (config: ConnectionConfig, attempt?: { cancelled: boolean }) => Promise<void>;
  onSaveSite: (config: ConnectionConfig) => Promise<void>;
  onDeleteSite: (id: string) => Promise<void>;
  onSitesUpdated?: (sites: ConnectionConfig[]) => void;
}

type AuthMode = 'password' | 'key' | 'agent';

const DEFAULT_PORTS: Record<string, number> = { sftp: 22, scp: 22, ftp: 21, s3: 443, local: 0, webdav: 443 };
const isSsh = (p: Protocol) => p === 'sftp' || p === 'scp';

const ProtocolIcon: React.FC<{ protocol: Protocol; className?: string }> = ({ protocol, className = 'w-4 h-4' }) => {
  if (protocol === 's3') return <Cloud className={className} />;
  if (protocol === 'local') return <HardDrive className={className} />;
  return <Server className={className} />;
};

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
  const [siteName, setSiteName] = useState<string>('');
  const [host, setHost] = useState<string>('');
  const [port, setPort] = useState<string>('22');
  const [username, setUsername] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  // True while the saved secret is kept server-side and the user has not typed a new one
  const [passwordStored, setPasswordStored] = useState<boolean>(false);
  const [passphraseStored, setPassphraseStored] = useState<boolean>(false);
  const [authMode, setAuthMode] = useState<AuthMode>('password');
  const [privateKeyPath, setPrivateKeyPath] = useState<string>('');
  const [passphrase, setPassphrase] = useState<string>('');
  const [remoteRoot, setRemoteRoot] = useState<string>('');
  const [showPassword, setShowPassword] = useState<boolean>(false);
  const [isConnecting, setIsConnecting] = useState<boolean>(false);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [saveSuccess, setSaveSuccess] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [filter, setFilter] = useState('');
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  // True once the user edits the form; Escape then no longer discards the draft
  const [isDirty, setIsDirty] = useState(false);

  const connectAttemptIdRef = useRef<number>(0);
  const attemptTokenRef = useRef<{ cancelled: boolean } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hostRef = useRef<HTMLInputElement>(null);

  const visibleSites = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = [...savedSites].sort((a, b) => {
      if (a.id === 'local') return -1;
      if (b.id === 'local') return 1;
      return a.name.localeCompare(b.name);
    });
    if (!q) return list;
    return list.filter((s) => `${s.name} ${s.host} ${s.username}`.toLowerCase().includes(q));
  }, [savedSites, filter]);

  if (!isOpen) return null;

  const handleProtocolChange = (p: Protocol) => {
    // Only replace the port when it still holds the previous protocol's default
    const prevDefault = DEFAULT_PORTS[protocol];
    if (!port.trim() || Number(port) === prevDefault) setPort(String(DEFAULT_PORTS[p] ?? 22));
    if (!isSsh(p) && authMode !== 'password') setAuthMode('password');
    setProtocol(p);
    setErrorMessage('');
    setIsDirty(true);
  };

  const handleRemoteRootChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setRemoteRoot(e.target.value);
    setIsDirty(true);
  };

  const handleSelectSite = (site: ConnectionConfig) => {
    setSelectedSiteId(site.id);
    setSiteName(site.name);
    setProtocol(site.protocol);
    setHost(site.host);
    setPort(String(site.port || DEFAULT_PORTS[site.protocol] || ''));
    setUsername(site.username);
    setRemoteRoot(site.remote_root || '');
    setErrorMessage('');
    setShowPassword(false);
    setPendingDeleteId(null);
    setPasswordStored(false);
    setPassphraseStored(false);
    if (site.auth.type === 'Password') {
      setAuthMode('password');
      const stored = isStoredSecret(site.auth.value);
      setPasswordStored(stored);
      setPassword(stored ? '' : site.auth.value || '');
      setPrivateKeyPath('');
      setPassphrase('');
    } else if (site.auth.type === 'PrivateKey') {
      setAuthMode('key');
      setPrivateKeyPath(site.auth.value?.path || '');
      const stored = isStoredSecret(site.auth.value?.passphrase);
      setPassphraseStored(stored);
      setPassphrase(stored ? '' : site.auth.value?.passphrase || '');
      setPassword('');
    } else {
      setAuthMode(isSsh(site.protocol) ? 'agent' : 'password');
      setPassword('');
      setPrivateKeyPath('');
      setPassphrase('');
    }
    setIsDirty(false);
  };

  const resetForm = () => {
    setSelectedSiteId('new');
    setSiteName('');
    setProtocol('sftp');
    setHost('');
    setPort('22');
    setUsername('');
    setPassword('');
    setPasswordStored(false);
    setPassphraseStored(false);
    setAuthMode('password');
    setPrivateKeyPath('');
    setPassphrase('');
    setRemoteRoot('');
    setErrorMessage('');
    setShowPassword(false);
    setPendingDeleteId(null);
    setIsDirty(false);
  };

  const handleNewSite = () => {
    resetForm();
    setTimeout(() => hostRef.current?.focus(), 30);
  };

  /** Accepts pasted `user@host:port`, `sftp://user@host:2222/path` or `s3://endpoint` and splits it into fields. */
  const splitHostInput = (raw: string) => {
    const value = raw.trim();
    const m = value.match(/^(?:(sftp|scp|ftp|s3|https?):\/\/)?(?:([^@\s/]+)@)?([^:/\s]+)(?::(\d{1,5}))?(\/[^\s]*)?$/i);
    if (!m || !(m[1] || m[2] || m[4] || m[5])) return;
    const [, scheme, user, h, p, path] = m;
    if (scheme && !/^https?$/i.test(scheme)) handleProtocolChange(scheme.toLowerCase() as Protocol);
    if (/^https?$/i.test(scheme || '')) return; // S3 endpoints keep their URL form
    setHost(h);
    if (user && !username) setUsername(user);
    if (p) setPort(p);
    if (path && path !== '/' && !remoteRoot) setRemoteRoot(path);
  };

  const buildAuth = (): ConnectionConfig['auth'] => {
    // AuthMethod::None is a unit variant: serde accepts a missing or null `value`, never ''
    if (protocol === 'local') return { type: 'None', value: null };
    if (isSsh(protocol) && authMode === 'key' && privateKeyPath.trim()) {
      const pp = passphrase ? passphrase : passphraseStored ? STORED_SECRET : null;
      return { type: 'PrivateKey', value: { path: privateKeyPath.trim(), passphrase: pp } };
    }
    if (isSsh(protocol) && authMode === 'agent') return { type: 'None', value: null };
    if (password) return { type: 'Password', value: password };
    if (passwordStored) return { type: 'Password', value: STORED_SECRET };
    return { type: 'None', value: null };
  };

  const buildConfig = (): ConnectionConfig => {
    const trimmedHost = host.trim();
    const trimmedUser = username.trim();
    const parsedPort = parseInt(port, 10);
    const fallbackName = trimmedHost ? `${trimmedUser ? `${trimmedUser}@` : ''}${trimmedHost}` : t('loginDialog.newConnection');
    return {
      id: selectedSiteId === 'new' ? `site-${Date.now()}` : selectedSiteId,
      name: siteName.trim() || fallbackName,
      protocol,
      host: protocol === 'local' ? 'localhost' : trimmedHost,
      port: Number.isFinite(parsedPort) ? parsedPort : DEFAULT_PORTS[protocol] ?? 22,
      username: trimmedUser,
      auth: buildAuth(),
      remote_root: remoteRoot.trim(),
    };
  };

  const validate = (): string | null => {
    if (protocol === 'local') return null;
    if (!host.trim()) return t('loginDialog.errHost', 'Enter the server address.');
    const p = parseInt(port, 10);
    if (!Number.isFinite(p) || p < 1 || p > 65535) return t('loginDialog.errPort', 'Port must be a number between 1 and 65535.');
    if (isSsh(protocol) && authMode === 'key' && !privateKeyPath.trim()) return t('loginDialog.errKey', 'Choose a private key file.');
    return null;
  };

  const runConnect = async (cfg: ConnectionConfig) => {
    if (isConnecting) return;
    setErrorMessage('');
    const currentAttempt = ++connectAttemptIdRef.current;
    const token = { cancelled: false };
    attemptTokenRef.current = token;
    setIsConnecting(true);
    try {
      await onConnect(cfg, token);
      if (connectAttemptIdRef.current === currentAttempt) {
        resetForm();
        onClose();
      }
    } catch (err: any) {
      if (connectAttemptIdRef.current === currentAttempt) setErrorMessage(String(err?.message ?? err));
    } finally {
      if (connectAttemptIdRef.current === currentAttempt) setIsConnecting(false);
    }
  };

  const handleConnect = () => {
    const invalid = validate();
    if (invalid) {
      setErrorMessage(invalid);
      return;
    }
    runConnect(buildConfig());
  };

  const handleCancelConnect = () => {
    if (attemptTokenRef.current) attemptTokenRef.current.cancelled = true;
    connectAttemptIdRef.current++;
    setIsConnecting(false);
    setErrorMessage(t('loginDialog.cancelledMsg', 'Connection attempt cancelled. You can adjust the details and try again.'));
  };

  const handleClose = () => {
    if (isConnecting) handleCancelConnect();
    // Do not keep typed credentials around after the dialog closes
    resetForm();
    onClose();
  };

  // Escape (the only dismiss path the Modal shell has here, since backdrop clicks are off):
  // close only when no typed draft would be lost; with a draft it just stops a running attempt.
  // Close/Cancel buttons still call handleClose directly.
  const handleEscape = () => {
    if (!isDirty) {
      handleClose();
      return;
    }
    if (isConnecting) handleCancelConnect();
  };

  const handleSave = async () => {
    const invalid = validate();
    if (invalid) {
      setErrorMessage(invalid);
      return;
    }
    setErrorMessage('');
    setIsSaving(true);
    try {
      const cfg = buildConfig();
      await onSaveSite(cfg);
      setSelectedSiteId(cfg.id);
      setSiteName(cfg.name);
      setIsDirty(false);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
    } catch (err: any) {
      setErrorMessage(String(err?.message ?? err));
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (pendingDeleteId !== id) {
      setPendingDeleteId(id);
      setTimeout(() => setPendingDeleteId((cur) => (cur === id ? null : cur)), 3000);
      return;
    }
    setPendingDeleteId(null);
    try {
      await onDeleteSite(id);
      if (selectedSiteId === id) handleNewSite();
    } catch (err: any) {
      setErrorMessage(String(err?.message ?? err));
    }
  };

  const handlePickPrivateKey = async () => {
    try {
      const selected = await invoke<string | null>('pick_key_file');
      if (selected) {
        setPrivateKeyPath(selected);
        setIsDirty(true);
      }
    } catch (err) {
      console.warn('Native picker failed or not in Tauri environment:', err);
      fileInputRef.current?.click();
    }
  };

  const onFormKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && (e.target as HTMLElement).tagName === 'INPUT') {
      e.preventDefault();
      handleConnect();
    }
  };

  const isNew = selectedSiteId === 'new';
  const isS3 = protocol === 's3';
  const isLocal = protocol === 'local';

  const protocolOptions: Array<{ value: Protocol; label: string; title?: string }> = [
    { value: 'sftp', label: 'SFTP' },
    { value: 'scp', label: 'SCP', title: t('loginDialog.scpHint', 'SCP runs over the same SSH connection') },
    { value: 'ftp', label: 'FTP', title: t('loginDialog.ftpHint', 'Plain FTP: user name, password and files travel unencrypted') },
    { value: 's3', label: 'S3', title: 'Amazon S3, Cloudflare R2, MinIO, Wasabi, B2' },
    { value: 'local', label: t('loginDialog.localShort', 'Local') },
  ];

  return (
    <Modal isOpen={isOpen} onClose={handleEscape} size="2xl" padded={false} className="h-[min(600px,calc(100vh-2rem))]" dismissOnBackdrop={false}>
      <div className="flex h-full min-h-0">
        {/* Saved sites */}
        <aside className="w-60 shrink-0 bg-dark-850 border-r border-line flex flex-col select-none">
          <div className="px-4 pt-4 pb-2 flex items-center justify-between">
            <h2 className="text-[15px] font-semibold text-ink">{t('loginDialog.title', 'Site Manager')}</h2>
            <button type="button" onClick={handleNewSite} className="ui-icon-btn ui-icon-btn-sm" title={t('loginDialog.newConnection')} aria-label={t('loginDialog.newConnection')}>
              <Plus className="w-4 h-4" />
            </button>
          </div>

          {savedSites.length > 6 && (
            <div className="px-3 pb-2">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-ink-faint absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  {...plainTextInputProps}
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder={t('loginDialog.filter', 'Filter')}
                  className="ui-input h-7 pl-7 text-[12.5px]"
                />
              </div>
            </div>
          )}

          <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
            <button
              type="button"
              onClick={handleNewSite}
              className={`w-full flex items-center gap-2.5 px-2.5 h-9 rounded-lg text-[13px] transition-colors ${
                isNew ? 'bg-dark-650 text-ink font-medium' : 'text-ink-muted hover:text-ink hover:bg-dark-650/50'
              }`}
            >
              <Plus className="w-4 h-4 shrink-0" />
              <span className="truncate">{t('loginDialog.newConnection')}</span>
            </button>

            {visibleSites.map((site) => {
              const selected = selectedSiteId === site.id;
              const confirming = pendingDeleteId === site.id;
              return (
                <div
                  key={site.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => handleSelectSite(site)}
                  onDoubleClick={() => {
                    handleSelectSite(site);
                    runConnect(site);
                  }}
                  onKeyDown={(e) => e.key === 'Enter' && handleSelectSite(site)}
                  className={`group flex items-center gap-2.5 px-2.5 h-11 rounded-lg cursor-pointer transition-colors ${
                    selected ? 'bg-dark-650 text-ink' : 'text-ink hover:bg-dark-650/50'
                  }`}
                  title={t('loginDialog.doubleClickHint', 'Double-click to connect')}
                >
                  <ProtocolIcon protocol={site.protocol} className={`w-4 h-4 shrink-0 ${selected ? 'text-rust-500' : 'text-ink-faint'}`} />
                  <div className="flex-1 min-w-0">
                    <div className={`text-[13px] truncate ${selected ? 'font-medium' : ''}`}>{site.name}</div>
                    {site.protocol !== 'local' && (
                      <div className="text-[11px] text-ink-faint truncate">
                        {site.username ? `${site.username}@` : ''}
                        {site.host}
                      </div>
                    )}
                  </div>
                  {site.id !== 'local' && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(site.id);
                      }}
                      title={confirming ? t('loginDialog.confirmDelete', 'Click again to delete') : t('dualPane.delete')}
                      aria-label={t('dualPane.delete')}
                      className={`shrink-0 h-6 rounded-md flex items-center justify-center transition-all ${
                        confirming
                          ? 'px-2 bg-red-600 text-white text-[11px] font-medium opacity-100'
                          : 'w-6 text-ink-faint hover:text-red-600 dark:hover:text-red-400 hover:bg-dark-600/60 opacity-0 group-hover:opacity-100 focus:opacity-100'
                      }`}
                    >
                      {confirming ? t('loginDialog.deleteShort', 'Delete') : <Trash2 className="w-3.5 h-3.5" />}
                    </button>
                  )}
                </div>
              );
            })}
            {visibleSites.length === 0 && filter && (
              <div className="px-3 py-6 text-center text-[12px] text-ink-faint">{t('loginDialog.noMatches', 'No matching sites')}</div>
            )}
          </div>

          <div className="p-2 border-t border-line">
            <button
              type="button"
              onClick={() => setIsVaultModalOpen(true)}
              className="w-full flex items-center gap-2 px-2.5 h-8 rounded-lg text-[12.5px] text-ink-muted hover:text-ink hover:bg-dark-650/50 transition-colors"
              title={t('loginDialog.vaultHint', 'Encrypted (AES-256) export/import for macOS, Windows and Linux')}
            >
              <ArrowDownUp className="w-3.5 h-3.5" />
              {t('loginDialog.importExport', 'Import / Export…')}
            </button>
          </div>
        </aside>

        {/* Connection form */}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="flex-1 overflow-y-auto px-7 pt-5 pb-6" onKeyDown={onFormKeyDown}>
            <div className="flex items-center justify-between mb-5">
              <div className="min-w-0">
                <div className="text-[12px] text-ink-faint">{isNew ? t('loginDialog.newConnection') : t('loginDialog.editing', 'Editing')}</div>
                <input
                  {...plainTextInputProps}
                  value={siteName}
                  onChange={(e) => {
                    setSiteName(e.target.value);
                    setIsDirty(true);
                  }}
                  placeholder={t('loginDialog.namePlaceholder', 'Untitled connection')}
                  aria-label={t('loginDialog.siteName')}
                  className="w-full h-9 bg-transparent text-[17px] font-semibold text-ink placeholder:text-ink-faint outline-none rounded-md -ml-1 px-1 hover:bg-dark-650/40 focus:bg-dark-650/40 transition-colors"
                />
              </div>
              <button type="button" onClick={handleClose} className="ui-icon-btn ui-icon-btn-sm self-start" aria-label={t('loginDialog.cancel')}>
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-4 max-w-[560px]">
              <Field label={t('loginDialog.protocol')}>
                {() => <Segmented<Protocol> ariaLabel={t('loginDialog.protocol')} value={protocol} onChange={handleProtocolChange} options={protocolOptions} className="w-full" />}
              </Field>

              {errorMessage && (
                <div role="alert" className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-red-500/10 text-red-700 dark:text-red-300 text-[12.5px] select-text">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-px" />
                  <span className="flex-1 break-words">{errorMessage}</span>
                </div>
              )}

              {protocol === 'ftp' && (
                <p className="flex items-start gap-2 text-[12px] text-amber-700 dark:text-amber-400 leading-snug">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" />
                  {t('loginDialog.ftpWarning', 'FTP is not encrypted: your password and files travel in clear text. Prefer SFTP when the server supports it.')}
                </p>
              )}

              {isLocal ? (
                <p className="text-[13px] text-ink-muted leading-relaxed">
                  {t('loginDialog.localDesc', 'Opens a new tab browsing the files on this computer.')}
                </p>
              ) : (
                <>
                  <div className="grid grid-cols-[1fr_96px] gap-3">
                    <Field label={isS3 ? t('loginDialog.endpoint', 'Endpoint') : t('loginDialog.host')}>
                      {(id) => (
                        <TextInput
                          id={id}
                          ref={hostRef}
                          mono
                          value={host}
                          onChange={(e) => {
                            setHost(e.target.value);
                            setIsDirty(true);
                          }}
                          onBlur={(e) => splitHostInput(e.target.value)}
                          placeholder={isS3 ? 's3.amazonaws.com' : 'example.com'}
                          data-autofocus
                        />
                      )}
                    </Field>
                    <Field label={t('loginDialog.port')}>
                      {(id) => (
                        <TextInput
                          id={id}
                          mono
                          inputMode="numeric"
                          value={port}
                          onChange={(e) => {
                            setPort(e.target.value.replace(/[^0-9]/g, '').slice(0, 5));
                            setIsDirty(true);
                          }}
                          placeholder={String(DEFAULT_PORTS[protocol] ?? '')}
                        />
                      )}
                    </Field>
                  </div>

                  {isSsh(protocol) && (
                    <Field label={t('loginDialog.authType')}>
                      {() => (
                        <Segmented<AuthMode>
                          ariaLabel={t('loginDialog.authType')}
                          value={authMode}
                          onChange={(m) => {
                            setAuthMode(m);
                            setIsDirty(true);
                          }}
                          options={[
                            { value: 'password', label: t('loginDialog.password') },
                            { value: 'key', label: t('loginDialog.keyFile', 'Key file') },
                            { value: 'agent', label: t('loginDialog.sshAgent', 'SSH agent') },
                          ]}
                        />
                      )}
                    </Field>
                  )}

                  <div className="grid grid-cols-2 gap-3">
                    <Field label={isS3 ? 'Access Key ID' : t('loginDialog.username')}>
                      {(id) => (
                        <TextInput
                          id={id}
                          mono
                          value={username}
                          onChange={(e) => {
                            setUsername(e.target.value);
                            setIsDirty(true);
                          }}
                          placeholder={isS3 ? 'AKIA…' : protocol === 'ftp' ? 'anonymous' : 'root'}
                        />
                      )}
                    </Field>

                    {(!isSsh(protocol) || authMode === 'password') && (
                      <Field label={isS3 ? 'Secret Access Key' : t('loginDialog.password')}>
                        {(id) => (
                          <div className="relative">
                            <TextInput
                              id={id}
                              mono
                              type={showPassword ? 'text' : 'password'}
                              value={password}
                              onChange={(e) => {
                                setPassword(e.target.value);
                                if (e.target.value) setPasswordStored(false);
                                setIsDirty(true);
                              }}
                              placeholder={passwordStored ? t('loginDialog.savedSecret', 'Saved — type to replace') : undefined}
                              className="pr-8"
                            />
                            <button
                              type="button"
                              disabled={passwordStored && !password}
                              onClick={() => setShowPassword((s) => !s)}
                              className="absolute right-1 top-1/2 -translate-y-1/2 ui-icon-btn ui-icon-btn-sm !w-6 !h-6"
                              aria-label={showPassword ? t('loginDialog.hidePassword', 'Hide password') : t('loginDialog.showPassword', 'Show password')}
                            >
                              {showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                            </button>
                          </div>
                        )}
                      </Field>
                    )}

                    {isSsh(protocol) && authMode === 'agent' && (
                      <p className="self-end pb-2 text-[12px] text-ink-faint leading-snug">
                        {t('loginDialog.agentDesc', 'Uses the identities loaded in your running SSH agent.')}
                      </p>
                    )}
                  </div>

                  {isSsh(protocol) && authMode === 'key' && (
                    <div className="space-y-3">
                      <Field label={t('loginDialog.privateKey')} hint={t('loginDialog.keyFileHelper')}>
                        {(id) => (
                          <div className="flex items-center gap-2">
                            <TextInput
                              id={id}
                              mono
                              value={privateKeyPath}
                              onChange={(e) => {
                                setPrivateKeyPath(e.target.value);
                                setIsDirty(true);
                              }}
                              placeholder="~/.ssh/id_ed25519"
                            />
                            <Button onClick={handlePickPrivateKey} icon={<FolderOpen className="w-3.5 h-3.5" />}>
                              {t('loginDialog.browseKey')}
                            </Button>
                          </div>
                        )}
                      </Field>
                      <input
                        type="file"
                        ref={fileInputRef}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) {
                            setPrivateKeyPath((file as any).path || file.name);
                            setIsDirty(true);
                          }
                        }}
                        className="hidden"
                      />
                      <Field label={t('loginDialog.passphrase', 'Key passphrase')} hint={t('loginDialog.passphraseHint', 'Only if the key is encrypted.')}>
                        {(id) => (
                          <TextInput
                            id={id}
                            mono
                            type="password"
                            value={passphrase}
                            onChange={(e) => {
                              setPassphrase(e.target.value);
                              if (e.target.value) setPassphraseStored(false);
                              setIsDirty(true);
                            }}
                            placeholder={passphraseStored ? t('loginDialog.savedSecret', 'Saved — type to replace') : undefined}
                            className="max-w-[280px]"
                          />
                        )}
                      </Field>
                    </div>
                  )}

                  {isS3 && (
                    <Field label={t('loginDialog.defaultBucket')} hint={t('loginDialog.bucketHint', 'Leave empty to list all buckets.')}>
                      {(id) => (
                        <TextInput id={id} mono value={remoteRoot} onChange={handleRemoteRootChange} placeholder="my-bucket" />
                      )}
                    </Field>
                  )}

                  {!isS3 && (
                    <Disclosure label={t('loginDialog.advancedTab')} defaultOpen={!!remoteRoot}>
                      <Field label={t('loginDialog.remoteRoot')} hint={t('loginDialog.remoteRootHelper')}>
                        {(id) => (
                          <TextInput id={id} mono value={remoteRoot} onChange={handleRemoteRootChange} placeholder="~" />
                        )}
                      </Field>
                    </Disclosure>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center gap-2 px-5 py-3.5 border-t border-line shrink-0 select-none">
            <div className="flex-1 min-w-0 flex items-center gap-2 text-[12.5px]">
              {isConnecting ? (
                <span className="flex items-center gap-2 text-ink-muted truncate">
                  <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                  {t('loginDialog.connecting')} {host || ''}
                </span>
              ) : saveSuccess ? (
                <span className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
                  <Check className="w-3.5 h-3.5" />
                  {t('loginDialog.savedSuccess')}
                </span>
              ) : (
                <span className="flex items-center gap-1.5 text-ink-faint truncate" title={t('loginDialog.vaultHint', 'Encrypted (AES-256) export/import for macOS, Windows and Linux')}>
                  <KeyRound className="w-3.5 h-3.5 shrink-0" />
                  {t('loginDialog.vaultBadge')}
                </span>
              )}
            </div>

            {isConnecting ? (
              <Button variant="secondary" onClick={handleCancelConnect}>
                {t('loginDialog.cancelConnecting')}
              </Button>
            ) : (
              <>
                <Button variant="ghost" onClick={handleClose}>
                  {t('loginDialog.cancel')}
                </Button>
                <Button variant="secondary" onClick={handleSave} loading={isSaving}>
                  {isNew ? t('loginDialog.save') : t('loginDialog.saveChanges')}
                </Button>
                <Button variant="primary" onClick={handleConnect}>
                  {t('loginDialog.connect')}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

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
    </Modal>
  );
};
