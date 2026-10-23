import {
  Plus,
  RefreshCw,
  GitCompare,
  Link,
  Zap,
  Terminal,
  TerminalSquare,
  FileCode2,
  Search,
  HardDrive,
  Disc,
  Trash2,
  ShoppingBag,
  Code,
  Sparkles,
  Bot,
  Settings,
  Info,
  Sun,
  Moon,
  Monitor,
  Languages,
  Columns2,
  ListChecks,
  Share2,
  FileKey2,
} from 'lucide-react';
import type { PaletteCommand } from './components/CommandPalette.tsx';
import type { ThemeMode } from './theme.ts';

export interface PaletteActions {
  openSiteManager: () => void;
  shareConnection: () => void;
  openSharedConnection: () => void;
  compareDirectories: () => void;
  openSync: () => void;
  toggleSyncBrowsing: () => void;
  toggleContinuousSync: () => void;
  openNativeTerminal: () => void;
  openRemoteCommand: () => void;
  openScriptConsole: () => void;
  openFindFiles: () => void;
  openServerInfo: () => void;
  openVirtualDisk: () => void;
  openTrash: () => void;
  openMarketplace: () => void;
  openGenerateCode: () => void;
  openAiAssistant: () => void;
  openCommandStudio: () => void;
  openMcp: () => void;
  openSettings: () => void;
  openAbout: () => void;
  setTheme: (mode: ThemeMode) => void;
  setLanguage: (lng: 'pt-BR' | 'en-US') => void;
  toggleLayout: () => void;
  toggleTransfers: () => void;
  refresh: () => void;
  syncBrowsing: boolean;
  continuousSync: boolean;
  isDualPane: boolean;
  modKey: string;
}

const ic = 'w-4 h-4';

