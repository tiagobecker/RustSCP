import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  Plus,
  RefreshCw,
  TerminalSquare,
  Search,
  Code,
  HardDrive,
  GitCompare,
  Link,
  Zap,
  Bot,
  Disc,
  Terminal,
  Sparkles,
  ShoppingBag,
  Trash2,
  Settings,
  LayoutGrid,
  ChevronDown,
  FileCode2,
  SquareTerminal,
  PanelBottom,
} from 'lucide-react';
import { McpStatusInfo } from '../types.ts';
import { ThemeMode } from '../theme.ts';
import { Menu, MenuItem, MenuLabel, MenuSeparator, MenuToggleItem } from './ui/Menu.tsx';

interface HeaderProps {
  onOpenSiteManager: () => void;
  onOpenSync: () => void;
  onOpenRemoteCommand: () => void;
  onOpenActions: () => void;
  onOpenMcp: () => void;
  onOpenAiAssistant?: () => void;
  onOpenFindFiles: () => void;
  onOpenScriptConsole: () => void;
  onOpenGenerateCode: () => void;
  onOpenServerInfo: () => void;
  onOpenVirtualDisk: () => void;
  onOpenMarketplace: () => void;
  onOpenTrash: () => void;
  onOpenNativeTerminal: () => void;
  /** Opens a built-in terminal on the focused SSH session. */
  onNewTerminal?: () => void;
  /** Shows the terminal panel. */
  onShowTerminals?: () => void;
  terminalBadge?: { count: number; running: number; attention: boolean };
  onOpenSettings?: () => void;
  onOpenCommandPalette?: () => void;
  remoteTrashEnabled?: boolean;
  onCompareDirectories: () => void;
  syncBrowsing: boolean;
  onToggleSyncBrowsing: () => void;
  continuousSync: boolean;
  onToggleContinuousSync: () => void;
  mcpStatus?: McpStatusInfo | null;
  activeTransferCount?: number;
  totalSpeedBps?: number;
  onToggleTransferDrawer?: () => void;
  themeMode?: ThemeMode;
  onThemeChange?: (mode: ThemeMode) => void;
  onOpenAbout?: () => void;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD_KEY = isMac ? '⌘' : 'Ctrl+';

const ToolbarButton = React.forwardRef<
  HTMLButtonElement,
  { icon: React.ReactNode; label: string; open?: boolean; active?: boolean; onClick: () => void; badge?: boolean | 'attention' }
>(({ icon, label, open, active, onClick, badge }, ref) => (
  <button
    ref={ref}
    type="button"
    onClick={onClick}
    title={label}
    aria-label={label}
    aria-haspopup="menu"
    aria-expanded={open}
    className={`relative inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-[13px] font-medium transition-colors ${
      open || active ? 'bg-dark-650/80 text-ink' : 'text-ink-muted hover:text-ink hover:bg-dark-650/60'
    }`}
  >
    <span className="w-4 h-4 flex items-center justify-center">{icon}</span>
    <span className="hidden xl:inline">{label}</span>
    <ChevronDown className="w-3 h-3 opacity-60 hidden xl:inline" />
    {badge && (
      <span
        className={`absolute top-1.5 left-6 w-1.5 h-1.5 rounded-full ring-2 ring-surface-raised ${badge === 'attention' ? 'bg-rust-500' : 'bg-emerald-500'}`}
      />
    )}
  </button>
));
ToolbarButton.displayName = 'ToolbarButton';

export const Header: React.FC<HeaderProps> = ({
  onOpenSiteManager,
  onOpenSync,
  onOpenRemoteCommand,
  onOpenActions,
  onOpenMcp,
  onOpenAiAssistant,
  onOpenFindFiles,
  onOpenScriptConsole,
  onOpenGenerateCode,
  onOpenServerInfo,
  onOpenVirtualDisk,
  onOpenMarketplace,
  onOpenTrash,
  onOpenNativeTerminal,
  onNewTerminal,
  onShowTerminals,
  terminalBadge,
  onOpenSettings,
  onOpenCommandPalette,
  remoteTrashEnabled,
  onCompareDirectories,
  syncBrowsing,
  onToggleSyncBrowsing,
  continuousSync,
  onToggleContinuousSync,
  mcpStatus,
}) => {
  const { t } = useTranslation();
  const iconCls = 'w-4 h-4';

  return (
    <header className="h-12 shrink-0 bg-dark-850 border-b border-line px-3 flex items-center gap-3 select-none relative z-30">
      {/* Left: brand + primary action */}
      <div className="flex items-center gap-2.5 min-w-0">
        <img src="/icon.png" alt="" className="w-6 h-6 object-contain" draggable={false} />
        <span className="text-[13.5px] font-semibold tracking-tight text-ink hidden md:inline">RustSCP</span>
        <button
          type="button"
          onClick={onOpenSiteManager}
          className="ui-btn ui-btn-primary ui-btn-sm ml-1"
          title={t('header.connectHint', 'Open Site Manager to connect to a server')}
        >
          <Plus className="w-3.5 h-3.5" />
          <span>{t('header.connect', 'Connect')}</span>
        </button>
      </div>

      {/* Center: command search */}
      <div className="flex-1 flex justify-center min-w-0">
        <button
          type="button"
          onClick={onOpenCommandPalette}
          className="w-full max-w-[380px] h-8 inline-flex items-center gap-2 px-3 rounded-lg border border-line bg-surface-raised/70 text-[13px] text-ink-faint hover:text-ink-muted hover:border-line-strong transition-colors"
          title={t('header.searchHint', 'Search every tool, action and setting')}
        >
          <Search className="w-3.5 h-3.5 shrink-0" />
          <span className="flex-1 text-left truncate">{t('header.search', 'Search tools and actions…')}</span>
          <span className="text-[11px] tabular-nums shrink-0">{MOD_KEY}K</span>
        </button>
      </div>

      {/* Right: grouped tools */}
      <nav className="flex items-center gap-0.5" aria-label={t('header.toolbar', 'Toolbar')}>
        <Menu
          align="right"
          width="w-72"
          trigger={({ open, toggle, ref }) => (
            <ToolbarButton
              ref={ref}
              icon={<RefreshCw className={iconCls} />}
              label={t('header.sync', 'Sync')}
              open={open}
              onClick={toggle}
              badge={syncBrowsing || continuousSync}
            />
          )}
        >
          {(close) => (
            <>
              <MenuItem
                icon={<GitCompare className={iconCls} />}
                label={t('header.compareDirs', 'Compare folders')}
                shortcut="⇧F2"
                onSelect={onCompareDirectories}
                close={close}
              />
              <MenuItem icon={<RefreshCw className={iconCls} />} label={t('header.syncAssistant', 'Synchronize…')} onSelect={onOpenSync} close={close} />
              <MenuSeparator />
              <MenuToggleItem
                icon={<Link className={iconCls} />}
                label={t('header.syncBrowsing', 'Synchronized browsing')}
                checked={syncBrowsing}
                onToggle={onToggleSyncBrowsing}
              />
              <MenuToggleItem
                icon={<Zap className={iconCls} />}
                label={t('header.keepUpToDate', 'Keep remote up to date')}
                checked={continuousSync}
                onToggle={onToggleContinuousSync}
              />
            </>
          )}
        </Menu>

        <Menu
          align="right"
          width="w-72"
          trigger={({ open, toggle, ref }) => (
            <ToolbarButton
              ref={ref}
              icon={<Terminal className={iconCls} />}
              label={t('header.terminal', 'Terminal')}
              open={open}
              onClick={toggle}
              badge={terminalBadge?.attention ? 'attention' : (terminalBadge?.running ?? 0) > 0}
            />
          )}
        >
          {(close) => (
            <>
              {onNewTerminal && (
                <MenuItem icon={<SquareTerminal className={iconCls} />} label={t('header.newTerminal', 'New terminal')} shortcut="Ctrl+⇧`" onSelect={onNewTerminal} close={close} />
              )}
              {onShowTerminals && (terminalBadge?.count ?? 0) > 0 && (
                <MenuItem
                  icon={<PanelBottom className={iconCls} />}
                  label={t('header.showTerminals', 'Show terminals')}
                  hint={
                    <span className="text-[11px] text-ink-faint tabular-nums">
                      {terminalBadge!.running > 0 ? `${terminalBadge!.running}/${terminalBadge!.count}` : terminalBadge!.count}
                    </span>
                  }
                  shortcut="Ctrl+`"
                  onSelect={onShowTerminals}
                  close={close}
                />
              )}
              <MenuSeparator />
              <MenuItem
                icon={<Terminal className={iconCls} />}
                label={t('header.nativeTerminal', 'Open in system Terminal')}
                onSelect={onOpenNativeTerminal}
                close={close}
              />
              <MenuItem
                icon={<TerminalSquare className={iconCls} />}
                label={t('header.remoteShell', 'Run remote command…')}
                onSelect={onOpenRemoteCommand}
                close={close}
              />
              <MenuItem
                icon={<FileCode2 className={iconCls} />}
                label={t('header.scriptConsole', 'Scripting console')}
                onSelect={onOpenScriptConsole}
                close={close}
              />
            </>
          )}
        </Menu>

        <Menu
          align="right"
          width="w-72"
          trigger={({ open, toggle, ref }) => (
            <ToolbarButton ref={ref} icon={<LayoutGrid className={iconCls} />} label={t('header.tools', 'Tools')} open={open} onClick={toggle} />
          )}
        >
          {(close) => (
            <>
              <MenuItem icon={<Search className={iconCls} />} label={t('header.findFiles', 'Find files…')} shortcut="⇧F7" onSelect={onOpenFindFiles} close={close} />
              <MenuItem icon={<HardDrive className={iconCls} />} label={t('header.serverInfo', 'Disk & server info')} onSelect={onOpenServerInfo} close={close} />
              <MenuItem icon={<Disc className={iconCls} />} label={t('header.virtualDisk', 'Mount as virtual disk…')} onSelect={onOpenVirtualDisk} close={close} />
              <MenuItem
                icon={<Trash2 className={iconCls} />}
                label={t('header.remoteTrash', 'Remote trash')}
                hint={remoteTrashEnabled ? <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" title={t('header.enabled', 'Enabled')} /> : undefined}
                onSelect={onOpenTrash}
                close={close}
              />
              <MenuSeparator />
              <MenuLabel>{t('header.advanced', 'Advanced')}</MenuLabel>
              <MenuItem icon={<ShoppingBag className={iconCls} />} label={t('header.marketplace', 'SysAdmin marketplace')} onSelect={onOpenMarketplace} close={close} />
              <MenuItem icon={<Code className={iconCls} />} label={t('header.generateCode', 'Generate code & URL')} onSelect={onOpenGenerateCode} close={close} />
            </>
          )}
        </Menu>

        <Menu
          align="right"
          width="w-72"
          trigger={({ open, toggle, ref }) => (
            <ToolbarButton ref={ref} icon={<Sparkles className={iconCls} />} label={t('header.ai', 'AI')} open={open} onClick={toggle} />
          )}
        >
          {(close) => (
            <>
              {onOpenAiAssistant && (
                <MenuItem icon={<Sparkles className={iconCls} />} label={t('header.aiAssistant', 'AI assistant')} onSelect={onOpenAiAssistant} close={close} />
              )}
              <MenuItem icon={<Zap className={iconCls} />} label={t('header.commandStudio', 'Smart command studio')} onSelect={onOpenActions} close={close} />
              <MenuItem
                icon={<Bot className={iconCls} />}
                label={t('header.mcpGateway', 'MCP gateway')}
                hint={
                  mcpStatus && mcpStatus.total_audit_events > 0 ? (
                    <span className="text-[11px] text-ink-faint tabular-nums">{mcpStatus.total_audit_events}</span>
                  ) : undefined
                }
                onSelect={onOpenMcp}
                close={close}
              />
            </>
          )}
        </Menu>

        <div className="w-px h-5 bg-line mx-1.5" />

        {onOpenSettings && (
          <button
            type="button"
            onClick={onOpenSettings}
            title={`${t('header.settings', 'Settings')} (${MOD_KEY},)`}
            aria-label={t('header.settings', 'Settings')}
            className="ui-icon-btn"
          >
            <Settings className={iconCls} />
          </button>
        )}
      </nav>
    </header>
  );
};
