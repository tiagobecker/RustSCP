import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Settings2, Sun, Moon, Monitor, Trash2, SlidersHorizontal, Info, Check, ChevronRight } from 'lucide-react';
import { ThemeMode } from '../theme.ts';
import { Modal } from './ui/Modal.tsx';
import { Segmented, SettingsGroup, SettingsRow, TextInput, Toggle, Button } from './ui/controls.tsx';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  themeMode: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
  isRemoteTrashEnabled: boolean;
  onToggleRemoteTrash: (enabled: boolean) => void;
  rememberLastRemoteDir: boolean;
  onToggleRememberLastRemoteDir: (enabled: boolean) => void;
  externalEditorCmd: string;
  onSaveExternalEditorCmd: (cmd: string) => void;
  /** Edit / F4 / double-click open the external editor instead of the built-in one */
  preferExternalEditor?: boolean;
  onTogglePreferExternalEditor?: (enabled: boolean) => void;
  onOpenRemoteTrashModal?: () => void;
  onOpenAbout?: () => void;
}

type Section = 'general' | 'files' | 'advanced';

const EDITOR_PRESETS = [
  { cmd: 'code', label: 'VS Code' },
  { cmd: 'cursor', label: 'Cursor' },
  { cmd: 'subl', label: 'Sublime Text' },
  { cmd: 'zed', label: 'Zed' },
];

/**
 * System-Settings-style preferences. Every change applies immediately (no Save step);
 * power-user options live under "Advanced".
 */
