import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Eye,
  EyeOff,
  Check,
  Ellipsis,
  Folder,
  FolderOpen,
  AlertCircle,
  KeyRound,
  Loader2,
  X,
} from 'lucide-react';
import { ConnectionConfig, Protocol } from '../types.ts';
import { VaultModal, VaultTab } from './VaultModal.tsx';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { Modal } from './ui/Modal.tsx';
import { Button, Disclosure, Field, Segmented, TextInput } from './ui/controls.tsx';
import { plainTextInputProps } from '../utils/inputHardening.ts';
import { STORED_SECRET, isStoredSecret } from '../utils/secrets.ts';
import { isMacPlatform } from './fileListUtils.ts';
import { SiteSidebar } from './siteManager/SiteSidebar.tsx';
import type { SiteSidebarApi } from './siteManager/SiteSidebar.tsx';
import { UnsavedChangesDialog } from './siteManager/UnsavedChangesDialog.tsx';
import { parseAddressInput } from './siteManager/siteQuery.ts';
import { folderChain, naturalCompare, normalizeGroup } from './siteManager/siteTreeModel.ts';
import { useSiteTree } from './siteManager/useSiteTree.ts';

interface LoginDialogProps {
  isOpen: boolean;
  onClose: () => void;
  savedSites: ConnectionConfig[];
  /** `attempt.cancelled` flips to true if the user stops the attempt; the caller should then drop the session. */
  onConnect: (config: ConnectionConfig, attempt?: { cancelled: boolean }) => Promise<void>;
  onSaveSite: (config: ConnectionConfig) => Promise<void>;
  onDeleteSite: (id: string) => Promise<void>;
  onSitesUpdated?: (sites: ConnectionConfig[]) => void;
  /** Makes a `.rustscp` file of a saved site (its saved version, credentials included). */
  onShareSite?: (site: ConnectionConfig) => void;
  /** Opens a `.rustscp` file someone shared. */
  onOpenSharedConnection?: () => void;
}

type AuthMode = 'password' | 'key' | 'agent';

const DEFAULT_PORTS: Record<string, number> = { sftp: 22, scp: 22, ftp: 21, ftps: 21, s3: 443, local: 0, webdav: 443 };
const isSsh = (p: Protocol) => p === 'sftp' || p === 'scp';
const isFtp = (p: Protocol) => p === 'ftp' || p === 'ftps';

/** Same rule as the backend: 64 hex digits, separators and a `SHA256:` / `SHA256 Fingerprint=` prefix allowed. */
const isSha256Fingerprint = (text: string) => {
  const afterEquals = text.includes('=') ? text.slice(text.indexOf('=') + 1) : text;
  const digits = afterEquals
    .trim()
    .toLowerCase()
    .replace(/^sha-?256:/, '')
    .replace(/[:\s-]/g, '');
  return /^[0-9a-f]{64}$/.test(digits);
};

/* -------------------------------------------------------------------------- */
/* Site folders                                                                */
/* -------------------------------------------------------------------------- */

// The connections tree lives in ./siteManager (SiteSidebar); folder paths use its model's
// normalizeGroup / folderChain. The collapsed folders moved from localStorage into the
// encrypted site layout (useSiteTree migrates them once).

const isTextTarget = (target: EventTarget | null) => {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
};

/** Max folder suggestions listed under the Folder field */
const MAX_FOLDER_SUGGESTIONS = 50;

