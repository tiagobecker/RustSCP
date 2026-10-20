import React, { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  Scissors,
  Copy,
  ClipboardPaste,
  CopyPlus,
  House,
  Sparkles,
  Archive,
  FolderInput,
  Zap,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  Terminal,
  SquarePen,
  Calculator,
  Link2,
  Shield,
  Hash,
  Search,
  Code,
  Trash2,
  Ellipsis,
  FolderPlus,
  RotateCw,
  Link,
  TextCursorInput,
} from 'lucide-react';
import { FileEntry, ActionDefinition, ClipboardState } from '../types.ts';
import { basename } from '../utils/paths.ts';
import { notify } from './ui/toast.tsx';
import { isArchiveName, isMacPlatform } from './fileListUtils.ts';

export interface FileContextMenuProps {
  x: number;
  y: number;
  file: FileEntry | null;
  targetPaths: string[];
  isBackground: boolean;
  isRemote: boolean;
  remoteTrashEnabled: boolean;
  currentPath: string;
  selectedFiles: string[];
  clipboard?: ClipboardState | null;
  actionsCatalog?: ActionDefinition[];
  onClose: () => void;
  onCut?: (paths: string[]) => void;
  onCopy?: (paths: string[]) => void;
  onPaste?: () => void;
  onDuplicate?: (path: string) => void;
  /** Optional: rename the item (shown for a single target only). */
  onRename?: (file: FileEntry) => void;
  onGoHome?: () => void;
  onOpenAiAssistant?: () => void;
  onRequestCompress?: (paths: string[]) => void;
  onCompress?: (targets: string[], format: string, outputName: string) => void;
  onRequestExtract?: (path: string) => void;
  onExtract?: (path: string, subfolder?: string) => void;
  onExecuteSmartAction?: (action: ActionDefinition, targetPath: string) => void;
  onOpenTerminalHere?: (path: string) => void;
  onOpenNativeTerminalHere?: (path: string) => void;
  onEditFile?: (file: FileEntry) => void;
  onCalculateSize?: (file: FileEntry) => void;
  onOpenSymlink?: (file?: FileEntry) => void;
  onShowProperties?: (file: FileEntry) => void;
  onCalculateChecksum?: (file: FileEntry) => void;
  onOpenFindFiles?: () => void;
  onOpenGenerateCode?: () => void;
  onMoveToTrash?: (paths: string[]) => void;
  onDelete: (paths: string[], forcePermanent?: boolean) => void;
  /** Optional (background menu): create a folder in the current directory. */
  onNewFolder?: () => void;
  /** Optional (background menu): reload the current directory. */
  onRefresh?: () => void;
}

const MENU_WIDTH = 280;
const SUBMENU_WIDTH = 248;
const MENU_ITEM_SELECTOR = '[role="menuitem"]:not([disabled])';

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

/* -------------------------------------------------------------------------- */
/* Menu primitives                                                             */
/* -------------------------------------------------------------------------- */

interface ItemProps {
  icon?: React.ReactNode;
  label: React.ReactNode;
  shortcut?: string;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  title?: string;
  onHover?: () => void;
}

const Item: React.FC<ItemProps> = ({ icon, label, shortcut, onSelect, disabled, danger, title, onHover }) => (
  <button
    type="button"
    role="menuitem"
    disabled={disabled}
    title={title}
    onClick={onSelect}
    onMouseEnter={onHover}
    className={cx(
      'ui-menu-item h-7 text-[13px] disabled:opacity-40 disabled:hover:bg-transparent focus-visible:bg-dark-650/70 focus-visible:outline-none',
      danger && 'text-red-600 dark:text-red-400'
    )}
  >
    <span className={cx('w-4 h-4 shrink-0 flex items-center justify-center', danger ? 'text-current' : 'text-ink-muted')}>{icon}</span>
    <span className="flex-1 min-w-0 truncate">{label}</span>
    {shortcut && <span className="ui-kbd">{shortcut}</span>}
  </button>
);

const Separator: React.FC = () => <div className="ui-menu-sep" role="separator" />;

interface SubmenuProps {
  id: string;
  icon?: React.ReactNode;
  label: React.ReactNode;
  openId: string | null;
  setOpenId: (id: string | null) => void;
  /** Close the whole context menu (after an item was chosen) */
  children: React.ReactNode;
  width?: number;
}

