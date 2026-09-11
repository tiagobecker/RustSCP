import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { 
  X, 
  Settings, 
  Sun, 
  Moon, 
  Monitor, 
  Trash2, 
  FileCode, 
  Terminal,
  Save, 
  Check,
  Info
} from 'lucide-react';
import { ThemeMode } from '../theme.ts';

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
  onOpenRemoteTrashModal?: () => void;
  onOpenAbout?: () => void;
}

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
  onOpenRemoteTrashModal,
  onOpenAbout,
}) => {
  const { i18n } = useTranslation();
  const isPt = i18n.language.startsWith('pt');

  const [activeTab, setActiveTab] = useState<'general' | 'trash' | 'editor' | 'terminal'>('general');
  const [editorCmdInput, setEditorCmdInput] = useState<string>(externalEditorCmd || 'code');
  const [trashEnabled, setTrashEnabled] = useState<boolean>(isRemoteTrashEnabled);
  const [rememberLastDir, setRememberLastDir] = useState<boolean>(rememberLastRemoteDir);
  const [savedSuccess, setSavedSuccess] = useState<boolean>(false);

  useEffect(() => {
    if (isOpen) {
      setTrashEnabled(isRemoteTrashEnabled);
      setRememberLastDir(rememberLastRemoteDir);
      setEditorCmdInput(externalEditorCmd || 'code');
    }
  }, [isOpen, isRemoteTrashEnabled, rememberLastRemoteDir, externalEditorCmd]);

  if (!isOpen) return null;

  const handleLanguageChange = (lang: string) => {
    i18n.changeLanguage(lang);
  };

  const handleSaveAll = () => {
    onToggleRemoteTrash(trashEnabled);
    onToggleRememberLastRemoteDir(rememberLastDir);
    onSaveExternalEditorCmd(editorCmdInput);
    setSavedSuccess(true);
    setTimeout(() => {
      setSavedSuccess(false);
      onClose();
    }, 800);
  };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-3 animate-in fade-in duration-150">
      <div className="bg-white dark:bg-dark-800 border border-slate-300 dark:border-dark-600 rounded-xl shadow-2xl max-w-2xl w-full flex flex-col overflow-hidden text-slate-900 dark:text-slate-100">
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-slate-200 dark:border-dark-600 bg-slate-100 dark:bg-dark-750 flex items-center justify-between select-none shrink-0">
          <div className="flex items-center space-x-2.5">
            <div className="p-2 rounded-lg bg-rust-500/15 text-rust-600 dark:text-rust-400 border border-rust-500/30">
              <Settings className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
                {isPt ? 'Configurações do RustSCP' : 'RustSCP Settings'}
              </h3>
              <p className="text-xs text-slate-600 dark:text-slate-400">
                {isPt ? 'Personalize temas, lixeira remota, terminais e editores' : 'Configure themes, remote trash, terminals, and editors'}
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-slate-200 dark:hover:bg-dark-700 text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Sidebar & Content Layout */}
        <div className="flex flex-1 min-h-[380px] overflow-hidden">
          {/* Tabs Sidebar */}
          <div className="w-48 bg-slate-50 dark:bg-dark-850 border-r border-slate-200 dark:border-dark-600 p-2 space-y-1 select-none shrink-0">
            <button
              onClick={() => setActiveTab('general')}
              className={`w-full flex items-center space-x-2 px-3 py-2 rounded-lg text-xs font-semibold transition-colors ${
                activeTab === 'general'
                  ? 'bg-rust-600 text-white shadow-sm'
                  : 'text-slate-700 dark:text-slate-400 hover:text-slate-950 dark:hover:text-slate-200 hover:bg-slate-200/80 dark:hover:bg-dark-700'
              }`}
            >
              <Sun className="w-3.5 h-3.5" />
              <span>{isPt ? 'Geral & Tema' : 'General & Theme'}</span>
            </button>

            <button
              onClick={() => setActiveTab('trash')}
              className={`w-full flex items-center space-x-2 px-3 py-2 rounded-lg text-xs font-semibold transition-colors ${
                activeTab === 'trash'
                  ? 'bg-rust-600 text-white shadow-sm'
                  : 'text-slate-700 dark:text-slate-400 hover:text-slate-950 dark:hover:text-slate-200 hover:bg-slate-200/80 dark:hover:bg-dark-700'
              }`}
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>{isPt ? 'Lixeira Remota' : 'Remote Trash'}</span>
            </button>

            <button
              onClick={() => setActiveTab('editor')}
              className={`w-full flex items-center space-x-2 px-3 py-2 rounded-lg text-xs font-semibold transition-colors ${
                activeTab === 'editor'
                  ? 'bg-rust-600 text-white shadow-sm'
                  : 'text-slate-700 dark:text-slate-400 hover:text-slate-950 dark:hover:text-slate-200 hover:bg-slate-200/80 dark:hover:bg-dark-700'
              }`}
            >
              <FileCode className="w-3.5 h-3.5" />
              <span>{isPt ? 'Editor de Código' : 'Code Editor'}</span>
            </button>

            <button
              onClick={() => setActiveTab('terminal')}
              className={`w-full flex items-center space-x-2 px-3 py-2 rounded-lg text-xs font-semibold transition-colors ${
                activeTab === 'terminal'
                  ? 'bg-rust-600 text-white shadow-sm'
                  : 'text-slate-700 dark:text-slate-400 hover:text-slate-950 dark:hover:text-slate-200 hover:bg-slate-200/80 dark:hover:bg-dark-700'
              }`}
            >
              <Terminal className="w-3.5 h-3.5" />
              <span>{isPt ? 'Terminal Nativo' : 'Native Terminal'}</span>
            </button>

            {onOpenAbout && (
              <button
                onClick={onOpenAbout}
                className="w-full flex items-center space-x-2 px-3 py-2 rounded-lg text-xs font-semibold transition-colors text-slate-700 dark:text-slate-400 hover:text-slate-950 dark:hover:text-slate-200 hover:bg-slate-200/80 dark:hover:bg-dark-700 pt-2.5 border-t border-slate-200 dark:border-dark-700"
              >
                <Info className="w-3.5 h-3.5 text-rust-500" />
                <span>{isPt ? 'Sobre o RustSCP' : 'About RustSCP'}</span>
              </button>
            )}
          </div>

          {/* Tab Content */}
          <div className="flex-1 p-5 overflow-y-auto bg-white dark:bg-dark-900 text-xs">
            {/* Tab: General & Theme */}
            {activeTab === 'general' && (
              <div className="space-y-5">
                <div>
                  <h4 className="font-bold text-slate-900 dark:text-slate-100 text-sm mb-1">
                    {isPt ? 'Tema da Interface & Contraste' : 'Theme & Visual Contrast'}
                  </h4>
                  <p className="text-slate-600 dark:text-slate-400 mb-3">
                    {isPt 
                      ? 'Alterne entre o tema Claro de alto contraste e o tema Escuro calibrado com as cores da marca.'
                      : 'Switch between calibrated high-contrast Light mode and dark titanium brand palette.'}
                  </p>

                  <div className="grid grid-cols-3 gap-2">
                    {[
                      { id: 'system', label: isPt ? 'Automático' : 'System', icon: Monitor },
                      { id: 'light', label: isPt ? 'Claro (Light)' : 'Light Mode', icon: Sun },
                      { id: 'dark', label: isPt ? 'Escuro (Dark)' : 'Dark Mode', icon: Moon },
                    ].map((item) => {
                      const Icon = item.icon;
                      const isSelected = themeMode === item.id;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => onThemeChange(item.id as ThemeMode)}
                          className={`p-3 rounded-xl border flex flex-col items-center justify-center space-y-1.5 transition-all ${
                            isSelected
                              ? 'bg-rust-500/15 border-rust-500 text-rust-600 dark:text-rust-400 shadow-sm font-bold'
                              : 'bg-slate-50 dark:bg-dark-800 border-slate-200 dark:border-dark-600 text-slate-700 dark:text-slate-400 hover:text-slate-950 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-dark-700'
                          }`}
                        >
                          <Icon className="w-5 h-5" />
                          <span>{item.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="pt-4 border-t border-slate-200 dark:border-dark-700">
                  <h4 className="font-bold text-slate-900 dark:text-slate-100 text-sm mb-1">
                    {isPt ? 'Idioma da Interface' : 'Interface Language'}
                  </h4>
                  <p className="text-slate-600 dark:text-slate-400 mb-3">
                    {isPt 
                      ? 'Selecione o idioma padrão para a interface, diálogos e menus do aplicativo.'
                      : 'Select the default language for interface, dialogs, and menus.'}
                  </p>
                  <div className="grid grid-cols-2 gap-3 max-w-md">
                    <button
                      type="button"
                      onClick={() => handleLanguageChange('pt-BR')}
                      className={`p-3 rounded-xl border flex items-center space-x-2.5 transition-all ${
                        isPt 
                          ? 'bg-rust-500/15 border-rust-500 text-rust-600 dark:text-rust-400 shadow-sm font-bold' 
                          : 'bg-slate-50 dark:bg-dark-800 border-slate-200 dark:border-dark-600 text-slate-700 dark:text-slate-400 hover:text-slate-950 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-dark-700'
                      }`}
                    >
                      <span className="text-lg">🇧🇷</span>
                      <div className="text-left">
                        <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">Português</div>
                        <div className="text-[10px] text-slate-500 dark:text-slate-400">Brasil (pt-BR)</div>
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleLanguageChange('en-US')}
                      className={`p-3 rounded-xl border flex items-center space-x-2.5 transition-all ${
                        !isPt 
                          ? 'bg-rust-500/15 border-rust-500 text-rust-600 dark:text-rust-400 shadow-sm font-bold' 
                          : 'bg-slate-50 dark:bg-dark-800 border-slate-200 dark:border-dark-600 text-slate-700 dark:text-slate-400 hover:text-slate-950 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-dark-700'
                      }`}
                    >
                      <span className="text-lg">🇺🇸</span>
                      <div className="text-left">
                        <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">English</div>
                        <div className="text-[10px] text-slate-500 dark:text-slate-400">United States (en-US)</div>
                      </div>
                    </button>
                  </div>
                </div>

                {/* Remote Connections Navigation Setting */}
                <div className="pt-4 border-t border-slate-200 dark:border-dark-700">
                  <div className="bg-slate-50 dark:bg-dark-800 border border-slate-200 dark:border-dark-600 rounded-xl p-4">
                    <div className="flex items-center justify-between cursor-pointer" onClick={() => setRememberLastDir(!rememberLastDir)}>
                      <div>
                        <span className="font-semibold text-slate-900 dark:text-slate-100 block text-xs">
                          {isPt ? 'Lembrar Último Local Ativo da Conexão' : 'Remember Last Active Remote Directory'}
                        </span>
                        <span className="text-[11px] text-slate-500 dark:text-slate-400 block mt-0.5 max-w-sm">
                          {isPt
                            ? 'Ao desconectar ou fechar o app, memoriza a última pasta remota acessada nesta conexão e reabre nela por padrão. Se desativado, inicia sempre na raiz root/home do usuário.'
                            : 'Memorizes the last visited remote folder upon disconnect or app restart, resuming there by default. If disabled, always starts at the user root/home.'}
                        </span>
                      </div>

                      <div
                        className={`w-10 h-5 rounded-full transition-colors relative cursor-pointer shrink-0 ml-4 ${
                          rememberLastDir ? 'bg-rust-600' : 'bg-slate-300 dark:bg-dark-600'
                        }`}
                      >
                        <div
                          className={`w-4 h-4 rounded-full bg-white transition-transform absolute top-0.5 ${
                            rememberLastDir ? 'right-0.5' : 'left-0.5'
                          }`}
                        />
                      </div>
                    </div>
                  </div>
                </div>

                {onOpenAbout && (
                  <div className="pt-4 border-t border-slate-200 dark:border-dark-700 flex items-center justify-between bg-slate-50 dark:bg-dark-800/60 p-3 rounded-xl border border-slate-200 dark:border-dark-700">
                    <div className="flex items-center space-x-2.5">
                      <div className="p-1.5 rounded-lg bg-rust-500/15 text-rust-600 dark:text-rust-400">
                        <Info className="w-4 h-4" />
                      </div>
                      <div>
                        <div className="font-semibold text-slate-900 dark:text-slate-100">
                          {isPt ? 'Versionador & Diagnóstico' : 'Versioner & Diagnostics'}
                        </div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400">
                          {isPt ? 'Verifique data/hora de compilação e ID de build' : 'Check build timestamp and compilation ID'}
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={onOpenAbout}
                      className="px-3 py-1.5 rounded-lg bg-rust-600 hover:bg-rust-500 text-white text-xs font-semibold shadow-xs transition-colors cursor-pointer"
                    >
                      {isPt ? 'Ver Sobre' : 'View About'}
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Tab: Remote Trash */}
            {activeTab === 'trash' && (
              <div className="space-y-4">
                <div>
                  <h4 className="font-bold text-slate-900 dark:text-slate-100 text-sm mb-1">
                    {isPt ? 'Lixeira Remota Segura (Move-to-Trash)' : 'Secure Remote Trash Bin'}
                  </h4>
                  <p className="text-slate-600 dark:text-slate-400 leading-relaxed">
                    {isPt 
                      ? 'Por padrão, a exclusão remota é permanente. Ao ativar esta opção, o RustSCP moverá atomicamente os arquivos para ~/.local/share/Trash no servidor, permitindo restauração posterior sem requerer permissões de root.'
                      : 'By default, remote deletion is permanent. When enabled, RustSCP moves items atomically into ~/.local/share/Trash in user space.'}
                  </p>
                </div>

                <div className="bg-slate-50 dark:bg-dark-800 border border-slate-200 dark:border-dark-600 rounded-xl p-4 space-y-3">
                  <label className="flex items-center justify-between cursor-pointer">
                    <div>
                      <span className="font-semibold text-slate-900 dark:text-slate-200 block">
                        {isPt ? 'Mover para a Lixeira Remota ao excluir com F8 / Del' : 'Move to Remote Trash on delete (F8 / Del)'}
                      </span>
                      <span className="text-[11px] text-slate-500 dark:text-slate-400">
                        {isPt ? 'Substitui exclusão definitiva (rm) por movimento atômico' : 'Replaces permanent rm with atomic move'}
                      </span>
                    </div>

                    <div
                      onClick={() => setTrashEnabled(!trashEnabled)}
                      className={`w-10 h-5 rounded-full transition-colors relative cursor-pointer ${
                        trashEnabled ? 'bg-rust-600' : 'bg-slate-300 dark:bg-dark-600'
                      }`}
                    >
                      <div
                        className={`w-4 h-4 rounded-full bg-white transition-transform absolute top-0.5 ${
                          trashEnabled ? 'right-0.5' : 'left-0.5'
                        }`}
                      />
                    </div>
                  </label>

                  {onOpenRemoteTrashModal && (
                    <div className="pt-2 border-t border-slate-200 dark:border-dark-700/60 flex justify-end">
                      <button
                        type="button"
                        onClick={onOpenRemoteTrashModal}
                        className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-slate-200 hover:bg-slate-300 dark:bg-dark-700 dark:hover:bg-dark-600 text-slate-800 dark:text-slate-300 text-xs font-semibold border border-slate-300 dark:border-dark-600 transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5 text-rust-600 dark:text-rust-400" />
                        <span>{isPt ? 'Gerenciar Lixeira do Servidor Atual' : 'Open Remote Trash Manager'}</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Tab: Editor Settings */}
            {activeTab === 'editor' && (
              <div className="space-y-4">
                <div>
                  <h4 className="font-bold text-slate-900 dark:text-slate-100 text-sm mb-1">
                    {isPt ? 'Editor de Código RustSCP & Externo' : 'RustSCP Code Editor & External'}
                  </h4>
                  <p className="text-slate-600 dark:text-slate-400">
                    {isPt 
                      ? 'O RustSCP possui o editor interno modular "RustSCP Editor" com suporte a multi-abas e sintaxe para mais de 15 linguagens. Você também pode configurar um editor externo como preferência.'
                      : 'RustSCP includes the embedded multi-tab "RustSCP Editor". You can also configure an external editor.'}
                  </p>
                </div>

                <div className="bg-slate-50 dark:bg-dark-800 border border-slate-200 dark:border-dark-600 rounded-xl p-4 space-y-3">
                  <label className="block font-semibold text-slate-800 dark:text-slate-200">
                    {isPt ? 'Comando / Executável do Editor Externo:' : 'External Editor Command / Executable:'}
                  </label>
                  <div className="flex items-center space-x-2">
                    <input
                      type="text"
                      value={editorCmdInput}
                      onChange={(e) => setEditorCmdInput(e.target.value)}
                      placeholder="code, cursor, subl, notepad++"
                      className="flex-1 bg-white dark:bg-dark-900 border border-slate-300 dark:border-dark-600 rounded-lg px-3 py-1.5 text-slate-900 dark:text-slate-100 font-mono text-xs focus:outline-none focus:border-rust-500 shadow-sm"
                    />
                  </div>
                  <div className="flex flex-wrap gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                    <span>{isPt ? 'Exemplos comuns:' : 'Common examples:'}</span>
                    <button type="button" onClick={() => setEditorCmdInput('code')} className="underline hover:text-slate-900 dark:hover:text-slate-200">code (VS Code)</button>
                    <button type="button" onClick={() => setEditorCmdInput('cursor')} className="underline hover:text-slate-900 dark:hover:text-slate-200">cursor</button>
                    <button type="button" onClick={() => setEditorCmdInput('subl')} className="underline hover:text-slate-900 dark:hover:text-slate-200">subl (Sublime)</button>
                  </div>
                </div>
              </div>
            )}

            {/* Tab: Terminal Settings */}
            {activeTab === 'terminal' && (
              <div className="space-y-4">
                <div>
                  <h4 className="font-bold text-slate-900 dark:text-slate-100 text-sm mb-1">
                    {isPt ? 'Terminal Nativo da Plataforma' : 'Native Platform Terminal'}
                  </h4>
                  <p className="text-slate-600 dark:text-slate-400 leading-relaxed">
                    {isPt 
                      ? 'O RustSCP abre o terminal nativo do seu sistema operacional (macOS Terminal/iTerm, Windows Terminal/PowerShell, GNOME Terminal) com a conexão SSH e a pasta atual já inicializadas.'
                      : 'RustSCP opens your OS native terminal with current SSH connection and directory pre-loaded.'}
                  </p>
                </div>

                <div className="bg-slate-50 dark:bg-dark-800 border border-slate-200 dark:border-dark-600 rounded-xl p-4 space-y-2 text-slate-700 dark:text-slate-300">
                  <div className="flex items-center space-x-2">
                    <Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                    <span>macOS: Terminal.app / iTerm2</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                    <span>Windows: Windows Terminal (wt.exe), PowerShell, cmd.exe</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                    <span>Linux: x-terminal-emulator, gnome-terminal, konsole, alacritty, kitty</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-200 dark:border-dark-600 bg-slate-100 dark:bg-dark-750 flex items-center justify-end space-x-2 select-none shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg bg-slate-200 hover:bg-slate-300 dark:bg-dark-700 dark:hover:bg-dark-600 text-slate-700 dark:text-slate-300 text-xs font-semibold border border-slate-300 dark:border-dark-600 transition-colors"
          >
            {isPt ? 'Cancelar' : 'Cancel'}
          </button>
          <button
            type="button"
            onClick={handleSaveAll}
            className="flex items-center space-x-1.5 px-4 py-2 rounded-lg bg-rust-600 hover:bg-rust-500 text-white text-xs font-bold transition-all shadow-md"
          >
            {savedSuccess ? <Check className="w-3.5 h-3.5" /> : <Save className="w-3.5 h-3.5" />}
            <span>{savedSuccess ? (isPt ? 'Salvo!' : 'Saved!') : (isPt ? 'Salvar Configurações' : 'Save Settings')}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
