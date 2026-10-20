import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, Pencil, Play, Plus, Search, Terminal, Trash2 } from 'lucide-react';
import { ActionDefinition, RiskLevel, Scope } from '../types.ts';
import { Modal } from './ui/Modal.tsx';
import { Button, Disclosure, Field, IconButton, Segmented, Select, TextArea, TextInput, Toggle } from './ui/controls.tsx';
import { notify } from './ui/toast.tsx';
import {
  commandInDir,
  describeFieldError,
  initialFieldValues,
  renderActionTemplate,
} from './automation/actionTemplate.ts';
import { CommandOutput, CommandResult } from './automation/CommandOutput.tsx';
import { AutomationConfirm } from './automation/AutomationConfirm.tsx';
import { RiskBadge } from './automation/RiskBadge.tsx';

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
  /** Action to select when the studio opens (e.g. chosen in the file context menu) */
  initialActionId?: string;
  /** Name of the session the command runs on, shown in the target line */
  sessionName?: string;
}

const CATEGORY_LABELS: Record<string, { pt: string; en: string }> = {
  compression: { pt: 'Compressão', en: 'Compression' },
  system: { pt: 'Sistema', en: 'System' },
  search: { pt: 'Busca', en: 'Search' },
  permissions: { pt: 'Permissões', en: 'Permissions' },
  sysadmin: { pt: 'Serviços', en: 'Services' },
  containers: { pt: 'Containers', en: 'Containers' },
  docker: { pt: 'Docker', en: 'Docker' },
  git: { pt: 'Git', en: 'Git' },
  maintenance: { pt: 'Manutenção', en: 'Maintenance' },
  custom: { pt: 'Personalizadas', en: 'Custom' },
};

const CUSTOM_CATEGORIES = ['custom', 'sysadmin', 'compression', 'docker', 'git', 'maintenance'];

const VARIABLES = ['${selected_files}', '${current_dir}', '${selected_file}', '${selected_name}', '${selected_stem}', '${selected_ext}'];