/**
 * Flyout rendered in a portal at fixed coordinates, so it is never clipped by the scrolling menu.
 * Opens on hover (with a short close delay), click, or ArrowRight; ArrowLeft/Escape returns.
 */
const Submenu: React.FC<SubmenuProps> = ({ id, icon, label, openId, setOpenId, children, width = SUBMENU_WIDTH }) => {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | null>(null);
  const focusFirstOnOpen = useRef(false);
  const isOpen = openId === id;
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);

  const openIdRef = useRef(openId);
  openIdRef.current = openId;

  const cancelClose = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      if (openIdRef.current === id) setOpenId(null);
    }, 220);
  };

  useEffect(() => () => cancelClose(), []);

  // Initial placement from the trigger, then clamp to the viewport once the flyout is measured.
  useLayoutEffect(() => {
    if (!isOpen || !triggerRef.current) {
      setPos(null);
      return;
    }
    const rect = triggerRef.current.getBoundingClientRect();
    const winW = window.innerWidth;
    const winH = window.innerHeight;
    let left = rect.right - 2;
    if (left + width > winW - 8) left = Math.max(8, rect.left - width + 2);
    const flyH = flyoutRef.current?.offsetHeight || 0;
    let top = rect.top - 4;
    if (flyH && top + flyH > winH - 8) top = Math.max(8, winH - flyH - 8);
    setPos({ left, top, maxHeight: winH - 16 });
  }, [isOpen, width]);

  useLayoutEffect(() => {
    if (!isOpen || !pos || !flyoutRef.current) return;
    const flyH = flyoutRef.current.offsetHeight;
    const winH = window.innerHeight;
    if (pos.top + flyH > winH - 8) {
      const top = Math.max(8, winH - flyH - 8);
      if (top !== pos.top) setPos({ ...pos, top });
    }
    if (focusFirstOnOpen.current) {
      focusFirstOnOpen.current = false;
      flyoutRef.current.querySelector<HTMLElement>(MENU_ITEM_SELECTOR)?.focus();
    }
  }, [isOpen, pos]);

  const onFlyoutKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    const items = Array.from(flyoutRef.current?.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR) || []);
    const idx = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!items.length) return;
      const next = e.key === 'ArrowDown' ? (idx + 1) % items.length : (idx - 1 + items.length) % items.length;
      items[next].focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      items[e.key === 'Home' ? 0 : items.length - 1]?.focus();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      setOpenId(null);
      triggerRef.current?.focus();
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        data-submenu-trigger={id}
        onMouseEnter={() => {
          cancelClose();
          if (!isOpen) setOpenId(id);
        }}
        onMouseLeave={scheduleClose}
        onClick={() => {
          cancelClose();
          if (isOpen) {
            setOpenId(null);
          } else {
            focusFirstOnOpen.current = true;
            setOpenId(id);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') {
            e.preventDefault();
            e.stopPropagation();
            focusFirstOnOpen.current = true;
            setOpenId(id);
          }
        }}
        className={cx(
          'ui-menu-item h-7 text-[13px] focus-visible:bg-dark-650/70 focus-visible:outline-none',
          isOpen && 'bg-dark-650/70'
        )}
      >
        <span className="w-4 h-4 shrink-0 flex items-center justify-center text-ink-muted">{icon}</span>
        <span className="flex-1 min-w-0 truncate">{label}</span>
        <ChevronRight className="w-3.5 h-3.5 text-ink-faint shrink-0" aria-hidden />
      </button>

      {isOpen &&
        createPortal(
          <div
            ref={flyoutRef}
            role="menu"
            onMouseEnter={cancelClose}
            onMouseLeave={scheduleClose}
            onKeyDown={onFlyoutKeyDown}
            onPointerDown={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.preventDefault()}
            style={{
              position: 'fixed',
              left: pos?.left ?? -9999,
              top: pos?.top ?? -9999,
              width,
              maxHeight: pos?.maxHeight,
              visibility: pos ? 'visible' : 'hidden',
            }}
            className="z-[60] ui-menu overflow-y-auto select-none animate-pop"
          >
            {children}
          </div>,
          document.body
        )}
    </>
  );
};

