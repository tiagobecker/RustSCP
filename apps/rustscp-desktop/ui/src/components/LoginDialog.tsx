import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Server,
  Cloud,
  HardDrive,
  Trash2,
  Eye,
  EyeOff,
  Check,
  Plus,
  Folder,
  FolderOpen,
  FolderInput,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  AlertCircle,
  Search,
  ArrowDownUp,
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

const ProtocolIcon: React.FC<{ protocol: Protocol; className?: string }> = ({ protocol, className = 'w-4 h-4' }) => {
  if (protocol === 's3') return <Cloud className={className} />;
  if (protocol === 'local') return <HardDrive className={className} />;
  return <Server className={className} />;
};

/* -------------------------------------------------------------------------- */
/* Site folders                                                                */
/* -------------------------------------------------------------------------- */

/** Folder paths are '/'-separated; blank segments and the spaces around them are dropped. */
const normalizeGroup = (raw?: string | null): string =>
  (raw ?? '')
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join('/');

const naturalCompare = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/** Folder path plus every parent path ("A/B/C" → "A", "A/B", "A/B/C"). */
const folderChain = (group: string): string[] => {
  const parts = group ? group.split('/') : [];
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
};

interface FolderNode {
  name: string;
  path: string;
  folders: FolderNode[];
  sites: ConnectionConfig[];
  /** Sites in this folder and all of its subfolders */
  count: number;
}

/** Builds the folder tree (sorted, Local pinned first at the top level). Maps keep folder names away from object prototypes. */
const buildSiteTree = (sites: ConnectionConfig[]): FolderNode => {
  const root: FolderNode = { name: '', path: '', folders: [], sites: [], count: 0 };
  const byPath = new Map<string, FolderNode>([['', root]]);
  for (const site of sites) {
    let node = root;
    const group = site.id === 'local' ? '' : normalizeGroup(site.group);
    for (const path of folderChain(group)) {
      let child = byPath.get(path);
      if (!child) {
        child = { name: path.slice(path.lastIndexOf('/') + 1), path, folders: [], sites: [], count: 0 };
        byPath.set(path, child);
        node.folders.push(child);
      }
      node = child;
    }
    node.sites.push(site);
  }
  const finish = (node: FolderNode): number => {
    node.folders.sort((a, b) => naturalCompare(a.name, b.name));
    node.sites.sort((a, b) => {
      if (a.id === 'local') return -1;
      if (b.id === 'local') return 1;
      return naturalCompare(a.name, b.name) || naturalCompare(a.host, b.host);
    });
    node.count = node.sites.length + node.folders.reduce((n, f) => n + finish(f), 0);
    return node.count;
  };
  finish(root);
  return root;
};

const collectFolderPaths = (node: FolderNode, out: string[] = []): string[] => {
  for (const f of node.folders) {
    out.push(f.path);
    collectFolderPaths(f, out);
  }
  return out;
};

type TreeRow = { kind: 'folder'; node: FolderNode; depth: number; expanded: boolean } | { kind: 'site'; site: ConnectionConfig; depth: number };

/** Per-viewer list of collapsed folder paths. A convenience only: the list works without it. */
const COLLAPSED_FOLDERS_KEY = 'rustscp_site_folders_collapsed';
const MAX_REMEMBERED_FOLDERS = 2000;

const loadCollapsedFolders = (): Set<string> => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(COLLAPSED_FOLDERS_KEY) || '[]');
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((p): p is string => typeof p === 'string' && p.length > 0 && p.length <= 1024).slice(0, MAX_REMEMBERED_FOLDERS));
  } catch {
    return new Set();
  }
};