const isCustomAction = (a: ActionDefinition) => a.id.startsWith('custom-');

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
  initialActionId,
  sessionName,
}) => {
  const { i18n } = useTranslation();
  const isPt = i18n.language.startsWith('pt');
  const lang = isPt ? 'pt-BR' : 'en-US';
  const otherLang = isPt ? 'en-US' : 'pt-BR';
  const text = (a: { 'pt-BR': string; 'en-US': string } | undefined, fallback = '') => a?.[lang] || a?.[otherLang] || fallback;
  const categoryLabel = (c: string) => (CATEGORY_LABELS[c] ? (isPt ? CATEGORY_LABELS[c].pt : CATEGORY_LABELS[c].en) : c);

  const [activeTab, setActiveTab] = useState<'run' | 'create'>('run');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('all');
  // Seed with the requested action so the first render already shows it (no flash of actions[0])
  const [selectedActionId, setSelectedActionId] = useState(() =>
    initialActionId && actions.some((a) => a.id === initialActionId) ? initialActionId : ''
  );
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [result, setResult] = useState<CommandResult | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [confirmCommand, setConfirmCommand] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmDeleteActionId, setConfirmDeleteActionId] = useState<string | null>(null);
  const runIdRef = useRef(0);

  // Custom action form
  const [editingActionId, setEditingActionId] = useState<string | null>(null);
  const [customNamePt, setCustomNamePt] = useState('');
  const [customNameEn, setCustomNameEn] = useState('');
  const [customDescPt, setCustomDescPt] = useState('');
  const [customDescEn, setCustomDescEn] = useState('');
  const [customCategory, setCustomCategory] = useState('custom');
  const [customRisk, setCustomRisk] = useState<RiskLevel>('safe');
  const [customScope, setCustomScope] = useState<Scope>('selected_files');
  const [customTemplate, setCustomTemplate] = useState('');
  const [isSavingCustom, setIsSavingCustom] = useState(false);
  const templateRef = useRef<HTMLTextAreaElement>(null);

  // Select the requested action when the studio opens, otherwise keep a valid selection
  useEffect(() => {
    if (!isOpen) return;
    if (initialActionId && actions.some((a) => a.id === initialActionId)) {
      setSelectedActionId(initialActionId);
      setActiveTab('run');
    }
  }, [isOpen, initialActionId, actions]);

  useEffect(() => {
    if (actions.length > 0 && !actions.some((a) => a.id === selectedActionId)) {
      // Read the pending state, not this closure: the effect above may have queued
      // initialActionId in the same commit, and it must win over the fallback.
      setSelectedActionId((cur) => (actions.some((a) => a.id === cur) ? cur : actions[0].id));
    }
  }, [actions, selectedActionId]);

  const activeAction = useMemo(() => actions.find((a) => a.id === selectedActionId) || actions[0], [actions, selectedActionId]);

  const categories = useMemo(() => Array.from(new Set(actions.map((a) => a.category))), [actions]);

  const filteredActions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return actions.filter((a) => {
      if (selectedCategory !== 'all' && a.category !== selectedCategory) return false;
      if (!q) return true;
      return (
        text(a.name, a.id).toLowerCase().includes(q) ||
        text(a.description).toLowerCase().includes(q) ||
        a.template.toLowerCase().includes(q)
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions, selectedCategory, searchQuery, lang]);

  const groupedActions = useMemo(() => {
    const groups = new Map<string, ActionDefinition[]>();
    for (const a of filteredActions) {
      const list = groups.get(a.category) || [];
      list.push(a);
      groups.set(a.category, list);
    }
    return Array.from(groups.entries());
  }, [filteredActions]);

  // Reset the form when the action or its context changes (keyed by value, not array identity)
  const selectionKey = selectedPaths.join('\u0000');
  const ctx = useMemo(() => ({ selectedPaths, currentDir }), [selectionKey, currentDir]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!activeAction) return;
    setFieldValues(initialFieldValues(activeAction, ctx));
    setConfirmDeleteActionId(null);
  }, [activeAction, ctx]);

  const rendered = useMemo(
    () => (activeAction ? renderActionTemplate(activeAction, ctx, fieldValues, isPt) : null),
    [activeAction, ctx, fieldValues, isPt]
  );
  const runCommand = rendered ? commandInDir(currentDir, rendered.command) : '';
  const fieldErrorCount = rendered ? Object.keys(rendered.fieldErrors).length : 0;
  const canRun = !!rendered && !rendered.error && fieldErrorCount === 0 && !!rendered.command && !isRunning;

  const targetName = isRemote ? sessionName || (isPt ? 'Servidor' : 'Server') : isPt ? 'Este computador' : 'This computer';
  const targetLine = `${targetName} · ${currentDir || '/'}`;

  if (!isOpen) return null;

  const handleFieldChange = (fieldId: string, value: string) => setFieldValues((prev) => ({ ...prev, [fieldId]: value }));

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(runCommand);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      notify.error(isPt ? 'Não foi possível copiar' : 'Could not copy');
    }
  };

  const execute = async (cmd: string) => {
    const id = ++runIdRef.current;
    setIsRunning(true);
    setResult(null);
    try {
      const res = await onExecute(cmd);
      if (id !== runIdRef.current) return;
      setResult({ stdout: res.stdout || '', stderr: res.stderr || '', exitCode: res.exit_code });
    } catch (err) {
      if (id !== runIdRef.current) return;
      setResult({ stdout: '', stderr: String(err), exitCode: -1 });
    } finally {
      if (id === runIdRef.current) setIsRunning(false);
    }
  };

  const handleRun = () => {
    if (!activeAction || !canRun) return;
    const riskyField = (activeAction.fields || []).some((f) => {
      if (!f.risk_warning) return false;
      const v = (fieldValues[f.id] ?? '').trim();
      return f.kind === 'checkbox' ? v === 'true' : v !== '';
    });
    if (activeAction.risk_level !== 'safe' || riskyField) {
      setConfirmCommand(runCommand);
      return;
    }
    void execute(runCommand);
  };

  const handleStopWaiting = () => {
    runIdRef.current++;
    setIsRunning(false);
    notify.info(
      isPt ? 'Parou de aguardar' : 'Stopped waiting',
      isPt ? 'O comando pode continuar rodando no servidor.' : 'The command may still be running on the server.'
    );
  };

  // --- Custom action builder ---
  const resetForm = () => {
    setEditingActionId(null);
    setCustomNamePt('');
    setCustomNameEn('');
    setCustomDescPt('');
    setCustomDescEn('');
    setCustomCategory('custom');
    setCustomRisk('safe');
    setCustomScope('selected_files');
    setCustomTemplate('');
  };

  const startEdit = (a: ActionDefinition) => {
    setEditingActionId(a.id);
    setCustomNamePt(a.name['pt-BR'] || '');
    setCustomNameEn(a.name['en-US'] || '');
    setCustomDescPt(a.description['pt-BR'] || '');
    setCustomDescEn(a.description['en-US'] || '');
    setCustomCategory(a.category || 'custom');
    setCustomRisk(a.risk_level);
    setCustomScope(a.scope);
    setCustomTemplate(a.template);
    setActiveTab('create');
  };

  const handleInsertVariable = (variable: string) => {
    const el = templateRef.current;
    if (!el) {
      setCustomTemplate((prev) => (prev ? `${prev} ${variable}` : variable));
      return;
    }
    const start = el.selectionStart ?? customTemplate.length;
    const end = el.selectionEnd ?? start;
    const before = customTemplate.slice(0, start);
    const after = customTemplate.slice(end);
    const pad = before && !/\s$/.test(before) ? ' ' : '';
    const padAfter = after && !/^\s/.test(after) ? ' ' : '';
    const next = `${before}${pad}${variable}${padAfter}${after}`;
    setCustomTemplate(next);
    const caret = before.length + pad.length + variable.length + padAfter.length;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  const primaryName = isPt ? customNamePt : customNameEn;
  const anyName = (customNamePt || customNameEn).trim();

  const handleSaveCustom = async () => {
    if (!anyName || !customTemplate.trim()) {
      notify.warning(isPt ? 'Preencha o nome e o comando.' : 'Enter a name and a command.');
      return;
    }
    if (!onSaveCustomAction) return;
    setIsSavingCustom(true);
    try {
      const namePt = customNamePt.trim() || customNameEn.trim();
      const nameEn = customNameEn.trim() || customNamePt.trim();
      const newAction: ActionDefinition = {
        id: editingActionId || `custom-${Date.now()}`,
        category: customCategory,
        icon: 'terminal',
        risk_level: customRisk,
        scope: customScope,
        name: { 'pt-BR': namePt, 'en-US': nameEn },
        description: {
          'pt-BR': customDescPt.trim() || customDescEn.trim() || namePt,
          'en-US': customDescEn.trim() || customDescPt.trim() || nameEn,
        },
        fields: [],
        template: customTemplate.trim(),
      };
      await onSaveCustomAction(newAction);
      notify.success(isPt ? 'Ação salva' : 'Action saved', isPt ? newAction.name['pt-BR'] : newAction.name['en-US']);
      setActiveTab('run');
      setSelectedActionId(newAction.id);
      resetForm();
    } catch (e) {
      notify.error(isPt ? 'Falha ao salvar a ação' : 'Could not save the action', e);
    } finally {
      setIsSavingCustom(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!onDeleteCustomAction) return;
    try {
      await onDeleteCustomAction(id);
      setConfirmDeleteActionId(null);
      notify.success(isPt ? 'Ação excluída' : 'Action deleted');
    } catch (e) {
      notify.error(isPt ? 'Falha ao excluir a ação' : 'Could not delete the action', e);
    }
  };

  const headerTabs = (
    <Segmented
      size="sm"
      value={activeTab}
      onChange={(v) => {
        if (v === 'create' && activeTab !== 'create' && !editingActionId) resetForm();
        setActiveTab(v);
      }}
      ariaLabel={isPt ? 'Modo' : 'Mode'}
      options={[
        { value: 'run', label: isPt ? 'Executar' : 'Run' },
        { value: 'create', label: editingActionId ? (isPt ? 'Editar' : 'Edit') : isPt ? 'Criar' : 'Create', icon: <Plus className="w-3 h-3" /> },
      ]}
    />
  );

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        size="2xl"
        className="h-[min(760px,calc(100vh-2rem))]"
        padded={false}
        icon={<Terminal className="w-5 h-5" />}
        title={isPt ? 'Estúdio de comandos' : 'Command Studio'}
        subtitle={
          <span>
            {targetName} · <span className="font-mono text-[12px]">{currentDir || '/'}</span>
          </span>
        }
        headerActions={headerTabs}
      >
        {activeTab === 'run' && (
          <div className="h-full flex border-t border-line">
            {/* Action list */}
            <div className="w-64 shrink-0 border-r border-line flex flex-col min-h-0">
              <div className="p-3 space-y-2 shrink-0">
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-ink-faint absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <TextInput
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder={isPt ? 'Buscar comandos' : 'Search commands'}
                    className="pl-8"
                    aria-label={isPt ? 'Buscar comandos' : 'Search commands'}
                  />
                </div>
                <Select
                  value={selectedCategory}
                  onChange={(e) => setSelectedCategory(e.target.value)}
                  aria-label={isPt ? 'Categoria' : 'Category'}
                >
                  <option value="all">{isPt ? 'Todas as categorias' : 'All categories'}</option>
                  {categories.map((c) => (
                    <option key={c} value={c}>
                      {categoryLabel(c)}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-3">
                {groupedActions.length === 0 && (
                  <p className="px-2 py-6 text-center text-[12px] text-ink-faint">{isPt ? 'Nenhum comando encontrado' : 'No commands found'}</p>
                )}
                {groupedActions.map(([cat, list]) => (
                  <div key={cat} className="mb-2">
                    <div className="px-2 pt-2 pb-1 text-[12px] font-medium text-ink-faint">{categoryLabel(cat)}</div>
                    {list.map((action) => {
                      const selected = action.id === activeAction?.id;
                      return (
                        <button
                          key={action.id}
                          type="button"
                          onClick={() => setSelectedActionId(action.id)}
                          aria-current={selected ? 'true' : undefined}
                          className={`w-full text-left px-2 py-1.5 rounded-lg transition-colors ${
                            selected ? 'bg-rust-500/10' : 'hover:bg-dark-650/60'
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <span className={`flex-1 truncate text-[13px] ${selected ? 'text-ink font-medium' : 'text-ink'}`}>
                              {text(action.name, action.id)}
                            </span>
                            {action.risk_level !== 'safe' && <RiskBadge risk={action.risk_level} isPt={isPt} />}
                          </div>
                          <p className="text-[11.5px] text-ink-faint line-clamp-1">{text(action.description)}</p>
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>

            {/* Action detail */}
            <div className="flex-1 min-w-0 overflow-y-auto">
              {activeAction && rendered ? (
                <div className="p-5 space-y-5">
                  <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="text-[15px] font-semibold text-ink">{text(activeAction.name, activeAction.id)}</h3>
                        <RiskBadge risk={activeAction.risk_level} isPt={isPt} />
                      </div>
                      <p className="text-[12.5px] text-ink-muted mt-0.5">{text(activeAction.description)}</p>
                    </div>
                    {isCustomAction(activeAction) && (
                      <div className="flex items-center gap-1 shrink-0">
                        {onSaveCustomAction && (
                          <IconButton size="sm" label={isPt ? 'Editar ação' : 'Edit action'} onClick={() => startEdit(activeAction)}>
                            <Pencil className="w-3.5 h-3.5" />
                          </IconButton>
                        )}
                        {onDeleteCustomAction &&
                          (confirmDeleteActionId === activeAction.id ? (
                            <div className="flex items-center gap-1.5 pl-1">
                              <span className="text-[12px] text-ink-muted">{isPt ? 'Excluir?' : 'Delete?'}</span>
                              <Button size="sm" variant="secondary" autoFocus onClick={() => setConfirmDeleteActionId(null)}>
                                {isPt ? 'Não' : 'No'}
                              </Button>
                              <Button size="sm" variant="danger" onClick={() => handleDelete(activeAction.id)}>
                                {isPt ? 'Excluir' : 'Delete'}
                              </Button>
                            </div>
                          ) : (
                            <IconButton size="sm" label={isPt ? 'Excluir ação' : 'Delete action'} onClick={() => setConfirmDeleteActionId(activeAction.id)}>
                              <Trash2 className="w-3.5 h-3.5" />
                            </IconButton>
                          ))}
                      </div>
                    )}
                  </div>

                  {activeAction.fields && activeAction.fields.length > 0 && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
                      {activeAction.fields.map((field) => {
                        const err = rendered.fieldErrors[field.id];
                        const label = (
                          <>
                            {text(field.label, field.id)}
                            {field.required && field.kind !== 'checkbox' && <span className="text-ink-faint"> *</span>}
                          </>
                        );
                        if (field.kind === 'checkbox') {
                          return (
                            <div key={field.id} className="sm:col-span-2 flex items-center justify-between gap-3 py-1">
                              <div className="min-w-0">
                                <div className="text-[13px] text-ink">{text(field.label, field.id)}</div>
                                {field.description && <div className="text-[11.5px] text-ink-faint">{text(field.description)}</div>}
                              </div>
                              <Toggle
                                checked={fieldValues[field.id] === 'true'}
                                onChange={(v) => handleFieldChange(field.id, v ? 'true' : 'false')}
                                label={text(field.label, field.id)}
                              />
                            </div>
                          );
                        }
                        return (
                          <Field
                            key={field.id}
                            label={label}
                            hint={field.description ? text(field.description) : undefined}
                            error={err ? describeFieldError(err, isPt) : undefined}
                          >
                            {(id) =>
                              field.kind === 'select' && field.options ? (
                                <Select id={id} value={fieldValues[field.id] ?? ''} onChange={(e) => handleFieldChange(field.id, e.target.value)}>
                                  {field.options.map((opt) => (
                                    <option key={opt.value} value={opt.value}>
                                      {text(opt.label, opt.value)}
                                    </option>
                                  ))}
                                </Select>
                              ) : (
                                <TextInput
                                  id={id}
                                  mono
                                  type={field.kind === 'number' ? 'number' : 'text'}
                                  min={field.min}
                                  max={field.max}
                                  step={field.step}
                                  value={fieldValues[field.id] ?? ''}
                                  onChange={(e) => handleFieldChange(field.id, e.target.value)}
                                  aria-invalid={err ? true : undefined}
                                />
                              )
                            }
                          </Field>
                        );
                      })}
                    </div>
                  )}

                  {/* Exact command */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[12px] font-medium text-ink-faint">{isPt ? 'Comando que será executado' : 'Command that will run'}</span>
                      <IconButton size="sm" label={isPt ? 'Copiar comando' : 'Copy command'} onClick={handleCopy} disabled={!runCommand}>
                        {copied ? <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                      </IconButton>
                    </div>
                    <pre className="rounded-lg border border-line bg-surface-sunken px-3 py-2.5 font-mono text-[12px] text-ink whitespace-pre-wrap break-all select-text">
                      {runCommand || '…'}
                    </pre>
                    {rendered.error && <p className="text-[12px] text-red-600 dark:text-red-400">{rendered.error}</p>}
                    <div className="flex items-center justify-between gap-3 text-[12px] text-ink-faint">
                      <span>
                        {selectedPaths.length === 1
                          ? isPt
                            ? '1 item selecionado'
                            : '1 item selected'
                          : isPt
                            ? `${selectedPaths.length} itens selecionados`
                            : `${selectedPaths.length} items selected`}
                        {' · '}
                        {isRemote ? (isPt ? 'Servidor (SSH)' : 'Server (SSH)') : isPt ? 'Este computador' : 'This computer'}
                      </span>
                      <Button
                        variant={activeAction.risk_level === 'dangerous' ? 'danger' : 'primary'}
                        onClick={handleRun}
                        disabled={!canRun}
                        loading={isRunning}
                        icon={<Play className="w-3.5 h-3.5" />}
                      >
                        {isRunning ? (isPt ? 'Executando…' : 'Running…') : isPt ? 'Executar' : 'Run'}
                      </Button>
                    </div>
                  </div>

                  <CommandOutput
                    result={result}
                    running={isRunning}
                    isPt={isPt}
                    onClear={() => setResult(null)}
                    placeholder={isPt ? 'A saída do comando aparece aqui.' : 'Command output appears here.'}
                    actions={
                      isRunning ? (
                        <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={handleStopWaiting}>
                          {isPt ? 'Parar de aguardar' : 'Stop waiting'}
                        </button>
                      ) : null
                    }
                  />
                </div>
              ) : (
                <div className="h-full flex items-center justify-center text-[13px] text-ink-faint">
                  {isPt ? 'Nenhuma ação selecionada' : 'No action selected'}
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'create' && (
          <div className="h-full overflow-y-auto border-t border-line">
            <div className="max-w-2xl mx-auto p-5 space-y-4">
              <div>
                <h3 className="text-[14px] font-semibold text-ink">
                  {editingActionId ? (isPt ? 'Editar ação personalizada' : 'Edit custom action') : isPt ? 'Nova ação personalizada' : 'New custom action'}
                </h3>
                <p className="text-[12px] text-ink-muted mt-0.5">
                  {isPt
                    ? 'Salve um comando para reutilizar com os itens selecionados ou com a pasta atual.'
                    : 'Save a command to reuse with the selected items or the current folder.'}
                </p>
              </div>

              <Field label={isPt ? 'Nome *' : 'Name *'}>
                {(id) => (
                  <TextInput
                    id={id}
                    value={primaryName}
                    onChange={(e) => (isPt ? setCustomNamePt(e.target.value) : setCustomNameEn(e.target.value))}
                    placeholder={isPt ? 'Ex.: Limpar cache do Laravel' : 'e.g. Clear Laravel cache'}
                  />
                )}
              </Field>

              <div>
                <label className="ui-label" htmlFor="studio-template">
                  {isPt ? 'Comando *' : 'Command *'}
                </label>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {VARIABLES.map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => handleInsertVariable(v)}
                      className="h-6 px-2 rounded-md border border-line bg-surface-raised hover:bg-dark-650/60 font-mono text-[11.5px] text-ink-muted transition-colors"
                    >
                      {v}
                    </button>
                  ))}
                </div>
                <TextArea
                  id="studio-template"
                  ref={templateRef}
                  mono
                  rows={4}
                  value={customTemplate}
                  onChange={(e) => setCustomTemplate(e.target.value)}
                  placeholder="php artisan cache:clear && chmod -R 755 storage"
                />
                <span className="ui-hint">
                  {isPt
                    ? 'Clique numa variável para inserir no cursor. Variáveis viram palavras já entre aspas: não as coloque dentro de aspas. O comando roda na pasta atual.'
                    : 'Click a variable to insert it at the cursor. Variables expand to already-quoted words: do not put them inside quotes. The command runs in the current folder.'}
                </span>
              </div>

              <div>
                <span className="ui-label">{isPt ? 'Nível de risco' : 'Risk level'}</span>
                <Segmented
                  value={customRisk}
                  onChange={setCustomRisk}
                  ariaLabel={isPt ? 'Nível de risco' : 'Risk level'}
                  options={[
                    { value: 'safe', label: isPt ? 'Seguro' : 'Safe' },
                    { value: 'warning', label: isPt ? 'Atenção' : 'Warning' },
                    { value: 'dangerous', label: isPt ? 'Destrutivo' : 'Dangerous' },
                  ]}
                />
                <span className="ui-hint">
                  {isPt ? 'Ações com Atenção ou Destrutivo pedem confirmação antes de executar.' : 'Warning and Dangerous actions ask for confirmation before they run.'}
                </span>
              </div>

              <Disclosure label={isPt ? 'Avançado' : 'Advanced'}>
                <div className="space-y-3">
                  <Field label={isPt ? 'Nome em inglês' : 'Name in Portuguese'}>
                    {(id) => (
                      <TextInput
                        id={id}
                        value={isPt ? customNameEn : customNamePt}
                        onChange={(e) => (isPt ? setCustomNameEn(e.target.value) : setCustomNamePt(e.target.value))}
                      />
                    )}
                  </Field>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <Field label={isPt ? 'Descrição (português)' : 'Description (Portuguese)'}>
                      {(id) => <TextInput id={id} value={customDescPt} onChange={(e) => setCustomDescPt(e.target.value)} />}
                    </Field>
                    <Field label={isPt ? 'Descrição (inglês)' : 'Description (English)'}>
                      {(id) => <TextInput id={id} value={customDescEn} onChange={(e) => setCustomDescEn(e.target.value)} />}
                    </Field>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <Field label={isPt ? 'Categoria' : 'Category'}>
                      {(id) => (
                        <Select id={id} value={customCategory} onChange={(e) => setCustomCategory(e.target.value)}>
                          {Array.from(new Set([...CUSTOM_CATEGORIES, customCategory])).map((c) => (
                            <option key={c} value={c}>
                              {categoryLabel(c)}
                            </option>
                          ))}
                        </Select>
                      )}
                    </Field>
                    <Field label={isPt ? 'Escopo' : 'Scope'}>
                      {(id) => (
                        <Select id={id} value={customScope} onChange={(e) => setCustomScope(e.target.value as Scope)}>
                          <option value="selected_files">{isPt ? 'Itens selecionados' : 'Selected items'}</option>
                          <option value="selected_dir">{isPt ? 'Pasta atual' : 'Current folder'}</option>
                          <option value="global">{isPt ? 'Global (qualquer lugar)' : 'Global (anywhere)'}</option>
                          {customScope === 'any' && <option value="any">{isPt ? 'Qualquer' : 'Any'}</option>}
                        </Select>
                      )}
                    </Field>
                  </div>
                </div>
              </Disclosure>

              <div className="flex justify-end gap-2 pt-3 border-t border-line">
                <Button
                  variant="secondary"
                  onClick={() => {
                    resetForm();
                    setActiveTab('run');
                  }}
                >
                  {isPt ? 'Cancelar' : 'Cancel'}
                </Button>
                <Button
                  variant="primary"
                  onClick={handleSaveCustom}
                  loading={isSavingCustom}
                  disabled={!onSaveCustomAction || !anyName || !customTemplate.trim()}
                >
                  {editingActionId ? (isPt ? 'Salvar alterações' : 'Save changes') : isPt ? 'Salvar ação' : 'Save action'}
                </Button>
              </div>
            </div>
          </div>
        )}
      </Modal>

      <AutomationConfirm
        isOpen={confirmCommand !== null}
        tone={activeAction?.risk_level === 'dangerous' ? 'danger' : 'primary'}
        title={
          activeAction?.risk_level === 'dangerous'
            ? isPt
              ? 'Executar comando destrutivo?'
              : 'Run destructive command?'
            : isPt
              ? 'Executar este comando?'
              : 'Run this command?'
        }
        message={
          isPt
            ? 'Confira o comando exato e onde ele será executado. Esta ação pode alterar arquivos ou serviços.'
            : 'Check the exact command and where it runs. This action can change files or services.'
        }
        target={targetLine}
        command={confirmCommand ?? ''}
        confirmLabel={isPt ? 'Executar' : 'Run'}
        cancelLabel={isPt ? 'Cancelar' : 'Cancel'}
        onCancel={() => setConfirmCommand(null)}
        onConfirm={() => {
          const cmd = confirmCommand;
          setConfirmCommand(null);
          if (cmd) void execute(cmd);
        }}
      />
    </>
  );
};