/** Every feature of the app, reachable from the ⌘K palette. */
export function buildPaletteCommands(a: PaletteActions, isPt: boolean): PaletteCommand[] {
  const L = (pt: string, en: string) => (isPt ? pt : en);
  const g = {
    conn: L('Conexões', 'Connections'),
    sync: L('Sincronização', 'Sync'),
    term: L('Terminal', 'Terminal'),
    tools: L('Ferramentas', 'Tools'),
    ai: L('IA & Automação', 'AI & Automation'),
    view: L('Visualização', 'View'),
    app: L('Aplicativo', 'App'),
  };
  const on = (v: boolean) => (v ? L(' (ativado)', ' (on)') : '');
  return [
    { id: 'connect', group: g.conn, label: L('Nova conexão…', 'New connection…'), icon: <Plus className={ic} />, keywords: 'site manager servidor ssh sftp ftp s3 login conectar connect', run: a.openSiteManager },
    { id: 'share', group: g.conn, label: L('Compartilhar esta conexão…', 'Share this connection…'), icon: <Share2 className={ic} />, keywords: 'share compartilhar suporte support enviar send arquivo file rustscp acesso access', run: a.shareConnection },
    { id: 'open-shared', group: g.conn, label: L('Abrir conexão compartilhada…', 'Open shared connection…'), icon: <FileKey2 className={ic} />, keywords: 'rustscp arquivo file importar import código code receber receive', run: a.openSharedConnection },
    { id: 'refresh', group: g.conn, label: L('Atualizar painel', 'Refresh pane'), icon: <RefreshCw className={ic} />, shortcut: `${a.modKey}R`, keywords: 'reload recarregar', run: a.refresh },

    { id: 'compare', group: g.sync, label: L('Comparar pastas', 'Compare folders'), icon: <GitCompare className={ic} />, shortcut: '⇧F2', keywords: 'diff diferenças', run: a.compareDirectories },
    { id: 'sync', group: g.sync, label: L('Sincronizar…', 'Synchronize…'), icon: <RefreshCw className={ic} />, keywords: 'assistente mirror espelhar upload download', run: a.openSync },
    { id: 'sync-browse', group: g.sync, label: L('Navegação sincronizada', 'Synchronized browsing') + on(a.syncBrowsing), icon: <Link className={ic} />, keywords: 'toggle', run: a.toggleSyncBrowsing },
    { id: 'live-sync', group: g.sync, label: L('Manter remoto atualizado', 'Keep remote up to date') + on(a.continuousSync), icon: <Zap className={ic} />, keywords: 'continuous live watch contínua', run: a.toggleContinuousSync },

    { id: 'native-term', group: g.term, label: L('Abrir no Terminal do sistema', 'Open in system Terminal'), icon: <Terminal className={ic} />, keywords: 'iterm shell native nativo', run: a.openNativeTerminal },
    { id: 'remote-cmd', group: g.term, label: L('Executar comando remoto…', 'Run remote command…'), icon: <TerminalSquare className={ic} />, keywords: 'ssh shell exec', run: a.openRemoteCommand },
    { id: 'script', group: g.term, label: L('Console de scripts', 'Scripting console'), icon: <FileCode2 className={ic} />, keywords: 'automação automation batch', run: a.openScriptConsole },

    { id: 'find', group: g.tools, label: L('Localizar arquivos…', 'Find files…'), icon: <Search className={ic} />, shortcut: '⇧F7', keywords: 'buscar search procurar', run: a.openFindFiles },
    { id: 'server-info', group: g.tools, label: L('Espaço em disco e servidor', 'Disk & server info'), icon: <HardDrive className={ic} />, keywords: 'df espaço filesystem', run: a.openServerInfo },
    { id: 'virtual-disk', group: g.tools, label: L('Montar como disco virtual…', 'Mount as virtual disk…'), icon: <Disc className={ic} />, keywords: 'webdav mount finder drive unidade', run: a.openVirtualDisk },
    { id: 'trash', group: g.tools, label: L('Lixeira remota', 'Remote trash'), icon: <Trash2 className={ic} />, keywords: 'restaurar restore', run: a.openTrash },
    { id: 'marketplace', group: g.tools, label: L('Marketplace SysAdmin', 'SysAdmin marketplace'), icon: <ShoppingBag className={ic} />, keywords: 'install instalar ferramentas tools', run: a.openMarketplace },
    { id: 'gen-code', group: g.tools, label: L('Gerar código e URL', 'Generate code & URL'), icon: <Code className={ic} />, keywords: 'script python bash url', run: a.openGenerateCode },

    { id: 'ai', group: g.ai, label: L('Assistente de IA', 'AI assistant'), icon: <Sparkles className={ic} />, keywords: 'ia ai rename renomear', run: a.openAiAssistant },
    { id: 'studio', group: g.ai, label: L('Smart Command Studio', 'Smart command studio'), icon: <Zap className={ic} />, keywords: 'ações actions linux comandos', run: a.openCommandStudio },
    { id: 'mcp', group: g.ai, label: L('Gateway MCP', 'MCP gateway'), icon: <Bot className={ic} />, keywords: 'agent agente claude cursor audit auditoria', run: a.openMcp },

    { id: 'layout', group: g.view, label: a.isDualPane ? L('Modo explorador (painel único)', 'Explorer mode (single pane)') : L('Modo commander (dois painéis)', 'Commander mode (dual pane)'), icon: <Columns2 className={ic} />, keywords: 'layout dual single painel pane', run: a.toggleLayout },
    { id: 'transfers', group: g.view, label: L('Mostrar/ocultar transferências', 'Show/hide transfers'), icon: <ListChecks className={ic} />, keywords: 'fila queue', run: a.toggleTransfers },
    { id: 'theme-system', group: g.view, label: L('Tema: automático', 'Theme: auto'), icon: <Monitor className={ic} />, keywords: 'appearance aparência sistema system', run: () => a.setTheme('system') },
    { id: 'theme-light', group: g.view, label: L('Tema: claro', 'Theme: light'), icon: <Sun className={ic} />, keywords: 'appearance aparência', run: () => a.setTheme('light') },
    { id: 'theme-dark', group: g.view, label: L('Tema: escuro', 'Theme: dark'), icon: <Moon className={ic} />, keywords: 'appearance aparência', run: () => a.setTheme('dark') },

    { id: 'settings', group: g.app, label: L('Configurações', 'Settings'), icon: <Settings className={ic} />, shortcut: `${a.modKey},`, keywords: 'preferências preferences ajustes', run: a.openSettings },
    { id: 'lang', group: g.app, label: isPt ? 'Switch language to English' : 'Mudar idioma para Português', icon: <Languages className={ic} />, keywords: 'idioma language português english', run: () => a.setLanguage(isPt ? 'en-US' : 'pt-BR') },
    { id: 'about', group: g.app, label: L('Sobre o RustSCP', 'About RustSCP'), icon: <Info className={ic} />, keywords: 'versão version build diagnóstico', run: a.openAbout },
  ];
}