/* -------------------------------------------------------------------------- */
/* Context menu                                                                */
/* -------------------------------------------------------------------------- */

export const FileContextMenu: React.FC<FileContextMenuProps> = ({
  x,
  y,
  file,
  targetPaths,
  isRemote,
  remoteTrashEnabled,
  currentPath,
  selectedFiles,
  clipboard,
  actionsCatalog = [],
  onClose,
  onCut,
  onCopy,
  onPaste,
  onDuplicate,
  onRename,
  onGoHome,
  onOpenAiAssistant,
  onRequestCompress,
  onCompress,
  onRequestExtract,
  onExtract,
  onExecuteSmartAction,
  onOpenTerminalHere,
  onOpenNativeTerminalHere,
  onEditFile,
  onCalculateSize,
  onOpenSymlink,
  onShowProperties,
  onCalculateChecksum,
  onOpenFindFiles,
  onOpenGenerateCode,
  onMoveToTrash,
  onDelete,
  onNewFolder,
  onRefresh,
}) => {
  const { i18n } = useTranslation();
  const isPt = i18n.language.startsWith('pt');
  const isMac = isMacPlatform();
  const mod = isMac ? '⌘' : 'Ctrl+';

  const menuRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [openSubmenu, setOpenSubmenu] = useState<string | null>(null);
  const [canScrollUp, setCanScrollUp] = useState<boolean>(false);
  const [canScrollDown, setCanScrollDown] = useState<boolean>(false);

  // Position and edge mapping state
  const [coords, setCoords] = useState<{ x: number; y: number; maxHeight: number; opensUp: boolean; opensLeft: boolean }>(() => {
    const spaceRight = window.innerWidth - x;
    const opensLeft = spaceRight < MENU_WIDTH + 12;
    const initialX = opensLeft ? Math.max(12, x - MENU_WIDTH) : Math.min(x, window.innerWidth - MENU_WIDTH - 12);
    const spaceBelow = window.innerHeight - y;
    const spaceAbove = y;
    const opensUp = spaceBelow < 320 && spaceAbove > spaceBelow;
    const maxH = opensUp ? Math.min(spaceAbove - 16, 560) : Math.min(spaceBelow - 16, 560);
    const initialY = opensUp ? Math.max(12, y - maxH) : y;
    return { x: initialX, y: initialY, maxHeight: maxH, opensUp, opensLeft };
  });

  // Accurate edge mapping after measurement
  useLayoutEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const menuW = rect.width || MENU_WIDTH;
    const menuH = rect.height;
    const winW = window.innerWidth;
    const winH = window.innerHeight;

    const shouldOpenLeft = x + menuW > winW - 12;
    let finalX = shouldOpenLeft ? x - menuW : x;
    if (finalX < 12) finalX = 12;
    if (finalX + menuW > winW - 12) finalX = winW - menuW - 12;

    const spaceBelow = winH - y - 12;
    const spaceAbove = y - 12;
    const shouldOpenUp = spaceBelow < Math.min(menuH, 340) && spaceAbove > spaceBelow;

    let finalY: number;
    let maxH: number;
    if (shouldOpenUp) {
      maxH = Math.min(spaceAbove, 560);
      finalY = Math.max(12, y - Math.min(menuH, maxH));
    } else {
      maxH = Math.min(spaceBelow, 560);
      finalY = Math.max(12, Math.min(y, winH - Math.min(menuH, maxH) - 12));
    }

    setCoords({ x: finalX, y: finalY, maxHeight: maxH, opensUp: shouldOpenUp, opensLeft: shouldOpenLeft });
  }, [x, y]);

  // Scroll detection to show top/bottom indicators
  const checkScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    setCanScrollUp(el.scrollTop > 6);
    setCanScrollDown(el.scrollTop + el.clientHeight < el.scrollHeight - 6);
  }, []);

  useEffect(() => {
    const timer = setTimeout(checkScroll, 30);
    const el = scrollContainerRef.current;
    el?.addEventListener('scroll', checkScroll, { passive: true });
    return () => {
      clearTimeout(timer);
      el?.removeEventListener('scroll', checkScroll);
    };
  }, [checkScroll, coords.maxHeight]);

  // Keyboard focus starts on the menu so arrow keys work immediately
  useEffect(() => {
    menuRef.current?.focus({ preventScroll: true });
  }, []);

  // Global dismiss listeners (Escape key, window resize, window blur)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    const handleResize = () => onClose();
    const handleBlur = () => onClose();

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    window.addEventListener('resize', handleResize);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('blur', handleBlur);
    };
  }, [onClose]);

  const effectiveTargets = targetPaths && targetPaths.length > 0 ? targetPaths : file ? [file.path] : selectedFiles;
  const countSuffix = effectiveTargets.length > 1 ? ` (${effectiveTargets.length})` : '';
  const terminalTarget = file?.file_type === 'directory' ? file.path : currentPath;

  /** Runs an item and closes the menu. */
  const run = (fn: () => void) => () => {
    setOpenSubmenu(null);
    onClose();
    fn();
  };

  const closeSubmenusOnHover = () => {
    if (openSubmenu) setOpenSubmenu(null);
  };

  const copyPath = async () => {
    const target = file?.path || currentPath;
    try {
      await navigator.clipboard.writeText(target);
      notify.success(isPt ? 'Caminho copiado' : 'Path copied', target);
    } catch (err) {
      notify.error(isPt ? 'Não foi possível copiar o caminho' : 'Could not copy the path', err);
    }
  };

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    // Keys typed in the menu never reach the file list below it
    e.stopPropagation();
    const items = Array.from(scrollContainerRef.current?.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR) || []);
    if (!items.length) return;
    const idx = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setOpenSubmenu(null);
      const next = e.key === 'ArrowDown' ? (idx + 1) % items.length : idx <= 0 ? items.length - 1 : idx - 1;
      items[next].focus();
      items[next].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const el = items[e.key === 'Home' ? 0 : items.length - 1];
      el.focus();
      el.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Tab') {
      e.preventDefault();
      onClose();
    }
  };

  // Delete labels follow what each item really does (see App.handleDeleteItems):
  // remote + trash on: "Move to trash" (recoverable) and "Delete permanently" (rm -rf);
  // local or trash off: the only delete is permanent.
  const trashAvailable = isRemote && remoteTrashEnabled;
  const trashShortcut = isMac ? '⌘⌫' : 'Del';
  const permanentShortcut = trashAvailable ? (isMac ? '⌥⌘⌫' : 'Shift+Del') : trashShortcut;

  const hasTerminalNative = !!onOpenNativeTerminalHere;
  const hasTerminalBuiltin = !!onOpenTerminalHere;
  const nativeTerminalLabel = isPt ? 'Terminal do sistema' : 'System terminal';
  const builtinTerminalLabel = isRemote
    ? isPt ? 'Executar comando remoto…' : 'Run remote command…'
    : isPt ? 'Terminal integrado' : 'Built-in terminal';

  const renderTerminalItems = () => {
    if (hasTerminalNative && hasTerminalBuiltin) {
      return (
        <Submenu
          id="terminal"
          icon={<Terminal className="w-4 h-4" />}
          label={isPt ? 'Abrir no terminal' : 'Open in terminal'}
          openId={openSubmenu}
          setOpenId={setOpenSubmenu}
          width={220}
        >
          <Item
            icon={<Terminal className="w-4 h-4" />}
            label={nativeTerminalLabel}
            onSelect={run(() => onOpenNativeTerminalHere!(terminalTarget))}
          />
          <Item
            icon={<Terminal className="w-4 h-4" />}
            label={builtinTerminalLabel}
            onSelect={run(() => onOpenTerminalHere!(terminalTarget))}
          />
        </Submenu>
      );
    }
    if (hasTerminalNative) {
      return (
        <Item
          icon={<Terminal className="w-4 h-4" />}
          label={isPt ? 'Abrir no terminal do sistema' : 'Open in system terminal'}
          onSelect={run(() => onOpenNativeTerminalHere!(terminalTarget))}
          onHover={closeSubmenusOnHover}
        />
      );
    }
    if (hasTerminalBuiltin) {
      return (
        <Item
          icon={<Terminal className="w-4 h-4" />}
          label={builtinTerminalLabel}
          onSelect={run(() => onOpenTerminalHere!(terminalTarget))}
          onHover={closeSubmenusOnHover}
        />
      );
    }
    return null;
  };

  const pasteCount = clipboard && clipboard.paths.length > 0 ? ` (${clipboard.paths.length})` : '';
  const pasteItem = onPaste ? (
    <Item
      icon={<ClipboardPaste className="w-4 h-4" />}
      label={`${isPt ? 'Colar aqui' : 'Paste here'}${pasteCount}`}
      shortcut={`${mod}V`}
      disabled={!clipboard || clipboard.paths.length === 0}
      onSelect={run(() => onPaste())}
      onHover={closeSubmenusOnHover}
    />
  ) : null;

  const moreItems: React.ReactNode[] = [];
  if (onOpenSymlink) {
    moreItems.push(
      <Item
        key="symlink"
        icon={<Link2 className="w-4 h-4" />}
        label={isPt ? 'Criar link simbólico…' : 'Create symbolic link…'}
        onSelect={run(() => onOpenSymlink(file || undefined))}
      />
    );
  }
  if (file && onOpenFindFiles) {
    moreItems.push(
      <Item key="find" icon={<Search className="w-4 h-4" />} label={isPt ? 'Localizar arquivos…' : 'Find files…'} shortcut="⇧F7" onSelect={run(() => onOpenFindFiles())} />
    );
  }
  if (onOpenGenerateCode) {
    moreItems.push(
      <Item key="code" icon={<Code className="w-4 h-4" />} label={isPt ? 'Gerar código / URL…' : 'Generate code / URL…'} onSelect={run(() => onOpenGenerateCode())} />
    );
  }
  if (onOpenAiAssistant) {
    moreItems.push(
      <Item key="ai" icon={<Sparkles className="w-4 h-4" />} label={isPt ? 'Assistente de IA…' : 'AI assistant…'} onSelect={run(() => onOpenAiAssistant())} />
    );
  }
  if (file && onGoHome) {
    moreItems.push(
      <Item key="home" icon={<House className="w-4 h-4" />} label={isPt ? 'Ir para a pasta inicial' : 'Go to home folder'} shortcut={`${mod}H`} onSelect={run(() => onGoHome())} />
    );
  }

  const moreSubmenu =
    moreItems.length > 0 ? (
      <Submenu id="more" icon={<Ellipsis className="w-4 h-4" />} label={isPt ? 'Mais' : 'More'} openId={openSubmenu} setOpenId={setOpenSubmenu}>
        {moreItems}
      </Submenu>
    ) : null;

  const smartActionsSubmenu =
    file && onExecuteSmartAction && actionsCatalog.length > 0 ? (
      <Submenu
        id="smart"
        icon={<Zap className="w-4 h-4" />}
        label={isPt ? 'Ações inteligentes' : 'Smart actions'}
        openId={openSubmenu}
        setOpenId={setOpenSubmenu}
        width={300}
      >
        {actionsCatalog.map((act) => (
          <button
            key={act.id}
            type="button"
            role="menuitem"
            title={act.template}
            onClick={run(() => onExecuteSmartAction(act, file.path))}
            className="w-full flex flex-col items-start gap-0.5 px-2.5 py-1.5 rounded-lg text-left hover:bg-dark-650/70 focus-visible:bg-dark-650/70 focus-visible:outline-none"
          >
            <span className="w-full truncate text-[13px] text-ink">{act.name[isPt ? 'pt-BR' : 'en-US'] || act.name['en-US']}</span>
            <span className="w-full truncate text-[11px] text-ink-faint font-mono">{act.template}</span>
          </button>
        ))}
      </Submenu>
    ) : null;

  const renderFileMenu = (f: FileEntry) => {
    const isDir = f.file_type === 'directory';
    const hasOpenGroup = (!isDir && !!onEditFile) || hasTerminalNative || hasTerminalBuiltin;

    const hasCompress = !!(onRequestCompress || onCompress);
    const hasExtract = isArchiveName(f.name) && !!(onRequestExtract || onExtract);

    const hasInfo = !!onShowProperties || (!isDir && !!onCalculateChecksum) || (isDir && !!onCalculateSize);
    // Rename works on exactly one item: the row that was right-clicked (single selection).
    const canRename = !!onRename && effectiveTargets.length === 1 && effectiveTargets[0] === f.path;

    return (
      <>
        {!isDir && onEditFile && (
          <Item icon={<SquarePen className="w-4 h-4" />} label={isPt ? 'Editar arquivo' : 'Edit file'} shortcut="F4" onSelect={run(() => onEditFile(f))} onHover={closeSubmenusOnHover} />
        )}
        {canRename && (
          <Item icon={<TextCursorInput className="w-4 h-4" />} label={isPt ? 'Renomear…' : 'Rename…'} shortcut="F2" onSelect={run(() => onRename!(f))} onHover={closeSubmenusOnHover} />
        )}
        {renderTerminalItems()}
        {(hasOpenGroup || canRename) && <Separator />}

        {onCut && (
          <Item icon={<Scissors className="w-4 h-4" />} label={`${isPt ? 'Recortar' : 'Cut'}${countSuffix}`} shortcut={`${mod}X`} onSelect={run(() => onCut(effectiveTargets))} onHover={closeSubmenusOnHover} />
        )}
        {onCopy && (
          <Item icon={<Copy className="w-4 h-4" />} label={`${isPt ? 'Copiar' : 'Copy'}${countSuffix}`} shortcut={`${mod}C`} onSelect={run(() => onCopy(effectiveTargets))} onHover={closeSubmenusOnHover} />
        )}
        {pasteItem}
        {onDuplicate && (
          <Item icon={<CopyPlus className="w-4 h-4" />} label={isPt ? 'Duplicar' : 'Duplicate'} shortcut="⇧F5" onSelect={run(() => onDuplicate(f.path))} onHover={closeSubmenusOnHover} />
        )}
        <Item icon={<Link className="w-4 h-4" />} label={isPt ? 'Copiar caminho' : 'Copy path'} onSelect={run(copyPath)} onHover={closeSubmenusOnHover} />

        {(hasCompress || hasExtract) && <Separator />}
        {hasCompress && (
          <Item
            icon={<Archive className="w-4 h-4" />}
            label={`${isPt ? 'Compactar' : 'Compress'}${countSuffix}…`}
            onSelect={run(() => {
              if (onRequestCompress) {
                onRequestCompress(effectiveTargets);
              } else if (onCompress) {
                onCompress(effectiveTargets.map((p) => basename(p) || p), 'tar.gz', `${f.name}.tar.gz`);
              }
            })}
            onHover={closeSubmenusOnHover}
          />
        )}
        {hasExtract && (
          <Item
            icon={<FolderInput className="w-4 h-4" />}
            label={isPt ? 'Extrair…' : 'Extract…'}
            onSelect={run(() => {
              if (onRequestExtract) onRequestExtract(f.path);
              else onExtract?.(f.path, undefined);
            })}
            onHover={closeSubmenusOnHover}
          />
        )}

        {hasInfo && <Separator />}
        {onShowProperties && (
          <Item icon={<Shield className="w-4 h-4" />} label={isPt ? 'Propriedades e permissões…' : 'Properties and permissions…'} onSelect={run(() => onShowProperties(f))} onHover={closeSubmenusOnHover} />
        )}
        {!isDir && onCalculateChecksum && (
          <Item icon={<Hash className="w-4 h-4" />} label={isPt ? 'Calcular checksum…' : 'Calculate checksum…'} onSelect={run(() => onCalculateChecksum(f))} onHover={closeSubmenusOnHover} />
        )}
        {isDir && onCalculateSize && (
          <Item icon={<Calculator className="w-4 h-4" />} label={isPt ? 'Calcular tamanho da pasta' : 'Calculate folder size'} onSelect={run(() => onCalculateSize(f))} onHover={closeSubmenusOnHover} />
        )}

        {(smartActionsSubmenu || moreSubmenu) && <Separator />}
        {smartActionsSubmenu}
        {moreSubmenu}

        <Separator />
        {trashAvailable && onMoveToTrash && (
          <Item
            icon={<Trash2 className="w-4 h-4" />}
            label={`${isPt ? 'Mover para a lixeira' : 'Move to trash'}${countSuffix}`}
            shortcut={trashShortcut}
            onSelect={run(() => onMoveToTrash(effectiveTargets))}
            onHover={closeSubmenusOnHover}
          />
        )}
        <Item
          icon={<Trash2 className="w-4 h-4" />}
          label={`${isPt ? 'Excluir permanentemente' : 'Delete permanently'}${countSuffix}…`}
          shortcut={permanentShortcut}
          danger
          onSelect={run(() => onDelete(effectiveTargets, true))}
          onHover={closeSubmenusOnHover}
        />
      </>
    );
  };

  const renderBackgroundMenu = () => {
    const hasTerminal = hasTerminalNative || hasTerminalBuiltin;
    return (
      <>
        {onNewFolder && (
          <Item icon={<FolderPlus className="w-4 h-4" />} label={isPt ? 'Nova pasta' : 'New folder'} shortcut="F7" onSelect={run(() => onNewFolder())} onHover={closeSubmenusOnHover} />
        )}
        {pasteItem}
        {onRefresh && (
          <Item icon={<RotateCw className="w-4 h-4" />} label={isPt ? 'Atualizar' : 'Refresh'} shortcut={`${mod}R`} onSelect={run(() => onRefresh())} onHover={closeSubmenusOnHover} />
        )}

        <Separator />
        {hasTerminal && renderTerminalItems()}
        <Item icon={<Link className="w-4 h-4" />} label={isPt ? 'Copiar caminho da pasta' : 'Copy folder path'} onSelect={run(copyPath)} onHover={closeSubmenusOnHover} />

        {(onGoHome || onOpenFindFiles) && <Separator />}
        {onGoHome && (
          <Item icon={<House className="w-4 h-4" />} label={isPt ? 'Ir para a pasta inicial' : 'Go to home folder'} shortcut={`${mod}H`} onSelect={run(() => onGoHome())} onHover={closeSubmenusOnHover} />
        )}
        {onOpenFindFiles && (
          <Item icon={<Search className="w-4 h-4" />} label={isPt ? 'Localizar arquivos…' : 'Find files…'} shortcut="⇧F7" onSelect={run(() => onOpenFindFiles())} onHover={closeSubmenusOnHover} />
        )}
        {moreSubmenu}
      </>
    );
  };

  return (
    <>
      {/* Invisible backdrop that captures clicks anywhere outside to close the menu */}
      <div
        className="fixed inset-0 z-50 bg-transparent select-none cursor-default"
        onPointerDown={(e) => {
          e.stopPropagation();
          onClose();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }}
      />

      <div
        ref={menuRef}
        role="menu"
        tabIndex={-1}
        aria-label={isPt ? 'Ações do arquivo' : 'File actions'}
        style={{
          top: coords.y,
          left: coords.x,
          width: MENU_WIDTH,
          maxHeight: coords.maxHeight,
          transformOrigin: `${coords.opensUp ? 'bottom' : 'top'} ${coords.opensLeft ? 'right' : 'left'}`,
        }}
        className="fixed z-50 ui-menu !p-0 flex flex-col select-none overflow-hidden animate-pop focus:outline-none"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onMenuKeyDown}
        onContextMenu={(e) => e.preventDefault()}
      >
        {canScrollUp && (
          <button
            type="button"
            tabIndex={-1}
            onClick={() => scrollContainerRef.current?.scrollBy({ top: -140, behavior: 'smooth' })}
            className="shrink-0 flex items-center justify-center gap-1 h-6 border-b border-line text-[11px] text-ink-faint hover:text-ink"
            title={isPt ? 'Mais itens acima' : 'More items above'}
          >
            <ChevronUp className="w-3.5 h-3.5" aria-hidden />
            <span>{isPt ? 'Mais acima' : 'More above'}</span>
          </button>
        )}

        <div ref={scrollContainerRef} className="flex-1 min-h-0 overflow-y-auto p-1">
          {file ? renderFileMenu(file) : renderBackgroundMenu()}
        </div>

        {canScrollDown && (
          <button
            type="button"
            tabIndex={-1}
            onClick={() => scrollContainerRef.current?.scrollBy({ top: 140, behavior: 'smooth' })}
            className="shrink-0 flex items-center justify-center gap-1 h-6 border-t border-line text-[11px] text-ink-faint hover:text-ink"
            title={isPt ? 'Mais itens abaixo' : 'More items below'}
          >
            <ChevronDown className="w-3.5 h-3.5" aria-hidden />
            <span>{isPt ? 'Mais abaixo' : 'More below'}</span>
          </button>
        )}
      </div>
    </>
  );
};
