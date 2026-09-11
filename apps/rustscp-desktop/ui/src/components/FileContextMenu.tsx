import React, { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { 
  Scissors, 
  Copy, 
  Clipboard, 
  CopyPlus, 
  Home, 
  Sparkles, 
  Archive, 
  FolderInput, 
  Zap, 
  ChevronRight, 
  ChevronUp, 
  ChevronDown, 
  Terminal, 
  Edit, 
  Calculator, 
  Link2, 
  Shield, 
  Hash, 
  Search, 
  Code, 
  Trash2 
} from 'lucide-react';
import { FileEntry, ActionDefinition, ClipboardState } from '../types.ts';

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
}

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
}) => {
  const { i18n } = useTranslation();
  const isPt = i18n.language.startsWith('pt');
  const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);

  const menuRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [activeSubmenu, setActiveSubmenu] = useState<'smartActions' | null>(null);
  const [canScrollUp, setCanScrollUp] = useState<boolean>(false);
  const [canScrollDown, setCanScrollDown] = useState<boolean>(false);

  // Position and edge mapping state
  const [coords, setCoords] = useState<{
    x: number;
    y: number;
    maxHeight: number;
    opensUp: boolean;
    opensLeft: boolean;
  }>(() => {
    const menuWidth = 270;
    const spaceRight = window.innerWidth - x;
    const opensLeft = spaceRight < menuWidth + 12;
    const initialX = opensLeft ? Math.max(12, x - menuWidth) : Math.min(x, window.innerWidth - menuWidth - 12);

    const spaceBelow = window.innerHeight - y;
    const spaceAbove = y;
    const opensUp = spaceBelow < 320 && spaceAbove > spaceBelow;
    const maxH = opensUp ? Math.min(spaceAbove - 16, 540) : Math.min(spaceBelow - 16, 540);
    const initialY = opensUp ? Math.max(12, y - maxH) : y;

    return {
      x: initialX,
      y: initialY,
      maxHeight: maxH,
      opensUp,
      opensLeft,
    };
  });

  // Accurate edge mapping after measurement
  useLayoutEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const menuW = rect.width || 270;
    const menuH = rect.height;

    const winW = window.innerWidth;
    const winH = window.innerHeight;

    // Horizontal placement
    const shouldOpenLeft = x + menuW > winW - 12;
    let finalX = shouldOpenLeft ? x - menuW : x;
    if (finalX < 12) finalX = 12;
    if (finalX + menuW > winW - 12) finalX = winW - menuW - 12;

    // Vertical placement (flip upward when close to bottom)
    const spaceBelow = winH - y - 12;
    const spaceAbove = y - 12;
    const shouldOpenUp = spaceBelow < 340 && spaceAbove > spaceBelow;

    let finalY: number;
    let maxH: number;

    if (shouldOpenUp) {
      maxH = Math.min(spaceAbove, 540);
      finalY = Math.max(12, y - Math.min(menuH, maxH));
    } else {
      maxH = Math.min(spaceBelow, 540);
      finalY = Math.min(y, winH - Math.min(menuH, maxH) - 12);
    }

    setCoords({
      x: finalX,
      y: finalY,
      maxHeight: maxH,
      opensUp: shouldOpenUp,
      opensLeft: shouldOpenLeft,
    });
  }, [x, y]);

  // Scroll detection to show top/bottom indicators
  const checkScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    setCanScrollUp(el.scrollTop > 6);
    setCanScrollDown(el.scrollTop + el.clientHeight < el.scrollHeight - 6);
  }, []);

  useEffect(() => {
    // Initial check after paint
    const timer = setTimeout(() => {
      checkScroll();
    }, 30);

    const el = scrollContainerRef.current;
    if (el) {
      el.addEventListener('scroll', checkScroll, { passive: true });
    }

    return () => {
      clearTimeout(timer);
      if (el) {
        el.removeEventListener('scroll', checkScroll);
      }
    };
  }, [checkScroll]);

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

  const isArchiveFile = (fileName: string) => {
    const lower = fileName.toLowerCase();
    return (
      lower.endsWith('.zip') ||
      lower.endsWith('.tar.gz') ||
      lower.endsWith('.tgz') ||
      lower.endsWith('.tar.bz2') ||
      lower.endsWith('.tbz2') ||
      lower.endsWith('.tar') ||
      lower.endsWith('.gz') ||
      lower.endsWith('.zst')
    );
  };

  const effectiveTargets = targetPaths && targetPaths.length > 0 
    ? targetPaths 
    : (file ? [file.path] : selectedFiles);

  return (
    <>
      {/* Invisible backdrop that captures clicks anywhere outside to cleanly close the menu */}
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

      {/* Context Menu Container with Viewport Edge Mapping */}
      <div
        ref={menuRef}
        style={{ 
          top: coords.y, 
          left: coords.x, 
          maxHeight: coords.maxHeight,
          transformOrigin: `${coords.opensUp ? 'bottom' : 'top'} ${coords.opensLeft ? 'right' : 'left'}`
        }}
        className="fixed bg-white/95 dark:bg-dark-800/95 backdrop-blur-md border border-slate-300/80 dark:border-dark-600/80 rounded-xl shadow-2xl z-50 w-68 text-xs text-slate-800 dark:text-slate-200 animate-in fade-in zoom-in-95 duration-100 flex flex-col select-none overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Scroll Indicator: More items above */}
        {canScrollUp && (
          <div 
            onClick={() => {
              scrollContainerRef.current?.scrollBy({ top: -140, behavior: 'smooth' });
            }}
            className="shrink-0 flex items-center justify-center py-1 bg-gradient-to-b from-white via-white/95 to-white/20 dark:from-dark-800 dark:via-dark-800/95 dark:to-dark-800/20 text-slate-500 hover:text-rust-600 dark:text-slate-400 dark:hover:text-rust-400 cursor-pointer border-b border-slate-200/50 dark:border-dark-700/50 transition-colors z-20"
            title={isPt ? 'Clique ou role para ver itens acima' : 'Click or scroll to see items above'}
          >
            <div className="flex items-center space-x-1 px-2.5 py-0.5 rounded-full bg-slate-100 dark:bg-dark-700 border border-slate-200 dark:border-dark-600 shadow-2xs">
              <ChevronUp className="w-3 h-3 text-rust-500 animate-bounce" />
              <span className="text-[10px] font-semibold tracking-wider text-slate-700 dark:text-slate-300">
                {isPt ? 'Mais acima' : 'More above'}
              </span>
            </div>
          </div>
        )}

        {/* Scrollable Items Container */}
        <div 
          ref={scrollContainerRef}
          className="flex-1 overflow-y-auto py-1.5 space-y-0.5 scrollbar-thin scrollbar-thumb-slate-300 dark:scrollbar-thumb-dark-600 scrollbar-track-transparent"
        >
          {/* Clipboard: Cut, Copy, Paste */}
          {file && onCut && (
            <button
              onClick={() => {
                onCut(effectiveTargets);
                onClose();
              }}
              className="w-full text-left px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-dark-700 flex items-center justify-between text-slate-800 dark:text-slate-200 hover:text-slate-950 dark:hover:text-white transition-colors"
            >
              <div className="flex items-center space-x-2">
                <Scissors className="w-3.5 h-3.5 text-amber-500 dark:text-amber-400" />
                <span>{isPt ? 'Recortar' : 'Cut'}</span>
              </div>
              <span className="text-[10px] text-slate-500 font-mono">{isMac ? '⌘X' : 'Ctrl+X'}</span>
            </button>
          )}

          {file && onCopy && (
            <button
              onClick={() => {
                onCopy(effectiveTargets);
                onClose();
              }}
              className="w-full text-left px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-dark-700 flex items-center justify-between text-slate-800 dark:text-slate-200 hover:text-slate-950 dark:hover:text-white transition-colors"
            >
              <div className="flex items-center space-x-2">
                <Copy className="w-3.5 h-3.5 text-sky-500 dark:text-sky-400" />
                <span>{isPt ? 'Copiar' : 'Copy'}</span>
              </div>
              <span className="text-[10px] text-slate-500 font-mono">{isMac ? '⌘C' : 'Ctrl+C'}</span>
            </button>
          )}

          {onPaste && (
            <button
              disabled={!clipboard || clipboard.paths.length === 0}
              onClick={() => {
                onPaste();
                onClose();
              }}
              className="w-full text-left px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-dark-700 flex items-center justify-between text-slate-800 dark:text-slate-200 hover:text-slate-950 dark:hover:text-white disabled:opacity-30 transition-colors"
            >
              <div className="flex items-center space-x-2">
                <Clipboard className="w-3.5 h-3.5 text-emerald-500 dark:text-emerald-400" />
                <span>
                  {isPt ? 'Colar Aqui' : 'Paste Here'} 
                  {clipboard && clipboard.paths.length > 0 ? ` (${clipboard.paths.length})` : ''}
                </span>
              </div>
              <span className="text-[10px] text-slate-500 font-mono">{isMac ? '⌘V' : 'Ctrl+V'}</span>
            </button>
          )}

          {file && onDuplicate && (
            <button
              onClick={() => {
                onDuplicate(file.path);
                onClose();
              }}
              className="w-full text-left px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-dark-700 flex items-center justify-between text-slate-800 dark:text-slate-200 hover:text-slate-950 dark:hover:text-white transition-colors"
            >
              <div className="flex items-center space-x-2">
                <CopyPlus className="w-3.5 h-3.5 text-cyan-500 dark:text-cyan-400" />
                <span>{isPt ? 'Duplicar Item' : 'Duplicate Item'}</span>
              </div>
              <span className="text-[10px] text-slate-500 font-mono">Shift+F5</span>
            </button>
          )}

          {onGoHome && (
            <button
              onClick={() => {
                onGoHome();
                onClose();
              }}
              className="w-full text-left px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-dark-700 flex items-center justify-between text-slate-800 dark:text-slate-200 hover:text-slate-950 dark:hover:text-white transition-colors"
            >
              <div className="flex items-center space-x-2">
                <Home className="w-3.5 h-3.5 text-sky-500 dark:text-sky-400" />
                <span>{isPt ? 'Ir para Pasta Home (~)' : 'Go to Home Directory (~)'}</span>
              </div>
              <span className="text-[10px] text-slate-500 font-mono">{isMac ? '⌘H' : 'Ctrl+H'}</span>
            </button>
          )}

          {onOpenAiAssistant && (
            <button
              onClick={() => {
                onOpenAiAssistant();
                onClose();
              }}
              className="w-full text-left px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-dark-700 flex items-center justify-between text-slate-800 dark:text-slate-200 hover:text-slate-950 dark:hover:text-white transition-colors"
            >
              <div className="flex items-center space-x-2">
                <Sparkles className="w-3.5 h-3.5 text-purple-500 dark:text-purple-400" />
                <span>{isPt ? 'Assistente de IA...' : 'AI Assistant...'}</span>
              </div>
              <span className="text-[10px] text-purple-600 dark:text-purple-400 font-mono font-bold">AI</span>
            </button>
          )}

          <div className="h-px bg-slate-200 dark:bg-dark-700 my-1" />

          {/* Compress */}
          {file && (onRequestCompress || onCompress) && (
            <button
              onClick={() => {
                if (onRequestCompress) {
                  onRequestCompress(effectiveTargets);
                } else if (onCompress) {
                  const defaultName = `${file.name}.tar.gz`;
                  const targets = effectiveTargets.map((p) => p.split('/').pop() || p);
                  onCompress(targets, 'tar.gz', defaultName);
                }
                onClose();
              }}
              className="w-full text-left px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-dark-700 flex items-center justify-between text-slate-800 dark:text-slate-200 hover:text-slate-950 dark:hover:text-white transition-colors"
            >
              <div className="flex items-center space-x-2">
                <Archive className="w-3.5 h-3.5 text-purple-500 dark:text-purple-400" />
                <span>
                  {isPt ? 'Compactar' : 'Compress'} 
                  {effectiveTargets.length > 1 ? ` (${effectiveTargets.length})` : ''}...
                </span>
              </div>
            </button>
          )}

          {/* Extract Archive */}
          {file && isArchiveFile(file.name) && (onRequestExtract || onExtract) && (
            <button
              onClick={() => {
                if (onRequestExtract) {
                  onRequestExtract(file.path);
                } else if (onExtract) {
                  onExtract(file.path, undefined);
                }
                onClose();
              }}
              className="w-full text-left px-3 py-1.5 hover:bg-purple-500/20 flex items-center justify-between text-purple-900 dark:text-purple-200 hover:text-purple-950 dark:hover:text-white bg-purple-500/10 transition-colors"
            >
              <div className="flex items-center space-x-2">
                <FolderInput className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400" />
                <span className="font-semibold text-purple-700 dark:text-purple-300">{isPt ? 'Extrair Arquivo...' : 'Extract Archive...'}</span>
              </div>
            </button>
          )}

          {/* Linux Smart Actions Submenu with Submenu Viewport Flipping */}
          {file && onExecuteSmartAction && actionsCatalog.length > 0 && (
            <div 
              className="relative"
              onMouseEnter={() => setActiveSubmenu('smartActions')}
              onMouseLeave={() => setActiveSubmenu(null)}
            >
              <button
                className="w-full text-left px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-dark-700 flex items-center justify-between text-slate-800 dark:text-slate-200 hover:text-slate-950 dark:hover:text-white transition-colors"
              >
                <div className="flex items-center space-x-2">
                  <Zap className="w-3.5 h-3.5 text-amber-500 dark:text-amber-400" />
                  <span>{isPt ? 'Comandos Rápidos Linux' : 'Linux Smart Actions'}</span>
                </div>
                <ChevronRight className="w-3 h-3 text-slate-400" />
              </button>

              {activeSubmenu === 'smartActions' && (
                <div 
                  className={`absolute ${
                    coords.opensLeft ? 'right-full mr-1.5' : 'left-full ml-1.5'
                  } ${
                    coords.opensUp ? 'bottom-0' : 'top-0'
                  } bg-white dark:bg-dark-800 border border-slate-300 dark:border-dark-600 rounded-xl shadow-2xl py-1 w-64 max-h-60 overflow-y-auto z-50 text-xs`}
                >
                  {actionsCatalog.slice(0, 10).map((act) => (
                    <button
                      key={act.id}
                      onClick={() => {
                        onExecuteSmartAction(act, file.path);
                        onClose();
                      }}
                      className="w-full text-left px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-dark-700 text-slate-800 dark:text-slate-200 hover:text-slate-950 dark:hover:text-white truncate flex flex-col transition-colors"
                    >
                      <span className="font-semibold text-slate-800 dark:text-slate-200">{act.name[isPt ? 'pt-BR' : 'en-US']}</span>
                      <span className="text-[10px] text-slate-500 dark:text-slate-400 font-mono truncate">{act.template}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Terminal Here */}
          {onOpenTerminalHere && (
            <button
              onClick={() => {
                const target = file?.file_type === 'directory' ? file.path : currentPath;
                onOpenTerminalHere(target);
                onClose();
              }}
              className="w-full text-left px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-dark-700 flex items-center space-x-2 text-slate-800 dark:text-slate-200 hover:text-slate-950 dark:hover:text-white transition-colors"
            >
              <Terminal className="w-3.5 h-3.5 text-emerald-500 dark:text-emerald-400" />
              <span>{isPt ? 'Abrir Terminal Aqui' : 'Open Terminal Here'}</span>
            </button>
          )}

          {/* Native OS Terminal Here */}
          {onOpenNativeTerminalHere && (
            <button
              onClick={() => {
                const target = file?.file_type === 'directory' ? file.path : currentPath;
                onOpenNativeTerminalHere(target);
                onClose();
              }}
              className="w-full text-left px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-dark-700 flex items-center space-x-2 text-emerald-700 dark:text-emerald-400 font-semibold hover:text-emerald-900 dark:hover:text-emerald-300 transition-colors"
            >
              <Terminal className="w-3.5 h-3.5 text-emerald-500 dark:text-emerald-400" />
              <span>{isPt ? 'Terminal Nativo do Sistema' : 'Native OS Terminal'}</span>
            </button>
          )}

          <div className="h-px bg-slate-200 dark:bg-dark-700 my-1" />

          {/* Edit file */}
          {file && file.file_type !== 'directory' && onEditFile && (
            <button
              onClick={() => {
                onEditFile(file);
                onClose();
              }}
              className="w-full text-left px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-dark-700 flex items-center justify-between text-slate-800 dark:text-slate-200 hover:text-slate-950 dark:hover:text-white transition-colors"
            >
              <div className="flex items-center space-x-2">
                <Edit className="w-3.5 h-3.5 text-sky-500 dark:text-sky-400" />
                <span>{isPt ? 'Editar Arquivo' : 'Edit File'}</span>
              </div>
              <span className="text-[10px] text-slate-500 font-mono">F4</span>
            </button>
          )}

          {/* Folder Size */}
          {file && file.file_type === 'directory' && onCalculateSize && (
            <button
              onClick={() => {
                onCalculateSize(file);
                onClose();
              }}
              className="w-full text-left px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-dark-700 flex items-center space-x-2 text-slate-800 dark:text-slate-200 hover:text-slate-950 dark:hover:text-white transition-colors"
            >
              <Calculator className="w-3.5 h-3.5 text-amber-500 dark:text-amber-400" />
              <span>{isPt ? 'Calcular Tamanho da Pasta' : 'Calculate Folder Size'}</span>
            </button>
          )}

          {/* Create Symlink */}
          {onOpenSymlink && (
            <button
              onClick={() => {
                onOpenSymlink(file || undefined);
                onClose();
              }}
              className="w-full text-left px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-dark-700 flex items-center space-x-2 text-slate-800 dark:text-slate-200 hover:text-slate-950 dark:hover:text-white transition-colors"
            >
              <Link2 className="w-3.5 h-3.5 text-cyan-500 dark:text-cyan-400" />
              <span>{isPt ? 'Criar Link Simbólico...' : 'Create Symbolic Link...'}</span>
            </button>
          )}

          {/* Permissions / Properties */}
          {file && onShowProperties && (
            <button
              onClick={() => {
                onShowProperties(file);
                onClose();
              }}
              className="w-full text-left px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-dark-700 flex items-center space-x-2 text-slate-800 dark:text-slate-200 hover:text-slate-950 dark:hover:text-white transition-colors"
            >
              <Shield className="w-3.5 h-3.5 text-emerald-500 dark:text-emerald-400" />
              <span>{isPt ? 'Propriedades (Chmod)' : 'Properties (Chmod)'}</span>
            </button>
          )}

          {/* Checksum */}
          {file && onCalculateChecksum && file.file_type !== 'directory' && (
            <button
              onClick={() => {
                onCalculateChecksum(file);
                onClose();
              }}
              className="w-full text-left px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-dark-700 flex items-center space-x-2 text-slate-800 dark:text-slate-200 hover:text-slate-950 dark:hover:text-white transition-colors"
            >
              <Hash className="w-3.5 h-3.5 text-amber-500 dark:text-amber-400" />
              <span>{isPt ? 'Calcular Checksum' : 'Calculate Checksum'}</span>
            </button>
          )}

          {/* Find Files */}
          {onOpenFindFiles && (
            <button
              onClick={() => {
                onOpenFindFiles();
                onClose();
              }}
              className="w-full text-left px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-dark-700 flex items-center justify-between text-slate-800 dark:text-slate-200 hover:text-slate-950 dark:hover:text-white transition-colors"
            >
              <div className="flex items-center space-x-2">
                <Search className="w-3.5 h-3.5 text-emerald-500 dark:text-emerald-400" />
                <span>{isPt ? 'Localizar Arquivos...' : 'Find Files...'}</span>
              </div>
              <span className="text-[10px] text-slate-500 font-mono">Shift+F7</span>
            </button>
          )}

          {/* Generate Code / URL */}
          {onOpenGenerateCode && (
            <button
              onClick={() => {
                onOpenGenerateCode();
                onClose();
              }}
              className="w-full text-left px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-dark-700 flex items-center space-x-2 text-slate-800 dark:text-slate-200 hover:text-slate-950 dark:hover:text-white transition-colors"
            >
              <Code className="w-3.5 h-3.5 text-blue-500 dark:text-blue-400" />
              <span>{isPt ? 'Gerar Código / URL' : 'Generate Code / URL'}</span>
            </button>
          )}

          {/* Copy Path */}
          <button
            onClick={() => {
              const target = file?.path || currentPath;
              navigator.clipboard.writeText(target);
              onClose();
            }}
            className="w-full text-left px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-dark-700 text-slate-700 dark:text-slate-300 hover:text-slate-950 dark:hover:text-slate-100 transition-colors"
          >
            {isPt ? 'Copiar Caminho Completo' : 'Copy Full Path'}
          </button>

          <div className="h-px bg-slate-200 dark:bg-dark-700 my-1" />

          {/* Move to Trash (Only when remote and remoteTrashEnabled is active) */}
          {file && isRemote && remoteTrashEnabled && onMoveToTrash && (
            <button
              onClick={() => {
                onMoveToTrash(effectiveTargets);
                onClose();
              }}
              className="w-full text-left px-3 py-1.5 hover:bg-amber-500/10 dark:hover:bg-amber-500/20 text-amber-700 dark:text-amber-400 hover:text-amber-900 dark:hover:text-amber-300 flex items-center space-x-2 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5 text-amber-500 dark:text-amber-400" />
              <span>
                {isPt ? 'Mover para Lixeira Remota' : 'Move to Remote Trash'}
                {effectiveTargets.length > 1 ? ` (${effectiveTargets.length})` : ''}
              </span>
            </button>
          )}

          {/* Delete / Quick Delete */}
          {file && (
            <button
              onClick={() => {
                onDelete(effectiveTargets, !remoteTrashEnabled);
                onClose();
              }}
              className="w-full text-left px-3 py-1.5 hover:bg-red-500/10 dark:hover:bg-red-500/20 text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300 flex items-center justify-between transition-colors"
            >
              <div className="flex items-center space-x-2">
                <Trash2 className="w-3.5 h-3.5 text-red-500" />
                <span>
                  {isRemote && !remoteTrashEnabled
                    ? (isPt ? 'Excluir' : 'Delete')
                    : (isPt ? 'Excluir Definitivamente' : 'Delete Permanently')}
                  {effectiveTargets.length > 1 ? ` (${effectiveTargets.length})` : ''}
                </span>
              </div>
              <span className="text-[10px] text-red-500 font-mono">
                {isMac
                  ? (isRemote && !remoteTrashEnabled ? '⌘⌫ / F8' : '⌥⌘⌫')
                  : (isRemote && !remoteTrashEnabled ? 'Del / F8' : 'Shift+Del')}
              </span>
            </button>
          )}
        </div>

        {/* Scroll Indicator: More items below */}
        {canScrollDown && (
          <div 
            onClick={() => {
              scrollContainerRef.current?.scrollBy({ top: 140, behavior: 'smooth' });
            }}
            className="shrink-0 flex items-center justify-center py-1 bg-gradient-to-t from-white via-white/95 to-white/20 dark:from-dark-800 dark:via-dark-800/95 dark:to-dark-800/20 text-slate-500 hover:text-rust-600 dark:text-slate-400 dark:hover:text-rust-400 cursor-pointer border-t border-slate-200/50 dark:border-dark-700/50 transition-colors z-20"
            title={isPt ? 'Clique ou role para ver itens abaixo' : 'Click or scroll to see items below'}
          >
            <div className="flex items-center space-x-1 px-2.5 py-0.5 rounded-full bg-slate-100 dark:bg-dark-700 border border-slate-200 dark:border-dark-600 shadow-2xs">
              <ChevronDown className="w-3 h-3 text-rust-500 animate-bounce" />
              <span className="text-[10px] font-semibold tracking-wider text-slate-700 dark:text-slate-300">
                {isPt ? 'Mais abaixo' : 'More below'}
              </span>
            </div>
          </div>
        )}
      </div>
    </>
  );
};
