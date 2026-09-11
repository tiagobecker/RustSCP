import React, { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { 
  X, 
  Terminal, 
  Copy, 
  Play, 
  AlertTriangle, 
  ShieldCheck, 
  Check, 
  Plus, 
  Trash2, 
  Save, 
  Search, 
  Code2
} from 'lucide-react';
import { ActionDefinition, RiskLevel, Scope } from '../types.ts';

interface CommandStudioModalProps {
  isOpen: boolean;
  onClose: () => void;
  actions: ActionDefinition[];
  selectedPaths: string[];
  currentDir: string;
  isRemote: boolean;
  onExecute: (command: string) => Promise<{ stdout: string; stderr: string; exit_code: number }>;
  onSaveCustomAction?: (action: ActionDefinition) => Promise<void>;
  onDeleteCustomAction?: (actionId: string) => Promise<void>;
}

export const CommandStudioModal: React.FC<CommandStudioModalProps> = ({
  isOpen,
  onClose,
  actions,
  selectedPaths,
  currentDir,
  isRemote,
  onExecute,
  onSaveCustomAction,
  onDeleteCustomAction,
}) => {
  const { i18n } = useTranslation();
  const isPt = i18n.language.startsWith('pt');
  const lang = isPt ? 'pt-BR' : 'en-US';

  const [activeTab, setActiveTab] = useState<'run' | 'create'>('run');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [selectedActionId, setSelectedActionId] = useState<string>('');
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [commandPreview, setCommandPreview] = useState<string>('');
  const [outputConsole, setOutputConsole] = useState<string>('');
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);

  // Custom Action Creator Form State
  const [editingActionId, setEditingActionId] = useState<string | null>(null);
  const [customNamePt, setCustomNamePt] = useState<string>('');
  const [customNameEn, setCustomNameEn] = useState<string>('');
  const [customDescPt, setCustomDescPt] = useState<string>('');
  const [customDescEn, setCustomDescEn] = useState<string>('');
  const [customCategory, setCustomCategory] = useState<string>('custom');
  const [customRisk, setCustomRisk] = useState<RiskLevel>('safe');
  const [customScope, setCustomScope] = useState<Scope>('selected_files');
  const [customTemplate, setCustomTemplate] = useState<string>('');
  const [isSavingCustom, setIsSavingCustom] = useState<boolean>(false);
  const [confirmDeleteActionId, setConfirmDeleteActionId] = useState<string | null>(null);

  useEffect(() => {
    if (actions.length > 0 && !selectedActionId) {
      setSelectedActionId(actions[0].id);
    }
  }, [actions, selectedActionId]);

  const activeAction = useMemo(() => {
    return actions.find((a) => a.id === selectedActionId) || actions[0];
  }, [actions, selectedActionId]);

  // Categories list
  const categories = useMemo(() => {
    const cats = new Set<string>();
    actions.forEach((a) => cats.add(a.category));
    return ['all', ...Array.from(cats)];
  }, [actions]);

  // Filtered actions
  const filteredActions = useMemo(() => {
    return actions.filter((a) => {
      const matchCat = selectedCategory === 'all' || a.category === selectedCategory;
      const name = a.name[lang] || a.name['pt-BR'] || a.id;
      const desc = a.description[lang] || a.description['pt-BR'] || '';
      const matchQuery = !searchQuery || 
        name.toLowerCase().includes(searchQuery.toLowerCase()) || 
        desc.toLowerCase().includes(searchQuery.toLowerCase()) ||
        a.template.toLowerCase().includes(searchQuery.toLowerCase());
      return matchCat && matchQuery;
    });
  }, [actions, selectedCategory, searchQuery, lang]);

  // Reset/populate fields when active action changes
  useEffect(() => {
    if (!activeAction) return;
    const initial: Record<string, string> = {};
    for (const field of activeAction.fields || []) {
      if (field.default_value) {
        let def = field.default_value;
        const firstName = selectedPaths[0]?.split('/').pop()?.split('\\').pop() || 'item';
        def = def.replace('${selected_first_name}', firstName);
        initial[field.id] = def;
      } else if (field.kind === 'checkbox') {
        initial[field.id] = 'false';
      } else {
        initial[field.id] = '';
      }
    }
    setFieldValues(initial);
  }, [activeAction, selectedPaths]);

  // Compute live command preview with variables substitution
  useEffect(() => {
    if (!activeAction) return;
    let cmd = activeAction.template;

    const quotedFiles = selectedPaths.length > 0 
      ? selectedPaths.map((p) => `'${p.replace(/'/g, "'\\''")}'`).join(' ') 
      : "''";
    const firstFull = selectedPaths[0] || '';
    const firstName = firstFull.split('/').pop()?.split('\\').pop() || 'item';
    const firstStem = firstName.includes('.') ? firstName.substring(0, firstName.lastIndexOf('.')) : firstName;
    const firstExt = firstName.includes('.') ? firstName.substring(firstName.lastIndexOf('.') + 1) : '';

    cmd = cmd.replace(/\$\{selected_files\}/g, quotedFiles);
    cmd = cmd.replace(/\$\{selected_dir\}/g, `'${currentDir.replace(/'/g, "'\\''")}'`);
    cmd = cmd.replace(/\$\{current_dir\}/g, `'${currentDir.replace(/'/g, "'\\''")}'`);
    cmd = cmd.replace(/\$\{selected_file\}/g, `'${firstFull.replace(/'/g, "'\\''")}'`);
    cmd = cmd.replace(/\$\{selected_first_name\}/g, firstName);
    cmd = cmd.replace(/\$\{selected_name\}/g, firstName);
    cmd = cmd.replace(/\$\{selected_stem\}/g, firstStem);
    cmd = cmd.replace(/\$\{selected_ext\}/g, firstExt);

    for (const field of activeAction.fields || []) {
      const val = fieldValues[field.id] !== undefined ? fieldValues[field.id] : (field.default_value || '');
      const regex = new RegExp(`\\{\\{${field.id}\\}\\}`, 'g');
      if (field.kind === 'checkbox') {
        cmd = cmd.replace(regex, val === 'true' ? 'true' : 'false');
      } else {
        cmd = cmd.replace(regex, `'${val.replace(/'/g, "'\\''")}'`);
      }
    }
    cmd = cmd.replace(/\{%.*?%\}/g, '');
    setCommandPreview(cmd.trim());
  }, [activeAction, fieldValues, selectedPaths, currentDir]);

  if (!isOpen) return null;

  const handleFieldChange = (fieldId: string, value: string) => {
    setFieldValues((prev) => ({ ...prev, [fieldId]: value }));
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(commandPreview);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleRun = async () => {
    setIsRunning(true);
    setOutputConsole(isPt ? 'Iniciando execução do comando...\n' : 'Starting command execution...\n');
    setExitCode(null);
    try {
      const result = await onExecute(commandPreview);
      setExitCode(result.exit_code);
      let out = '';
      if (result.stdout) out += result.stdout;
      if (result.stderr) {
        out += (out ? '\n--- STDERR ---\n' : '') + result.stderr;
      }
      if (!out) out = isPt ? 'Comando concluído com código de saída 0.' : 'Command finished with exit code 0.';
      setOutputConsole(out);
    } catch (err: any) {
      setExitCode(-1);
      setOutputConsole(`Erro: ${err}`);
    } finally {
      setIsRunning(false);
    }
  };

  const handleInsertVariable = (variable: string) => {
    setCustomTemplate((prev) => `${prev} ${variable}`.trim());
  };

  const handleSaveCustom = async () => {
    if (!customNamePt || !customTemplate) {
      alert(isPt ? 'Por favor, preencha o nome e o comando.' : 'Please provide a name and command template.');
      return;
    }
    setIsSavingCustom(true);
    try {
      const newAction: ActionDefinition = {
        id: editingActionId || `custom-${Date.now()}`,
        category: customCategory,
        icon: 'terminal',
        risk_level: customRisk,
        scope: customScope,
        name: {
          'pt-BR': customNamePt,
          'en-US': customNameEn || customNamePt,
        },
        description: {
          'pt-BR': customDescPt || customNamePt,
          'en-US': customDescEn || customDescPt || customNamePt,
        },
        fields: [],
        template: customTemplate,
      };
      if (onSaveCustomAction) {
        await onSaveCustomAction(newAction);
      }
      setActiveTab('run');
      setSelectedActionId(newAction.id);
      // Reset form
      setEditingActionId(null);
      setCustomNamePt('');
      setCustomNameEn('');
      setCustomDescPt('');
      setCustomDescEn('');
      setCustomTemplate('');
    } catch (e) {
      alert(`Falha ao salvar ação: ${e}`);
    } finally {
      setIsSavingCustom(false);
    }
  };

  const getRiskBadge = (risk: RiskLevel) => {
    switch (risk) {
      case 'safe':
        return (
          <span className="flex items-center space-x-1 px-2 py-0.5 rounded text-[11px] font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
            <ShieldCheck className="w-3 h-3" />
            <span>{isPt ? 'Seguro' : 'Safe'}</span>
          </span>
        );
      case 'warning':
        return (
          <span className="flex items-center space-x-1 px-2 py-0.5 rounded text-[11px] font-semibold bg-amber-500/15 text-amber-400 border border-amber-500/30">
            <AlertTriangle className="w-3 h-3" />
            <span>{isPt ? 'Atenção' : 'Warning'}</span>
          </span>
        );
      case 'dangerous':
      default:
        return (
          <span className="flex items-center space-x-1 px-2 py-0.5 rounded text-[11px] font-semibold bg-red-500/15 text-red-400 border border-red-500/30">
            <AlertTriangle className="w-3 h-3" />
            <span>{isPt ? 'Destrutivo' : 'Dangerous'}</span>
          </span>
        );
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-3 animate-in fade-in duration-150">
      <div className="bg-white dark:bg-dark-800 border border-slate-300 dark:border-dark-600 rounded-xl shadow-2xl max-w-5xl w-full h-[88vh] flex flex-col overflow-hidden text-slate-900 dark:text-slate-100">
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-slate-200 dark:border-dark-600 bg-slate-100 dark:bg-dark-750 flex items-center justify-between select-none shrink-0">
          <div className="flex items-center space-x-3">
            <div className="p-2 rounded-lg bg-rust-500/15 text-rust-500 dark:text-rust-400 border border-rust-500/30">
              <Terminal className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                <span>{isPt ? 'Estúdio de Comandos & Ações' : 'Command Studio & Custom Actions'}</span>
                <span className="text-[10px] bg-slate-200 dark:bg-dark-700 text-slate-700 dark:text-slate-300 font-mono px-2 py-0.5 rounded border border-slate-300 dark:border-dark-600">
                  {isRemote ? 'Remoto (SSH)' : 'Local'}
                </span>
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {isPt 
                  ? 'Execute comandos inteligentes pré-configurados ou crie suas próprias automações com variáveis dinâmicas.'
                  : 'Execute pre-configured smart commands or build custom automations with dynamic variables.'}
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            {/* Tabs Toggle */}
            <div className="flex bg-slate-200/80 dark:bg-dark-900/80 p-0.5 rounded-lg border border-slate-300 dark:border-dark-600 text-xs font-semibold">
              <button
                onClick={() => setActiveTab('run')}
                className={`px-3 py-1 rounded-md transition-colors ${
                  activeTab === 'run'
                    ? 'bg-rust-600 text-white shadow-sm'
                    : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
                }`}
              >
                {isPt ? 'Executar Ações' : 'Run Actions'}
              </button>
              <button
                onClick={() => setActiveTab('create')}
                className={`flex items-center gap-1 px-3 py-1 rounded-md transition-colors ${
                  activeTab === 'create'
                    ? 'bg-rust-600 text-white shadow-sm'
                    : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200'
                }`}
              >
                <Plus className="w-3.5 h-3.5" />
                <span>{isPt ? 'Criar / Editar' : 'Create / Edit'}</span>
              </button>
            </div>

            <button
              onClick={onClose}
              className="p-1.5 rounded-lg hover:bg-slate-200 dark:hover:bg-dark-700 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Tab 1: Run Actions */}
        {activeTab === 'run' && (
          <div className="flex-1 flex overflow-hidden">
            {/* Left Sidebar: Categories & Action List */}
            <div className="w-72 border-r border-slate-200 dark:border-dark-600 bg-slate-50 dark:bg-dark-850 flex flex-col shrink-0">
              {/* Search Bar */}
              <div className="p-2.5 border-b border-slate-200 dark:border-dark-600">
                <div className="flex items-center space-x-2 bg-white dark:bg-dark-900 border border-slate-300 dark:border-dark-600 rounded-lg px-2.5 py-1.5 shadow-sm">
                  <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder={isPt ? 'Filtrar comandos...' : 'Search commands...'}
                    className="bg-transparent text-xs text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none w-full"
                  />
                </div>
              </div>

              {/* Category Pills */}
              <div className="px-2.5 py-2 border-b border-slate-200 dark:border-dark-600 flex items-center space-x-1 overflow-x-auto scrollbar-none">
                {categories.map((cat) => (
                  <button
                    key={cat}
                    onClick={() => setSelectedCategory(cat)}
                    className={`px-2 py-0.5 rounded text-[11px] font-medium whitespace-nowrap capitalize transition-colors ${
                      selectedCategory === cat
                        ? 'bg-rust-500/20 text-rust-600 dark:text-rust-400 border border-rust-500/40'
                        : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200 dark:text-slate-400 dark:hover:text-slate-200 dark:hover:bg-dark-700'
                    }`}
                  >
                    {cat === 'all' ? (isPt ? 'Todos' : 'All') : cat}
                  </button>
                ))}
              </div>

              {/* Actions List */}
              <div className="flex-1 overflow-y-auto p-1.5 space-y-1">
                {filteredActions.map((action) => {
                  const isSelected = action.id === activeAction?.id;
                  return (
                    <button
                      key={action.id}
                      onClick={() => setSelectedActionId(action.id)}
                      className={`w-full text-left p-2 rounded-lg border transition-all ${
                        isSelected
                          ? 'bg-slate-200 dark:bg-dark-700 border-rust-500/50 shadow-sm'
                          : 'bg-white/80 dark:bg-dark-800/60 border-slate-200 dark:border-transparent hover:bg-slate-100 dark:hover:bg-dark-700/60 hover:border-slate-300 dark:hover:border-dark-600'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-semibold text-slate-900 dark:text-slate-200 truncate">
                          {action.name[lang] || action.name['pt-BR'] || action.id}
                        </span>
                        {getRiskBadge(action.risk_level)}
                      </div>
                      <p className="text-[11px] text-slate-500 dark:text-slate-400 line-clamp-1">
                        {action.description[lang] || action.description['pt-BR']}
                      </p>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Right Pane: Action Parameters, Live Preview, and Runner */}
            <div className="flex-1 flex flex-col overflow-hidden bg-slate-100/50 dark:bg-dark-900">
              {activeAction ? (
                <div className="flex-1 flex flex-col p-4 overflow-y-auto space-y-4">
                  {/* Action Header Card */}
                  <div className="bg-white dark:bg-dark-800 border border-slate-200 dark:border-dark-600 rounded-xl p-3.5 flex items-center justify-between shadow-sm">
                    <div>
                      <div className="flex items-center space-x-2">
                        <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
                          {activeAction.name[lang] || activeAction.name['pt-BR']}
                        </h3>
                        <span className="text-[10px] uppercase font-mono px-2 py-0.5 rounded bg-slate-100 dark:bg-dark-700 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-dark-600">
                          {activeAction.category}
                        </span>
                      </div>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                        {activeAction.description[lang] || activeAction.description['pt-BR']}
                      </p>
                    </div>

                    <div className="flex items-center space-x-2">
                      {getRiskBadge(activeAction.risk_level)}
                      {activeAction.id.startsWith('custom-') && onDeleteCustomAction && (
                        confirmDeleteActionId === activeAction.id ? (
                          <div className="flex items-center space-x-1 bg-red-500/10 border border-red-500/30 rounded px-2 py-0.5">
                            <span className="text-[11px] text-red-600 dark:text-red-400 font-medium">
                              {isPt ? 'Excluir?' : 'Delete?'}
                            </span>
                            <button
                              onClick={async () => {
                                await onDeleteCustomAction(activeAction.id);
                                setConfirmDeleteActionId(null);
                              }}
                              className="px-1.5 py-0.5 rounded bg-red-600 hover:bg-red-500 text-white text-[10px] font-semibold"
                            >
                              {isPt ? 'Sim' : 'Yes'}
                            </button>
                            <button
                              onClick={() => setConfirmDeleteActionId(null)}
                              className="px-1.5 py-0.5 rounded bg-slate-200 dark:bg-dark-700 text-slate-700 dark:text-slate-300 text-[10px]"
                            >
                              {isPt ? 'Não' : 'No'}
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setConfirmDeleteActionId(activeAction.id)}
                            title={isPt ? 'Excluir Ação' : 'Delete Action'}
                            className="p-1.5 rounded bg-red-500/10 hover:bg-red-500/20 text-red-600 dark:text-red-400 border border-red-500/20"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )
                      )}
                    </div>
                  </div>

                  {/* Dynamic Fields Parameters (if any) */}
                  {activeAction.fields && activeAction.fields.length > 0 && (
                    <div className="bg-white dark:bg-dark-800 border border-slate-200 dark:border-dark-600 rounded-xl p-3.5 space-y-3 shadow-sm">
                      <h4 className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
                        {isPt ? 'Parâmetros da Ação' : 'Action Parameters'}
                      </h4>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {activeAction.fields.map((field) => (
                          <div key={field.id} className="space-y-1">
                            <label className="text-xs font-medium text-slate-700 dark:text-slate-300 flex items-center justify-between">
                              <span>{field.label[lang] || field.label['pt-BR']}</span>
                              {field.required && <span className="text-[10px] text-rust-500 dark:text-rust-400">*</span>}
                            </label>

                            {field.kind === 'select' && field.options ? (
                              <select
                                value={fieldValues[field.id] || ''}
                                onChange={(e) => handleFieldChange(field.id, e.target.value)}
                                className="w-full bg-white dark:bg-dark-900 border border-slate-300 dark:border-dark-600 rounded-lg px-2.5 py-1.5 text-xs text-slate-900 dark:text-slate-200 focus:outline-none focus:border-rust-500 shadow-sm"
                              >
                                {field.options.map((opt) => (
                                  <option key={opt.value} value={opt.value}>
                                    {opt.label[lang] || opt.label['pt-BR']}
                                  </option>
                                ))}
                              </select>
                            ) : field.kind === 'checkbox' ? (
                              <label className="flex items-center space-x-2 cursor-pointer pt-1">
                                <input
                                  type="checkbox"
                                  checked={fieldValues[field.id] === 'true'}
                                  onChange={(e) => handleFieldChange(field.id, e.target.checked ? 'true' : 'false')}
                                  className="rounded border-slate-300 dark:border-dark-600 text-rust-500 focus:ring-rust-500"
                                />
                                <span className="text-xs text-slate-700 dark:text-slate-300">
                                  {isPt ? 'Ativar opção' : 'Enable option'}
                                </span>
                              </label>
                            ) : (
                              <input
                                type="text"
                                value={fieldValues[field.id] || ''}
                                onChange={(e) => handleFieldChange(field.id, e.target.value)}
                                autoCapitalize="none"
                                autoCorrect="off"
                                spellCheck={false}
                                autoComplete="off"
                                className="w-full bg-white dark:bg-dark-900 border border-slate-300 dark:border-dark-600 rounded-lg px-2.5 py-1.5 text-xs text-slate-900 dark:text-slate-200 focus:outline-none focus:border-rust-500 font-mono shadow-sm"
                              />
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Live Command Preview Box */}
                  <div className="bg-white dark:bg-dark-800 border border-slate-200 dark:border-dark-600 rounded-xl p-3.5 space-y-2 shadow-sm">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                        <Terminal className="w-3.5 h-3.5 text-rust-500 dark:text-rust-400" />
                        <span>{isPt ? 'Comando Shell Expandido' : 'Expanded Shell Command'}</span>
                      </span>

                      <div className="flex items-center space-x-2">
                        <button
                          onClick={handleCopy}
                          className="flex items-center space-x-1 px-2 py-1 rounded bg-slate-200 hover:bg-slate-300 text-slate-700 hover:text-slate-900 dark:bg-dark-700 dark:hover:bg-dark-600 dark:text-slate-300 dark:hover:text-slate-100 text-xs border border-slate-300 dark:border-dark-600 transition-colors shadow-sm"
                        >
                          {copied ? <Check className="w-3 h-3 text-emerald-600 dark:text-emerald-400" /> : <Copy className="w-3 h-3" />}
                          <span>{copied ? (isPt ? 'Copiado!' : 'Copied!') : (isPt ? 'Copiar' : 'Copy')}</span>
                        </button>

                        <button
                          onClick={handleRun}
                          disabled={isRunning}
                          className="flex items-center space-x-1.5 px-3 py-1 rounded bg-rust-600 hover:bg-rust-500 disabled:opacity-40 text-white text-xs font-bold transition-all shadow-sm border border-rust-500/40"
                        >
                          <Play className="w-3 h-3 fill-current" />
                          <span>{isRunning ? (isPt ? 'Executando...' : 'Running...') : (isPt ? 'Executar' : 'Execute')}</span>
                        </button>
                      </div>
                    </div>

                    <pre className="bg-slate-950 dark:bg-dark-950 p-3 rounded-lg border border-slate-800 dark:border-dark-700 text-xs font-mono text-rust-400 dark:text-rust-300 overflow-x-auto selection:bg-rust-500/40">
                      <code>{commandPreview || '...'}</code>
                    </pre>

                    <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
                      <span>{selectedPaths.length} {isPt ? 'arquivo(s) selecionado(s)' : 'file(s) selected'}</span>
                      <span className="font-mono truncate max-w-sm">{currentDir}</span>
                    </div>
                  </div>

                  {/* Output Terminal Console */}
                  <div className="bg-white dark:bg-dark-950 border border-slate-200 dark:border-dark-600 rounded-xl overflow-hidden flex flex-col flex-1 min-h-[160px] shadow-sm">
                    <div className="bg-slate-100 dark:bg-dark-900 border-b border-slate-200 dark:border-dark-700 px-3 py-1.5 flex items-center justify-between select-none">
                      <span className="text-xs font-mono text-slate-600 dark:text-slate-400 flex items-center gap-1.5">
                        <span>Console Output</span>
                        {exitCode !== null && (
                          <span className={`text-[10px] px-1.5 py-0.2 rounded font-bold ${
                            exitCode === 0 
                              ? 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-400' 
                              : 'bg-red-500/20 text-red-600 dark:text-red-400'
                          }`}>
                            exit code: {exitCode}
                          </span>
                        )}
                      </span>

                      {outputConsole && (
                        <button
                          onClick={() => setOutputConsole('')}
                          className="text-[10px] text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200"
                        >
                          {isPt ? 'Limpar' : 'Clear'}
                        </button>
                      )}
                    </div>

                    <pre className="p-3 text-xs font-mono text-slate-900 dark:text-slate-200 bg-slate-50 dark:bg-transparent overflow-y-auto flex-1 leading-relaxed selection:bg-rust-500/30">
                      {outputConsole || (isPt ? 'Aguardando execução...' : 'Waiting for command execution...')}
                    </pre>
                  </div>
                </div>
              ) : (
                <div className="flex-1 flex items-center justify-center text-slate-500 text-xs">
                  {isPt ? 'Nenhuma ação selecionada' : 'No action selected'}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Tab 2: Create / Edit Custom Actions */}
        {activeTab === 'create' && (
          <div className="flex-1 flex flex-col p-5 overflow-y-auto space-y-4 bg-slate-50 dark:bg-dark-900">
            <div className="bg-white dark:bg-dark-800 border border-slate-200 dark:border-dark-600 rounded-xl p-4 space-y-4 shadow-sm">
              <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                <Code2 className="w-4 h-4 text-rust-500 dark:text-rust-400" />
                <span>{isPt ? 'Construtor de Comando Personalizado' : 'Custom Command Builder'}</span>
              </h3>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                    {isPt ? 'Nome da Ação (Português) *' : 'Action Name (PT) *'}
                  </label>
                  <input
                    type="text"
                    value={customNamePt}
                    onChange={(e) => setCustomNamePt(e.target.value)}
                    placeholder="Ex: Limpar Cache do Laravel"
                    className="w-full bg-white dark:bg-dark-900 border border-slate-300 dark:border-dark-600 rounded-lg px-3 py-1.5 text-xs text-slate-900 dark:text-slate-200 focus:outline-none focus:border-rust-500 shadow-sm"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                    {isPt ? 'Nome da Ação (Inglês)' : 'Action Name (EN)'}
                  </label>
                  <input
                    type="text"
                    value={customNameEn}
                    onChange={(e) => setCustomNameEn(e.target.value)}
                    placeholder="Ex: Clear Laravel Cache"
                    className="w-full bg-white dark:bg-dark-900 border border-slate-300 dark:border-dark-600 rounded-lg px-3 py-1.5 text-xs text-slate-900 dark:text-slate-200 focus:outline-none focus:border-rust-500 shadow-sm"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                    {isPt ? 'Categoria' : 'Category'}
                  </label>
                  <select
                    value={customCategory}
                    onChange={(e) => setCustomCategory(e.target.value)}
                    className="w-full bg-white dark:bg-dark-900 border border-slate-300 dark:border-dark-600 rounded-lg px-3 py-1.5 text-xs text-slate-900 dark:text-slate-200 focus:outline-none focus:border-rust-500 shadow-sm"
                  >
                    <option value="custom">Custom / Personalizado</option>
                    <option value="sysadmin">SysAdmin / Sistema</option>
                    <option value="compression">Compressão / Arquivos</option>
                    <option value="docker">Docker & Containers</option>
                    <option value="git">Git & Versionamento</option>
                    <option value="maintenance">Manutenção & Limpeza</option>
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                    {isPt ? 'Nível de Risco' : 'Risk Level'}
                  </label>
                  <select
                    value={customRisk}
                    onChange={(e) => setCustomRisk(e.target.value as RiskLevel)}
                    className="w-full bg-white dark:bg-dark-900 border border-slate-300 dark:border-dark-600 rounded-lg px-3 py-1.5 text-xs text-slate-900 dark:text-slate-200 focus:outline-none focus:border-rust-500 shadow-sm"
                  >
                    <option value="safe">{isPt ? 'Seguro (Safe)' : 'Safe'}</option>
                    <option value="warning">{isPt ? 'Atenção (Warning)' : 'Warning'}</option>
                    <option value="dangerous">{isPt ? 'Destrutivo (Dangerous)' : 'Dangerous'}</option>
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                    {isPt ? 'Escopo' : 'Scope'}
                  </label>
                  <select
                    value={customScope}
                    onChange={(e) => setCustomScope(e.target.value as Scope)}
                    className="w-full bg-white dark:bg-dark-900 border border-slate-300 dark:border-dark-600 rounded-lg px-3 py-1.5 text-xs text-slate-900 dark:text-slate-200 focus:outline-none focus:border-rust-500 shadow-sm"
                  >
                    <option value="selected_files">{isPt ? 'Itens Selecionados' : 'Selected Files'}</option>
                    <option value="selected_dir">{isPt ? 'Diretório Atual' : 'Current Directory'}</option>
                    <option value="global">{isPt ? 'Global (Qualquer Local)' : 'Global'}</option>
                  </select>
                </div>
              </div>

              {/* Variable Pills */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-700 dark:text-slate-300 flex items-center justify-between">
                  <span>{isPt ? 'Comando / Template Shell *' : 'Command Template *'}</span>
                  <span className="text-[11px] text-slate-500 dark:text-slate-400 font-normal">
                    {isPt ? 'Clique nas variáveis para inserir no cursor' : 'Click variable pills to insert'}
                  </span>
                </label>

                <div className="flex flex-wrap gap-1.5 mb-2">
                  <button
                    type="button"
                    onClick={() => handleInsertVariable('${selected_files}')}
                    className="px-2 py-1 rounded bg-slate-200 hover:bg-slate-300 border border-slate-300 text-rust-600 dark:bg-dark-700 dark:hover:bg-dark-600 dark:border-dark-600 dark:text-rust-400 text-xs font-mono"
                  >
                    + ${'{selected_files}'}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleInsertVariable('${current_dir}')}
                    className="px-2 py-1 rounded bg-slate-200 hover:bg-slate-300 border border-slate-300 text-sky-600 dark:bg-dark-700 dark:hover:bg-dark-600 dark:border-dark-600 dark:text-sky-400 text-xs font-mono"
                  >
                    + ${'{current_dir}'}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleInsertVariable('${selected_file}')}
                    className="px-2 py-1 rounded bg-slate-200 hover:bg-slate-300 border border-slate-300 text-emerald-600 dark:bg-dark-700 dark:hover:bg-dark-600 dark:border-dark-600 dark:text-emerald-400 text-xs font-mono"
                  >
                    + ${'{selected_file}'}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleInsertVariable('${selected_name}')}
                    className="px-2 py-1 rounded bg-slate-200 hover:bg-slate-300 border border-slate-300 text-amber-600 dark:bg-dark-700 dark:hover:bg-dark-600 dark:border-dark-600 dark:text-amber-400 text-xs font-mono"
                  >
                    + ${'{selected_name}'}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleInsertVariable('${selected_stem}')}
                    className="px-2 py-1 rounded bg-slate-200 hover:bg-slate-300 border border-slate-300 text-purple-600 dark:bg-dark-700 dark:hover:bg-dark-600 dark:border-dark-600 dark:text-purple-400 text-xs font-mono"
                  >
                    + ${'{selected_stem}'}
                  </button>
                </div>

                <textarea
                  value={customTemplate}
                  onChange={(e) => setCustomTemplate(e.target.value)}
                  placeholder="Ex: cd ${current_dir} && php artisan cache:clear && chmod -R 755 storage"
                  rows={4}
                  className="w-full bg-white dark:bg-dark-950 border border-slate-300 dark:border-dark-600 rounded-lg p-3 text-xs text-slate-900 dark:text-rust-300 font-mono focus:outline-none focus:border-rust-500 shadow-sm"
                />
              </div>

              {/* Save Button */}
              <div className="flex justify-end space-x-2 pt-2 border-t border-slate-200 dark:border-dark-700">
                <button
                  type="button"
                  onClick={() => setActiveTab('run')}
                  className="px-4 py-2 rounded-lg bg-slate-200 hover:bg-slate-300 text-slate-700 dark:bg-dark-700 dark:hover:bg-dark-600 dark:text-slate-300 text-xs font-semibold border border-slate-300 dark:border-dark-600 transition-colors"
                >
                  {isPt ? 'Cancelar' : 'Cancel'}
                </button>
                <button
                  type="button"
                  onClick={handleSaveCustom}
                  disabled={isSavingCustom || !customNamePt || !customTemplate}
                  className="flex items-center space-x-1.5 px-4 py-2 rounded-lg bg-rust-600 hover:bg-rust-500 disabled:opacity-40 text-white text-xs font-bold transition-all shadow-md"
                >
                  <Save className="w-3.5 h-3.5" />
                  <span>{isSavingCustom ? (isPt ? 'Salvando...' : 'Saving...') : (isPt ? 'Salvar Ação Personalizada' : 'Save Custom Action')}</span>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