/** Folder text field with suggestions from the folders already in use (a small ARIA combobox). */
const FolderField: React.FC<{
  id: string;
  value: string;
  onChange: (value: string) => void;
  folders: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  placeholder: string;
  listLabel: string;
}> = ({ id, value, onChange, folders, open, onOpenChange, placeholder, listLabel }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [active, setActive] = useState(-1);
  const [dropUp, setDropUp] = useState(false);
  const listId = `${id}-folders`;

  // A field that goes away (Advanced collapsed, Local selected) must not leave the list marked open
  useEffect(() => () => onOpenChange(false), [onOpenChange]);

  const matches = useMemo(() => {
    const q = normalizeGroup(value).toLowerCase();
    if (!q) return folders.slice(0, MAX_FOLDER_SUGGESTIONS);
    const starts: string[] = [];
    const contains: string[] = [];
    for (const f of folders) {
      const lower = f.toLowerCase();
      if (lower === q) continue;
      if (lower.startsWith(q)) starts.push(f);
      else if (lower.includes(q)) contains.push(f);
    }
    return [...starts, ...contains].slice(0, MAX_FOLDER_SUGGESTIONS);
  }, [folders, value]);

  const show = open && matches.length > 0;

  // Nothing to suggest: drop the open flag so Escape is not spent closing an invisible list
  useEffect(() => {
    if (open && matches.length === 0) onOpenChange(false);
  }, [open, matches.length, onOpenChange]);

  const openList = () => {
    // Open upwards when the scrolling form has little room below the field
    const input = inputRef.current;
    const scroller = input?.closest<HTMLElement>('[data-form-scroll]');
    if (input && scroller) {
      const r = input.getBoundingClientRect();
      const s = scroller.getBoundingClientRect();
      const below = s.bottom - r.bottom;
      setDropUp(below < 200 && r.top - s.top > below);
    }
    setActive(-1);
    onOpenChange(true);
  };

  const pick = (folder: string) => {
    onChange(folder);
    setActive(-1);
    onOpenChange(false);
  };

  return (
    <div className="relative">
      <TextInput
        id={id}
        ref={inputRef}
        value={value}
        maxLength={512}
        role="combobox"
        aria-expanded={show}
        aria-controls={show ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={show && active >= 0 ? `${listId}-${active}` : undefined}
        placeholder={placeholder}
        onFocus={openList}
        onBlur={() => onOpenChange(false)}
        onChange={(e) => {
          onChange(e.target.value);
          setActive(-1);
          if (!open) openList();
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (!show) openList();
            else setActive((i) => (i + 1) % matches.length);
          } else if (e.key === 'ArrowUp' && show) {
            e.preventDefault();
            setActive((i) => (i <= 0 ? matches.length - 1 : i - 1));
          } else if (e.key === 'Enter' && show && active >= 0 && active < matches.length) {
            // Picks the suggestion instead of submitting the form (Enter connects)
            e.preventDefault();
            e.stopPropagation();
            pick(matches[active]);
          }
        }}
      />
      {show && (
        <div
          id={listId}
          role="listbox"
          aria-label={listLabel}
          className={`absolute left-0 right-0 z-20 ui-menu max-h-48 overflow-y-auto animate-pop ${dropUp ? 'bottom-full mb-1' : 'top-full mt-1'}`}
        >
          {matches.map((folder, i) => (
            <div
              key={folder}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(folder)}
              className={`ui-menu-item h-7 cursor-pointer text-[12.5px] ${i === active ? 'bg-dark-650/70' : ''}`}
              title={folder}
            >
              <Folder className="w-3.5 h-3.5 shrink-0 text-ink-faint" />
              <span className="truncate">{folder}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export const LoginDialog: React.FC<LoginDialogProps> = ({
  isOpen,
  onClose,
  savedSites,
  onConnect,
  onSaveSite,
  // onDeleteSite stays in the props (App passes it); deletes now go through the tree's undoable ops
  onSitesUpdated,
  onShareSite,
  onOpenSharedConnection,
}) => {
  const { t } = useTranslation();
  const [isVaultModalOpen, setIsVaultModalOpen] = useState(false);
  // undefined: the vault dialog picks its own default tab
  const [vaultInitialTab, setVaultInitialTab] = useState<VaultTab | undefined>(undefined);

  const [selectedSiteId, setSelectedSiteId] = useState<string>('new');
  const [protocol, setProtocol] = useState<Protocol>('sftp');
  const [siteName, setSiteName] = useState<string>('');
  const [group, setGroup] = useState<string>('');
  const [folderSuggestOpen, setFolderSuggestOpen] = useState(false);
  const [host, setHost] = useState<string>('');
  const [port, setPort] = useState<string>('22');
  const [username, setUsername] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  // True while the saved secret is kept server-side and the user has not typed a new one
  const [passwordStored, setPasswordStored] = useState<boolean>(false);
  const [passphraseStored, setPassphraseStored] = useState<boolean>(false);
  const [authMode, setAuthMode] = useState<AuthMode>('password');
  const [privateKeyPath, setPrivateKeyPath] = useState<string>('');
  // The site's key was received in a share: it is kept in the vault, there is no key file
  const [keyEmbedded, setKeyEmbedded] = useState<boolean>(false);
  const [passphrase, setPassphrase] = useState<string>('');
  const [remoteRoot, setRemoteRoot] = useState<string>('');
  const [tlsFingerprint, setTlsFingerprint] = useState<string>('');
  const [showPassword, setShowPassword] = useState<boolean>(false);
  const [isConnecting, setIsConnecting] = useState<boolean>(false);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [saveSuccess, setSaveSuccess] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string>('');
  // The trash button's two-click confirm is gone (deletes have Undo now); the setter calls stay until WP9
  const [, setPendingDeleteId] = useState<string | null>(null);
  // True once the user edits the form; Escape then asks before discarding the draft
  const [isDirty, setIsDirty] = useState(false);
  // The action waiting on the Unsaved-changes dialog
  const [unsavedAction, setUnsavedAction] = useState<(() => void) | null>(null);

  const connectAttemptIdRef = useRef<number>(0);
  const attemptTokenRef = useRef<{ cancelled: boolean } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hostRef = useRef<HTMLInputElement>(null);
  const siteNameRef = useRef<HTMLInputElement>(null);
  const formScrollRef = useRef<HTMLDivElement>(null);
  const sidebarApiRef = useRef<SiteSidebarApi | null>(null);
  // Escape layers registered by the sidebar (inline rename, search); each returns true when it used the key
  const escapeLayersRef = useRef<Array<() => boolean>>([]);
  // Name and folder of the open site as the form loaded them: a tree change to them updates the form
  const formOriginRef = useRef<{ id: string; name: string; group: string } | null>(null);
  // resetForm is declared below the early return; effects reach it through this ref
  const resetFormRef = useRef<() => void>(() => {});

  const siteTree = useSiteTree({ isOpen, savedSites, onSitesUpdated });

  // Every folder in use, parents included, plus the folders kept in the layout: suggestions for the Folder field
  const knownFolders = useMemo(() => {
    const set = new Set<string>();
    for (const s of savedSites) {
      if (s.id === 'local') continue;
      for (const path of folderChain(normalizeGroup(s.group))) set.add(path);
    }
    for (const f of siteTree.layout.folders) {
      const p = normalizeGroup(f);
      if (p) set.add(p);
    }
    return [...set].sort(naturalCompare);
  }, [savedSites, siteTree.layout.folders]);

  // A tree change (rename, move, delete, undo) to the site open in the form updates its name and
  // folder there, keeping the dirty flag; a deleted site resets the form
  useEffect(() => {
    const id = selectedSiteId;
    if (id === 'new') {
      formOriginRef.current = null;
      return;
    }
    const site = savedSites.find((s) => s.id === id);
    const origin = formOriginRef.current;
    if (!site) {
      if (origin?.id === id && !isConnecting) {
        formOriginRef.current = null;
        resetFormRef.current();
      }
      return;
    }
    const siteGroup = id === 'local' ? '' : normalizeGroup(site.group);
    if (origin && origin.id === id) {
      if (site.name !== origin.name) setSiteName(site.name);
      if (siteGroup !== origin.group) setGroup(siteGroup);
    }
    formOriginRef.current = { id, name: site.name, group: siteGroup };
    // Only tree changes (savedSites) and a new open site matter here
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedSites, selectedSiteId]);

  if (!isOpen) return null;

  /** After an import ("View connections"): clears the search, expands the imported folders and selects the first one. */
  const showImportedConnections = (folders: string[]) => {
    // Undo cannot reach across an import
    siteTree.forgetUndo();
    void siteTree.reload();
    sidebarApiRef.current?.revealImported(folders.map((f) => normalizeGroup(f)).filter(Boolean));
  };

  /** Expands the folders above a site so it stays visible in the list. */
  const revealFolder = (rawGroup?: string | null) => {
    const chain = folderChain(normalizeGroup(rawGroup));
    if (!chain.length) return;
    siteTree.setCollapsed((prev) => {
      if (!chain.some((p) => prev.has(p))) return prev;
      const next = new Set(prev);
      chain.forEach((p) => next.delete(p));
      return next;
    });
  };

  /** Runs `action` now, or after the Unsaved-changes dialog when the form has unsaved edits. */
  const guardDirty = (action: () => void) => {
    if (!isDirty) {
      action();
      return;
    }
    setUnsavedAction(() => action);
  };

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
    setGroup(site.id === 'local' ? '' : normalizeGroup(site.group));
    setFolderSuggestOpen(false);
    if (site.id !== 'local') revealFolder(site.group);
    setProtocol(site.protocol);
    setHost(site.host);
    setPort(String(site.port || DEFAULT_PORTS[site.protocol] || ''));
    setUsername(site.username);
    setRemoteRoot(site.remote_root || '');
    setTlsFingerprint(site.tls_fingerprint || '');
    setErrorMessage('');
    setShowPassword(false);
    setPendingDeleteId(null);
    setPasswordStored(false);
    setPassphraseStored(false);
    setKeyEmbedded(false);
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
      setKeyEmbedded(isStoredSecret(site.auth.value?.key_data));
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
    setGroup('');
    setFolderSuggestOpen(false);
    setProtocol('sftp');
    setHost('');
    setPort('22');
    setUsername('');
    setPassword('');
    setPasswordStored(false);
    setPassphraseStored(false);
    setAuthMode('password');
    setPrivateKeyPath('');
    setKeyEmbedded(false);
    setPassphrase('');
    setRemoteRoot('');
    setTlsFingerprint('');
    setErrorMessage('');
    setShowPassword(false);
    setPendingDeleteId(null);
    setIsDirty(false);
  };

  resetFormRef.current = resetForm;

  /** New connection form; `folder` is where it will be saved (the tree's selection). */
  const handleNewSite = (folder?: string) => {
    resetForm();
    if (folder) setGroup(normalizeGroup(folder));
    setTimeout(() => hostRef.current?.focus(), 30);
  };

  /** Accepts pasted `user@host:port`, `sftp://user@host:2222/path` or `s3://endpoint` and splits it into fields. */
  const splitHostInput = (raw: string) => {
    // Same address rules as the search field's "New connection to…" (siteQuery.ADDRESS_RE)
    const parsed = parseAddressInput(raw);
    if (!parsed) return;
    // ftpes:// is WinSCP's name for explicit FTPS, the only FTPS mode RustSCP speaks.
    if (parsed.protocol) handleProtocolChange(parsed.protocol);
    if (parsed.httpEndpoint) return; // S3 endpoints keep their URL form
    setHost(parsed.host);
    if (parsed.user && !username) setUsername(parsed.user);
    if (parsed.port) setPort(parsed.port);
    if (parsed.path && parsed.path !== '/' && !remoteRoot) setRemoteRoot(parsed.path);
  };

  const buildAuth = (): ConnectionConfig['auth'] => {
    // AuthMethod::None is a unit variant: serde accepts a missing or null `value`, never ''
    if (protocol === 'local') return { type: 'None', value: null };
    if (isSsh(protocol) && authMode === 'key' && privateKeyPath.trim()) {
      const pp = passphrase ? passphrase : passphraseStored ? STORED_SECRET : null;
      return { type: 'PrivateKey', value: { path: privateKeyPath.trim(), passphrase: pp } };
    }
    if (isSsh(protocol) && authMode === 'key' && keyEmbedded) {
      // The backend swaps the markers for the key and passphrase kept in the vault
      const pp = passphrase ? passphrase : passphraseStored ? STORED_SECRET : null;
      return { type: 'PrivateKey', value: { path: '', passphrase: pp, key_data: STORED_SECRET } };
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
      tls_fingerprint: protocol === 'ftps' && tlsFingerprint.trim() ? tlsFingerprint.trim() : null,
      // The built-in Local site always stays at the top level
      group: selectedSiteId === 'local' ? null : normalizeGroup(group) || null,
    };
  };

  const validate = (): string | null => {
    if (protocol === 'local') return null;
    if (!host.trim()) return t('loginDialog.errHost', 'Enter the server address.');
    const p = parseInt(port, 10);
    if (!Number.isFinite(p) || p < 1 || p > 65535) return t('loginDialog.errPort', 'Port must be a number between 1 and 65535.');
    if (isSsh(protocol) && authMode === 'key' && !privateKeyPath.trim() && !keyEmbedded) return t('loginDialog.errKey', 'Choose a private key file.');
    if (protocol === 'ftps' && tlsFingerprint.trim() && !isSha256Fingerprint(tlsFingerprint)) {
      return t('loginDialog.errFingerprint', 'The trusted certificate must be a SHA-256 fingerprint (64 hexadecimal digits).');
    }
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
      // Saved connections opened from here count as recent (the backend ignores anything else)
      if (!token.cancelled && cfg.id !== 'local' && savedSites.some((s) => s.id === cfg.id)) siteTree.recordConnected(cfg.id);
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

  // Escape (the only dismiss path the Modal shell has here, since backdrop clicks are off) runs
  // the first step that applies: the sidebar's layers (inline rename, search), the folder
  // suggestions, a running attempt, then closing (asking first when the form has unsaved edits).
  const handleEscape = () => {
    for (const layer of escapeLayersRef.current) if (layer()) return;
    // Next Escape just closes the folder suggestions
    if (folderSuggestOpen) {
      setFolderSuggestOpen(false);
      return;
    }
    if (isConnecting) {
      handleCancelConnect();
      return;
    }
    guardDirty(handleClose);
  };

  /* --------------------------- tree → form wiring --------------------------- */

  /** A site picked in the tree loads into the form (asking first about unsaved edits unless `force`). */
  const selectSiteFromTree = (site: ConnectionConfig, opts?: { force?: boolean }) => {
    if (site.id === selectedSiteId) return;
    if (opts?.force) handleSelectSite(site);
    else guardDirty(() => handleSelectSite(site));
  };

  /** Enter / double-click / Connect on a tree site. The open site connects with the form's values. */
  const connectSiteFromTree = (site: ConnectionConfig) => {
    if (site.id === selectedSiteId) {
      if (isDirty) handleConnect();
      else runConnect(site);
      return;
    }
    guardDirty(() => {
      handleSelectSite(site);
      runConnect(site);
    });
  };

  const focusFirstField = (local: boolean) =>
    setTimeout(() => (local ? siteNameRef.current : hostRef.current ?? siteNameRef.current)?.focus(), 40);

  const editSiteFromTree = (site: ConnectionConfig) => {
    if (site.id === selectedSiteId) {
      focusFirstField(site.id === 'local' || site.protocol === 'local');
      return;
    }
    guardDirty(() => {
      handleSelectSite(site);
      focusFirstField(site.id === 'local' || site.protocol === 'local');
    });
  };

  /** "Change…" in the header: opens the Advanced section and puts the caret in the Folder field. */
  const changeFolder = () => {
    const form = formScrollRef.current;
    if (!form) return;
    const focusFolder = () => form.querySelector<HTMLInputElement>('input[role="combobox"]')?.focus();
    if (form.querySelector('input[role="combobox"]')) {
      focusFolder();
      return;
    }
    const advanced = t('loginDialog.advancedTab');
    const toggle = Array.from(form.querySelectorAll<HTMLButtonElement>('button[aria-expanded="false"]')).find((b) => b.textContent?.trim() === advanced);
    toggle?.click();
    setTimeout(focusFolder, 40);
  };

  // ⌘Z anywhere in the dialog outside text fields undoes the last tree change
  const onDialogKeyDown = (e: React.KeyboardEvent) => {
    const mod = isMacPlatform() ? e.metaKey : e.ctrlKey;
    if (!mod || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'z' || isTextTarget(e.target)) return;
    e.preventDefault();
    void siteTree.undo();
  };

  const handleSave = async (): Promise<boolean> => {
    const invalid = validate();
    if (invalid) {
      setErrorMessage(invalid);
      return false;
    }
    setErrorMessage('');
    setIsSaving(true);
    try {
      const cfg = buildConfig();
      await onSaveSite(cfg);
      setSelectedSiteId(cfg.id);
      setSiteName(cfg.name);
      setGroup(cfg.group ?? '');
      revealFolder(cfg.group);
      setIsDirty(false);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
      return true;
    } catch (err: any) {
      setErrorMessage(String(err?.message ?? err));
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  const handlePickPrivateKey = async () => {
    try {
      const selected = await invoke<string | null>('pick_key_file');
      if (selected) {
        setPrivateKeyPath(selected);
        setKeyEmbedded(false);
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
  const isBuiltInLocal = selectedSiteId === 'local';
  const normalizedGroup = isBuiltInLocal ? '' : normalizeGroup(group);

  const protocolOptions: Array<{ value: Protocol; label: string; title?: string }> = [
    { value: 'sftp', label: 'SFTP' },
    { value: 'scp', label: 'SCP', title: t('loginDialog.scpHint', 'SCP runs over the same SSH connection') },
    { value: 'ftp', label: 'FTP', title: t('loginDialog.ftpHint', 'Plain FTP: user name, password and files travel unencrypted') },
    { value: 'ftps', label: 'FTPS', title: t('loginDialog.ftpsHint', 'FTP over TLS (explicit): user name, password and files are encrypted') },
    { value: 's3', label: 'S3', title: 'Amazon S3, Cloudflare R2, MinIO, Wasabi, B2' },
    { value: 'local', label: t('loginDialog.localShort', 'Local') },
  ];

  return (
    <Modal isOpen={isOpen} onClose={handleEscape} size="3xl" padded={false} className="h-[min(700px,calc(100vh-2rem))]" dismissOnBackdrop={false}>
      <div className="flex h-full min-h-0" onKeyDown={onDialogKeyDown}>
        {/* Saved connections */}
        <SiteSidebar
          tree={siteTree}
          savedSites={savedSites}
          formKey={isNew ? 'draft' : `s:${selectedSiteId}`}
          draftFolder={isNew ? normalizeGroup(group) : null}
          draftName={isNew ? siteName.trim() : ''}
          formDirty={isDirty}
          onSelectSite={selectSiteFromTree}
          onConnectSite={connectSiteFromTree}
          onNewConnection={(folder) => guardDirty(() => handleNewSite(folder))}
          onEditSite={editSiteFromTree}
          onFocusDraft={() => setTimeout(() => (hostRef.current ?? siteNameRef.current)?.focus(), 0)}
          onShareSite={onShareSite}
          onOpenVault={(tab) => {
            setVaultInitialTab(tab);
            setIsVaultModalOpen(true);
          }}
          onOpenSharedConnection={onOpenSharedConnection}
          escapeLayers={escapeLayersRef}
          apiRef={sidebarApiRef}
        />

        {/* Connection form */}
        <div className="flex-1 min-w-0 flex flex-col">
          <div ref={formScrollRef} className="flex-1 overflow-y-auto px-7 pt-5 pb-6" onKeyDown={onFormKeyDown} data-form-scroll>
            <div className="flex items-center justify-between gap-1 mb-5">
              <div className="min-w-0 flex-1">
                <div className="h-[18px] text-[12px] text-ink-faint flex items-center min-w-0 whitespace-nowrap overflow-hidden">
                  {isNew ? (
                    <span className="shrink-0">
                      {normalizedGroup ? t('siteTree.inFolderPrefix', 'New connection · in') : t('siteTree.atTopLevel', 'New connection · at the top level')}
                    </span>
                  ) : (
                    <span className="shrink-0">{t('loginDialog.editing', 'Editing')}</span>
                  )}
                  {normalizedGroup && (
                    <span className="min-w-0 truncate" title={normalizedGroup}>
                      {isNew ? '\u00a0' : '\u00a0·\u00a0'}
                      {folderChain(normalizedGroup).map((path, i) => (
                        <React.Fragment key={path}>
                          {i > 0 && ' / '}
                          <button
                            type="button"
                            className="hover:text-ink hover:underline underline-offset-2"
                            onClick={() => sidebarApiRef.current?.revealFolder(path, { select: true, focus: true })}
                          >
                            {path.slice(path.lastIndexOf('/') + 1)}
                          </button>
                        </React.Fragment>
                      ))}
                    </span>
                  )}
                  {isNew && (
                    <span className="shrink-0">
                      {'\u00a0·\u00a0'}
                      <button type="button" className="text-ink-muted hover:text-ink hover:underline underline-offset-2" onClick={changeFolder}>
                        {t('siteTree.change', 'Change…')}
                      </button>
                    </span>
                  )}
                </div>
                <input
                  {...plainTextInputProps}
                  ref={siteNameRef}
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
              {!isNew && (
                <button
                  type="button"
                  onClick={(e) => sidebarApiRef.current?.openItemMenu(`s:${selectedSiteId}`, e.currentTarget.getBoundingClientRect())}
                  className="ui-icon-btn ui-icon-btn-sm self-start"
                  aria-label={t('siteTree.moreActions', 'More actions')}
                  title={t('siteTree.moreActions', 'More actions')}
                  aria-haspopup="menu"
                >
                  <Ellipsis className="w-4 h-4" />
                </button>
              )}
              <button type="button" onClick={() => guardDirty(handleClose)} className="ui-icon-btn ui-icon-btn-sm self-start" aria-label={t('loginDialog.cancel')}>
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
                  {t('loginDialog.ftpWarning', 'FTP is not encrypted: your password and files travel in clear text. Prefer FTPS or SFTP when the server supports them.')}
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
                          placeholder={isS3 ? 'AKIA…' : isFtp(protocol) ? 'anonymous' : 'root'}
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
                      <Field
                        label={t('loginDialog.privateKey')}
                        hint={
                          keyEmbedded && !privateKeyPath.trim()
                            ? t('loginDialog.embeddedKeyHint', 'This key came in a shared connection and is kept encrypted in your vault. Choose a file only to replace it.')
                            : t('loginDialog.keyFileHelper')
                        }
                      >
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
                              placeholder={keyEmbedded ? t('loginDialog.embeddedKey', 'Received key (in the vault)') : '~/.ssh/id_ed25519'}
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
                            setKeyEmbedded(false);
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

                </>
              )}

              {/* The built-in Local site has nothing advanced to set (it always stays at the top level) */}
              {!isBuiltInLocal && (
                <Disclosure label={t('loginDialog.advancedTab')} defaultOpen={(!isS3 && !isLocal && !!remoteRoot) || (protocol === 'ftps' && !!tlsFingerprint)}>
                  <div className="space-y-4">
                    <Field
                      label={t('loginDialog.folder', 'Folder')}
                      hint={t('loginDialog.folderHint', 'Groups this connection in the site list. Use / for subfolders; leave empty for the top level.')}
                    >
                      {(id) => (
                        <FolderField
                          id={id}
                          value={group}
                          onChange={(value) => {
                            setGroup(value);
                            setIsDirty(true);
                          }}
                          folders={knownFolders}
                          open={folderSuggestOpen}
                          onOpenChange={setFolderSuggestOpen}
                          placeholder={t('loginDialog.folderPlaceholder', 'e.g. Production/Web')}
                          listLabel={t('loginDialog.folderSuggestions', 'Existing folders')}
                        />
                      )}
                    </Field>
                    {!isS3 && !isLocal && (
                      <Field label={t('loginDialog.remoteRoot')} hint={t('loginDialog.remoteRootHelper')}>
                        {(id) => (
                          <TextInput id={id} mono value={remoteRoot} onChange={handleRemoteRootChange} placeholder="~" />
                        )}
                      </Field>
                    )}
                    {protocol === 'ftps' && (
                      <Field
                        label={t('loginDialog.tlsFingerprint', 'Trusted certificate (SHA-256)')}
                        hint={t(
                          'loginDialog.tlsFingerprintHint',
                          "Only for a server with a self-signed certificate. Certificates your system trusts are always accepted. If the connection reports an untrusted certificate, compare its fingerprint with the server's and paste it here."
                        )}
                      >
                        {(id) => (
                          <TextInput
                            id={id}
                            mono
                            value={tlsFingerprint}
                            onChange={(e) => {
                              setTlsFingerprint(e.target.value);
                              setIsDirty(true);
                            }}
                            placeholder="AB:CD:EF:…"
                          />
                        )}
                      </Field>
                    )}
                  </div>
                </Disclosure>
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
                <Button variant="ghost" onClick={() => guardDirty(handleClose)}>
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
          initialTab={vaultInitialTab}
          onClose={() => setIsVaultModalOpen(false)}
          onViewConnections={showImportedConnections}
          siteCount={savedSites.filter((s) => s.id !== 'local').length}
          onSitesUpdated={(newSites) => {
            if (onSitesUpdated) onSitesUpdated(newSites);
            // A replace import can remove the site being edited: never save it back by accident
            if (selectedSiteId !== 'new' && !newSites.some((s) => s.id === selectedSiteId)) resetForm();
            // Undo cannot reach across an import; imported folders join the layout
            siteTree.forgetUndo();
            void siteTree.reload();
          }}
        />
      )}

      {unsavedAction && (
        <UnsavedChangesDialog
          name={isNew ? null : siteName.trim() || savedSites.find((s) => s.id === selectedSiteId)?.name || null}
          onSave={async () => {
            const action = unsavedAction;
            const ok = await handleSave();
            setUnsavedAction(null);
            if (ok) action();
            return ok;
          }}
          onDontSave={() => {
            const action = unsavedAction;
            setUnsavedAction(null);
            setIsDirty(false);
            action();
          }}
          onCancel={() => setUnsavedAction(null)}
        />
      )}
    </Modal>
  );
};