const saveCollapsedFolders = (paths: Set<string>) => {
  try {
    localStorage.setItem(COLLAPSED_FOLDERS_KEY, JSON.stringify([...paths].slice(-MAX_REMEMBERED_FOLDERS)));
  } catch {
    /* storage unavailable (private window, blocked site data): the state just is not remembered */
  }
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
  onDeleteSite,
  onSitesUpdated,
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
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(loadCollapsedFolders);
  // Folders collapsed while a filter is active; forgotten when the filter changes
  const [filterCollapsed, setFilterCollapsed] = useState<Set<string>>(() => new Set());
  // Folders just imported (WinSCP "View connections"): the list scrolls to the first one once it renders
  const [revealFolders, setRevealFolders] = useState<Set<string> | null>(null);
  const siteListRef = useRef<HTMLDivElement>(null);
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
  const [tlsFingerprint, setTlsFingerprint] = useState<string>('');
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

  const filterQuery = filter.trim().toLowerCase();
  const isFiltering = filterQuery.length > 0;

  // The filter matches name, server, user and folder
  const matchingSites = useMemo(() => {
    if (!filterQuery) return savedSites;
    return savedSites.filter((s) => `${s.name} ${s.host} ${s.username} ${normalizeGroup(s.group)}`.toLowerCase().includes(filterQuery));
  }, [savedSites, filterQuery]);

  const siteTree = useMemo(() => buildSiteTree(matchingSites), [matchingSites]);
  const treeFolderPaths = useMemo(() => collectFolderPaths(siteTree), [siteTree]);

  // Every folder in use, parents included: suggestions for the Folder field
  const knownFolders = useMemo(() => {
    const set = new Set<string>();
    for (const s of savedSites) {
      if (s.id === 'local') continue;
      for (const path of folderChain(normalizeGroup(s.group))) set.add(path);
    }
    return [...set].sort(naturalCompare);
  }, [savedSites]);

  // While filtering, every folder with a match starts expanded (the viewer's saved state is left alone)
  const treeRows = useMemo(() => {
    const rows: TreeRow[] = [];
    const isExpanded = (path: string) => (isFiltering ? !filterCollapsed.has(path) : !collapsedFolders.has(path));
    const walk = (node: FolderNode, depth: number) => {
      const pinned = depth === 0 ? node.sites.filter((s) => s.id === 'local') : [];
      for (const site of pinned) rows.push({ kind: 'site', site, depth });
      for (const folder of node.folders) {
        const expanded = isExpanded(folder.path);
        rows.push({ kind: 'folder', node: folder, depth, expanded });
        if (expanded) walk(folder, depth + 1);
      }
      for (const site of node.sites) if (!pinned.includes(site)) rows.push({ kind: 'site', site, depth });
    };
    walk(siteTree, 0);
    return rows;
  }, [siteTree, isFiltering, filterCollapsed, collapsedFolders]);

  useEffect(() => {
    saveCollapsedFolders(collapsedFolders);
  }, [collapsedFolders]);

  useEffect(() => {
    if (!revealFolders) return;
    setRevealFolders(null);
    const list = siteListRef.current;
    if (!list) return;
    // Rows are in tree order, so the first match is the top-most imported folder
    const row = Array.from(list.querySelectorAll<HTMLElement>('[data-folder-path]')).find((el) => revealFolders.has(el.dataset.folderPath ?? ''));
    // Scrolls the list only, never the dialog around it
    if (row) list.scrollTop += row.getBoundingClientRect().top - list.getBoundingClientRect().top - 4;
  }, [revealFolders, treeRows]);

  if (!isOpen) return null;

  const anyFolderExpanded = treeFolderPaths.some((p) => (isFiltering ? !filterCollapsed.has(p) : !collapsedFolders.has(p)));

  const setFoldersCollapsed = (paths: string[], collapse: boolean) => {
    const update = (prev: Set<string>) => {
      const next = new Set(prev);
      for (const p of paths) {
        if (collapse) next.add(p);
        else next.delete(p);
      }
      return next;
    };
    if (isFiltering) setFilterCollapsed(update);
    else setCollapsedFolders(update);
  };

  /** Option/Alt-click also toggles every subfolder, like Finder. */
  const toggleFolder = (node: FolderNode, expanded: boolean, withSubfolders: boolean) => {
    setFoldersCollapsed(withSubfolders ? [node.path, ...collectFolderPaths(node)] : [node.path], expanded);
  };

  /** After a WinSCP import: clears the filter, expands the imported folders and scrolls to the first one. */
  const showImportedConnections = (folders: string[]) => {
    setFilter('');
    setFilterCollapsed(new Set());
    const paths = new Set<string>();
    for (const folder of folders) for (const path of folderChain(normalizeGroup(folder))) paths.add(path);
    if (paths.size === 0) return;
    setCollapsedFolders((prev) => {
      if (![...paths].some((p) => prev.has(p))) return prev;
      const next = new Set(prev);
      paths.forEach((p) => next.delete(p));
      return next;
    });
    setRevealFolders(paths);
  };

  /** Expands the folders above a site so it stays visible in the list. */
  const revealFolder = (rawGroup?: string | null) => {
    const chain = folderChain(normalizeGroup(rawGroup));
    if (!chain.length) return;
    setCollapsedFolders((prev) => {
      if (!chain.some((p) => prev.has(p))) return prev;
      const next = new Set(prev);
      chain.forEach((p) => next.delete(p));
      return next;
    });
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
    setPassphrase('');
    setRemoteRoot('');
    setTlsFingerprint('');
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
    const m = value.match(/^(?:(sftp|scp|ftps|ftpes|ftp|s3|https?):\/\/)?(?:([^@\s/]+)@)?([^:/\s]+)(?::(\d{1,5}))?(\/[^\s]*)?$/i);
    if (!m || !(m[1] || m[2] || m[4] || m[5])) return;
    const [, scheme, user, h, p, path] = m;
    // ftpes:// is WinSCP's name for explicit FTPS, the only FTPS mode RustSCP speaks.
    if (scheme && !/^https?$/i.test(scheme)) handleProtocolChange((/^ftpes$/i.test(scheme) ? 'ftps' : scheme.toLowerCase()) as Protocol);
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
    if (isSsh(protocol) && authMode === 'key' && !privateKeyPath.trim()) return t('loginDialog.errKey', 'Choose a private key file.');
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
    // First Escape just closes the folder suggestions
    if (folderSuggestOpen) {
      setFolderSuggestOpen(false);
      return;
    }
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
      setGroup(cfg.group ?? '');
      revealFolder(cfg.group);
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
    <Modal isOpen={isOpen} onClose={handleEscape} size="2xl" padded={false} className="h-[min(600px,calc(100vh-2rem))]" dismissOnBackdrop={false}>
      <div className="flex h-full min-h-0">
        {/* Saved sites */}
        <aside className="w-64 shrink-0 bg-dark-850 border-r border-line flex flex-col select-none">
          <div className="px-4 pt-4 pb-2 flex items-center gap-1">
            <h2 className="flex-1 min-w-0 truncate text-[15px] font-semibold text-ink">{t('loginDialog.title', 'Site Manager')}</h2>
            {treeFolderPaths.length > 0 && (
              <button
                type="button"
                onClick={() => setFoldersCollapsed(treeFolderPaths, anyFolderExpanded)}
                className="ui-icon-btn ui-icon-btn-sm"
                title={anyFolderExpanded ? t('loginDialog.collapseFolders', 'Collapse all folders') : t('loginDialog.expandFolders', 'Expand all folders')}
                aria-label={anyFolderExpanded ? t('loginDialog.collapseFolders', 'Collapse all folders') : t('loginDialog.expandFolders', 'Expand all folders')}
              >
                {anyFolderExpanded ? <ChevronsDownUp className="w-4 h-4" /> : <ChevronsUpDown className="w-4 h-4" />}
              </button>
            )}
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
                  onChange={(e) => {
                    setFilter(e.target.value);
                    setFilterCollapsed(new Set());
                  }}
                  placeholder={t('loginDialog.filter', 'Filter')}
                  aria-label={t('loginDialog.filterHint', 'Filter by name, server, user or folder')}
                  title={t('loginDialog.filterHint', 'Filter by name, server, user or folder')}
                  className="ui-input h-7 pl-7 pr-7 text-[12.5px]"
                />
                {filter && (
                  <button
                    type="button"
                    onClick={() => {
                      setFilter('');
                      setFilterCollapsed(new Set());
                    }}
                    className="absolute right-1 top-1/2 -translate-y-1/2 ui-icon-btn !w-5 !h-5 !rounded"
                    title={t('loginDialog.clearFilter', 'Clear filter')}
                    aria-label={t('loginDialog.clearFilter', 'Clear filter')}
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
            </div>
          )}

          <div ref={siteListRef} className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
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

            {treeRows.map((row) => {
              if (row.kind === 'folder') {
                const { node, depth, expanded } = row;
                return (
                  <button
                    key={`folder:${node.path}`}
                    type="button"
                    data-folder-path={node.path}
                    aria-expanded={expanded}
                    onClick={(e) => toggleFolder(node, expanded, e.altKey)}
                    onKeyDown={(e) => {
                      if ((e.key === 'ArrowRight' && !expanded) || (e.key === 'ArrowLeft' && expanded)) {
                        e.preventDefault();
                        toggleFolder(node, expanded, e.altKey);
                      }
                    }}
                    className="w-full flex items-center gap-1.5 h-8 pr-2.5 rounded-lg text-[13px] text-ink-muted hover:text-ink hover:bg-dark-650/50 transition-colors"
                    style={{ paddingLeft: 4 + depth * 14 }}
                    title={node.path}
                  >
                    <ChevronRight className={`w-3.5 h-3.5 shrink-0 text-ink-faint transition-transform ${expanded ? 'rotate-90' : ''}`} />
                    {expanded ? <FolderOpen className="w-4 h-4 shrink-0 text-ink-faint" /> : <Folder className="w-4 h-4 shrink-0 text-ink-faint" />}
                    <span className="flex-1 min-w-0 truncate text-left">{node.name}</span>
                    <span className="shrink-0 text-[11px] text-ink-faint tabular-nums">{node.count}</span>
                  </button>
                );
              }
              const { site, depth } = row;
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
                  className={`group flex items-center gap-2.5 pr-2.5 h-11 rounded-lg cursor-pointer transition-colors ${
                    selected ? 'bg-dark-650 text-ink' : 'text-ink hover:bg-dark-650/50'
                  }`}
                  style={{ paddingLeft: 10 + depth * 14 }}
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
            {isFiltering && matchingSites.length === 0 && (
              <div className="px-3 py-6 text-center text-[12px] text-ink-faint">{t('loginDialog.noMatches', 'No matching sites')}</div>
            )}
          </div>

          <div className="p-2 border-t border-line space-y-0.5">
            <button
              type="button"
              onClick={() => {
                setVaultInitialTab(undefined);
                setIsVaultModalOpen(true);
              }}
              className="w-full flex items-center gap-2 px-2.5 h-8 rounded-lg text-[12.5px] text-ink-muted hover:text-ink hover:bg-dark-650/50 transition-colors"
              title={t('loginDialog.vaultHint', 'Encrypted (AES-256) export/import for macOS, Windows and Linux')}
            >
              <ArrowDownUp className="w-3.5 h-3.5" />
              {t('loginDialog.importExport', 'Import / Export…')}
            </button>
            <button
              type="button"
              onClick={() => {
                setVaultInitialTab('winscp');
                setIsVaultModalOpen(true);
              }}
              className="w-full flex items-center gap-2 px-2.5 h-8 rounded-lg text-[12.5px] text-ink-muted hover:text-ink hover:bg-dark-650/50 transition-colors"
              title={t('loginDialog.winscpHint', 'Bring over your WinSCP sites, folders and saved passwords')}
            >
              <FolderInput className="w-3.5 h-3.5" />
              {t('loginDialog.importWinscp', 'Import from WinSCP…')}
            </button>
          </div>
        </aside>

        {/* Connection form */}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="flex-1 overflow-y-auto px-7 pt-5 pb-6" onKeyDown={onFormKeyDown} data-form-scroll>
            <div className="flex items-center justify-between mb-5">
              <div className="min-w-0">
                <div className="text-[12px] text-ink-faint truncate">
                  {isNew ? t('loginDialog.newConnection') : t('loginDialog.editing', 'Editing')}
                  {normalizedGroup && (
                    <span title={normalizedGroup}>
                      {' · '}
                      {normalizedGroup.split('/').join(' / ')}
                    </span>
                  )}
                </div>
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
          initialTab={vaultInitialTab}
          onClose={() => setIsVaultModalOpen(false)}
          onViewConnections={showImportedConnections}
          siteCount={savedSites.filter((s) => s.id !== 'local').length}
          onSitesUpdated={(newSites) => {
            if (onSitesUpdated) onSitesUpdated(newSites);
            // A replace import can remove the site being edited: never save it back by accident
            if (selectedSiteId !== 'new' && !newSites.some((s) => s.id === selectedSiteId)) resetForm();
          }}
        />
      )}
    </Modal>
  );
};