export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  themeMode,
  onThemeChange,
  isRemoteTrashEnabled,
  onToggleRemoteTrash,
  rememberLastRemoteDir,
  onToggleRememberLastRemoteDir,
  externalEditorCmd,
  onSaveExternalEditorCmd,
  preferExternalEditor = false,
  onTogglePreferExternalEditor,
  onOpenRemoteTrashModal,
  onOpenAbout,
}) => {
  const { t, i18n } = useTranslation();
  const [section, setSection] = useState<Section>('general');
  const [editorCmd, setEditorCmd] = useState(externalEditorCmd || '');
  const [editorSaved, setEditorSaved] = useState(false);

  useEffect(() => {
    if (isOpen) setEditorCmd(externalEditorCmd || '');
  }, [isOpen, externalEditorCmd]);

  const commitEditorCmd = (value: string) => {
    const v = value.trim();
    if (v === (externalEditorCmd || '').trim()) return;
    onSaveExternalEditorCmd(v);
    setEditorSaved(true);
    setTimeout(() => setEditorSaved(false), 1500);
  };

  const lang = i18n.language.startsWith('pt') ? 'pt-BR' : 'en-US';

  const nav: Array<{ id: Section; label: string; icon: React.ReactNode }> = [
    { id: 'general', label: t('settings.general', 'General'), icon: <Settings2 className="w-4 h-4" /> },
    { id: 'files', label: t('settings.filesTransfers', 'Files & deletion'), icon: <Trash2 className="w-4 h-4" /> },
    { id: 'advanced', label: t('settings.advanced', 'Advanced'), icon: <SlidersHorizontal className="w-4 h-4" /> },
  ];

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="2xl" padded={false} className="h-[min(560px,calc(100vh-2rem))]">
      <div className="flex h-full min-h-0">
        {/* Sidebar */}
        <aside className="w-52 shrink-0 bg-dark-850 border-r border-line p-3 flex flex-col select-none">
          <div className="px-2 pt-1 pb-3 text-[15px] font-semibold text-ink">{t('settings.title', 'Settings')}</div>
          <nav className="space-y-0.5 flex-1">
            {nav.map((n) => (
              <button
                key={n.id}
                type="button"
                onClick={() => setSection(n.id)}
                aria-current={section === n.id ? 'page' : undefined}
                className={`w-full flex items-center gap-2.5 px-2.5 h-8 rounded-lg text-[13px] transition-colors ${
                  section === n.id ? 'bg-dark-650 text-ink font-medium' : 'text-ink-muted hover:text-ink hover:bg-dark-650/50'
                }`}
              >
                <span className={section === n.id ? 'text-rust-500' : ''}>{n.icon}</span>
                {n.label}
              </button>
            ))}
          </nav>
          {onOpenAbout && (
            <button
              type="button"
              onClick={onOpenAbout}
              className="w-full flex items-center gap-2.5 px-2.5 h-8 rounded-lg text-[13px] text-ink-muted hover:text-ink hover:bg-dark-650/50 transition-colors"
            >
              <Info className="w-4 h-4" />
              {t('settings.about', 'About RustSCP')}
            </button>
          )}
        </aside>

        {/* Content */}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="flex-1 overflow-y-auto px-7 pt-6 pb-6 space-y-6">
            {section === 'general' && (
              <>
                <SettingsGroup title={t('settings.appearance', 'Appearance')}>
                  <SettingsRow label={t('settings.theme', 'Theme')}>
                    <Segmented<ThemeMode>
                      ariaLabel={t('settings.theme', 'Theme')}
                      value={themeMode}
                      onChange={onThemeChange}
                      options={[
                        { value: 'system', label: t('settings.themeSystem', 'Auto'), icon: <Monitor className="w-3.5 h-3.5" /> },
                        { value: 'light', label: t('settings.themeLight', 'Light'), icon: <Sun className="w-3.5 h-3.5" /> },
                        { value: 'dark', label: t('settings.themeDark', 'Dark'), icon: <Moon className="w-3.5 h-3.5" /> },
                      ]}
                    />
                  </SettingsRow>
                  <SettingsRow label={t('settings.language', 'Language')}>
                    <Segmented
                      ariaLabel={t('settings.language', 'Language')}
                      value={lang}
                      onChange={(v) => i18n.changeLanguage(v)}
                      options={[
                        { value: 'pt-BR', label: 'Português' },
                        { value: 'en-US', label: 'English' },
                      ]}
                    />
                  </SettingsRow>
                </SettingsGroup>

                <SettingsGroup
                  title={t('settings.connections', 'Connections')}
                  footer={t(
                    'settings.rememberDirHelp',
                    'When off, every connection opens in the configured initial folder or the user home.'
                  )}
                >
                  <SettingsRow
                    label={t('settings.rememberDir', 'Reopen the last remote folder')}
                    description={t('settings.rememberDirDesc', 'Resume where you left off on each server.')}
                  >
                    <Toggle
                      checked={rememberLastRemoteDir}
                      onChange={onToggleRememberLastRemoteDir}
                      label={t('settings.rememberDir', 'Reopen the last remote folder')}
                    />
                  </SettingsRow>
                </SettingsGroup>
              </>
            )}

            {section === 'files' && (
              <SettingsGroup
                title={t('settings.deletion', 'Deleting remote files')}
                footer={t(
                  'settings.remoteTrashHelp',
                  'Items are moved to ~/.local/share/Trash on the server, so they can be restored. When off, deletion is permanent (rm -rf).'
                )}
              >
                <SettingsRow
                  label={t('settings.useRemoteTrash', 'Move to remote trash instead of deleting')}
                  description={t('settings.useRemoteTrashDesc', 'Applies to Delete / F8 on remote servers.')}
                >
                  <Toggle
                    checked={isRemoteTrashEnabled}
                    onChange={onToggleRemoteTrash}
                    label={t('settings.useRemoteTrash', 'Move to remote trash instead of deleting')}
                  />
                </SettingsRow>
                {onOpenRemoteTrashModal && (
                  <SettingsRow label={t('settings.manageTrash', 'Manage remote trash…')} onClick={onOpenRemoteTrashModal}>
                    <ChevronRight className="w-4 h-4 text-ink-faint" />
                  </SettingsRow>
                )}
              </SettingsGroup>
            )}

            {section === 'advanced' && (
              <>
                <SettingsGroup
                  title={t('settings.externalEditor', 'External editor')}
                  footer={t('settings.externalEditorHelp', 'Command used by “Open in external editor”. Leave empty to use the system default.')}
                >
                  <SettingsRow label={t('settings.editorCommand', 'Editor command')} stacked>
                    <div className="flex items-center gap-2">
                      <TextInput
                        mono
                        value={editorCmd}
                        onChange={(e) => setEditorCmd(e.target.value)}
                        onBlur={(e) => commitEditorCmd(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitEditorCmd((e.target as HTMLInputElement).value);
                        }}
                        placeholder="code"
                        aria-label={t('settings.editorCommand', 'Editor command')}
                      />
                      {editorSaved && <Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {EDITOR_PRESETS.map((p) => (
                        <Button
                          key={p.cmd}
                          size="sm"
                          variant={editorCmd.trim() === p.cmd ? 'primary' : 'secondary'}
                          onClick={() => {
                            setEditorCmd(p.cmd);
                            commitEditorCmd(p.cmd);
                          }}
                        >
                          {p.label}
                        </Button>
                      ))}
                    </div>
                  </SettingsRow>
                  {onTogglePreferExternalEditor && (
                    <SettingsRow
                      label={t('settings.preferExternalEditor', 'Open files in the external editor')}
                      description={t('settings.preferExternalEditorDesc', 'Edit, F4 and double-click use it instead of the built-in editor.')}
                    >
                      <Toggle
                        checked={preferExternalEditor}
                        onChange={onTogglePreferExternalEditor}
                        label={t('settings.preferExternalEditor', 'Open files in the external editor')}
                      />
                    </SettingsRow>
                  )}
                </SettingsGroup>

                <SettingsGroup
                  title={t('settings.nativeTerminal', 'System terminal')}
                  footer={t(
                    'settings.nativeTerminalHelp',
                    '“Open in system Terminal” starts your OS terminal with the current SSH session and folder.'
                  )}
                >
                  <SettingsRow label="macOS" description="Terminal.app, iTerm2" />
                  <SettingsRow label="Windows" description="Windows Terminal, PowerShell, cmd.exe" />
                  <SettingsRow label="Linux" description="x-terminal-emulator, GNOME Terminal, Konsole, Alacritty, kitty" />
                </SettingsGroup>
              </>
            )}
          </div>
          <div className="flex items-center justify-end px-5 py-3 border-t border-line shrink-0">
            <Button variant="primary" onClick={onClose}>
              {t('settings.done', 'Done')}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
};
