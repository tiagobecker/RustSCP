import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { 
  X, 
  Terminal, 
  Copy, 
  Play, 
  AlertTriangle, 
  ShieldCheck, 
  Check, 
  Layers
} from 'lucide-react';
import { ActionDefinition } from '../types.ts';

interface SmartCommandModalProps {
  isOpen: boolean;
  onClose: () => void;
  actions: ActionDefinition[];
  selectedPaths: string[];
  currentDir: string;
  onExecute: (command: string) => Promise<string>;
}

export const SmartCommandModal: React.FC<SmartCommandModalProps> = ({
  isOpen,
  onClose,
  actions,
  selectedPaths,
  currentDir,
  onExecute,
}) => {
  const { t, i18n } = useTranslation();
  const lang = i18n.language.startsWith('pt') ? 'pt-BR' : 'en-US';

  const [selectedActionId, setSelectedActionId] = useState<string>('');
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [commandPreview, setCommandPreview] = useState<string>('');
  const [outputConsole, setOutputConsole] = useState<string>('');
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);

  // Set default selected action
  useEffect(() => {
    if (actions.length > 0 && !selectedActionId) {
      setSelectedActionId(actions[0].id);
    }
  }, [actions, selectedActionId]);

  const activeAction = actions.find((a) => a.id === selectedActionId) || actions[0];

  // Initialize fields with defaults
  useEffect(() => {
    if (!activeAction) return;
    const initial: Record<string, string> = {};
    for (const field of activeAction.fields) {
      if (field.default_value) {
        let def = field.default_value;
        const firstName = selectedPaths[0]?.split('/').pop() || 'archive';
        def = def.replace('${selected_first_name}', firstName);
        initial[field.id] = def;
      } else if (field.kind === 'checkbox') {
        initial[field.id] = 'false';
      } else {
        initial[field.id] = '';
      }
    }
    setFieldValues(initial);
    setOutputConsole('');
  }, [activeAction, selectedPaths]);

  // Compute live command preview
  useEffect(() => {
    if (!activeAction) return;
    let cmd = activeAction.template;

    const quotedFiles = selectedPaths.length > 0 
      ? selectedPaths.map((p) => `'${p}'`).join(' ') 
      : "''";
    const firstName = selectedPaths[0]?.split('/').pop() || 'item';

    cmd = cmd.replace(/\$\{selected_files\}/g, quotedFiles);
    cmd = cmd.replace(/\$\{selected_dir\}/g, `'${currentDir}'`);
    cmd = cmd.replace(/\$\{selected_first_name\}/g, firstName);

    for (const field of activeAction.fields) {
      const val = fieldValues[field.id] !== undefined ? fieldValues[field.id] : (field.default_value || '');
      const regex = new RegExp(`\\{\\{${field.id}\\}\\}`, 'g');
      if (field.kind === 'checkbox') {
        cmd = cmd.replace(regex, val === 'true' ? 'true' : 'false');
      } else {
        cmd = cmd.replace(regex, `'${val}'`);
      }
    }
    // Clean up simple template tags
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
    setOutputConsole('Executing command on remote server...\n');
    try {
      const result = await onExecute(commandPreview);
      setOutputConsole(result || 'Command finished with exit code 0.');
    } catch (err: any) {
      setOutputConsole(`Error: ${err}`);
    } finally {
      setIsRunning(false);
    }
  };

  const getRiskBadge = (risk: string) => {
    switch (risk) {
      case 'safe':
        return (
          <span className="flex items-center space-x-1 px-2 py-0.5 rounded text-[11px] font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
            <ShieldCheck className="w-3 h-3" />
            <span>{t('smartCommand.riskSafe')}</span>
          </span>
        );
      case 'warning':
        return (
          <span className="flex items-center space-x-1 px-2 py-0.5 rounded text-[11px] font-semibold bg-amber-500/15 text-amber-400 border border-amber-500/30">
            <AlertTriangle className="w-3 h-3" />
            <span>{t('smartCommand.riskWarning')}</span>
          </span>
        );
      case 'dangerous':
      default:
        return (
          <span className="flex items-center space-x-1 px-2 py-0.5 rounded text-[11px] font-semibold bg-red-500/15 text-red-400 border border-red-500/30">
            <AlertTriangle className="w-3 h-3" />
            <span>{t('smartCommand.riskDangerous')}</span>
          </span>
        );
    }
  };

  return (
    <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-dark-800 border border-slate-300 dark:border-dark-600 rounded-xl max-w-2xl w-full shadow-2xl flex flex-col max-h-[85vh] overflow-hidden text-slate-900 dark:text-slate-100">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-200 dark:border-dark-700 flex items-center justify-between bg-slate-100 dark:bg-dark-750">
          <div className="flex items-center space-x-2.5">
            <div className="p-2 rounded-lg bg-amber-500/10 text-amber-500 dark:text-amber-400 border border-amber-500/20">
              <Terminal className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-bold text-slate-900 dark:text-slate-100 text-sm">{t('smartCommand.title')}</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">{t('smartCommand.subtitle')}</p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white p-1 rounded-md hover:bg-slate-200 dark:hover:bg-dark-700 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-5 flex-1 overflow-y-auto space-y-4">
          {/* Action Selector */}
          <div>
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1 flex items-center space-x-1.5">
              <Layers className="w-3.5 h-3.5 text-sky-500 dark:text-sky-400" />
              <span>{t('smartCommand.category')}</span>
            </label>
            <select
              value={selectedActionId}
              onChange={(e) => setSelectedActionId(e.target.value)}
              className="w-full bg-white dark:bg-dark-900 border border-slate-300 dark:border-dark-700 rounded-lg px-3 py-2 text-xs text-slate-900 dark:text-slate-200 focus:outline-none focus:border-sky-500 shadow-sm"
            >
              {actions.map((act) => (
                <option key={act.id} value={act.id}>
                  {act.name[lang] || act.name['en-US']} ({act.category})
                </option>
              ))}
            </select>
          </div>

          {activeAction && (
            <div className="bg-slate-50 dark:bg-dark-900/60 border border-slate-200 dark:border-dark-700/80 rounded-lg p-3.5 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-xs font-bold text-slate-900 dark:text-slate-200">
                    {activeAction.name[lang] || activeAction.name['en-US']}
                  </h4>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                    {activeAction.description[lang] || activeAction.description['en-US']}
                  </p>
                </div>
                {getRiskBadge(activeAction.risk_level)}
              </div>

              {/* Dynamic Form Fields */}
              {activeAction.fields.map((field) => (
                <div key={field.id} className="space-y-1">
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                    {field.label[lang] || field.label['en-US']}
                    {field.required && <span className="text-red-500 dark:text-red-400 ml-1">*</span>}
                  </label>

                  {field.kind === 'select' && field.options ? (
                    <select
                      value={fieldValues[field.id] || ''}
                      onChange={(e) => handleFieldChange(field.id, e.target.value)}
                      className="w-full bg-white dark:bg-dark-800 border border-slate-300 dark:border-dark-700 rounded-md px-2.5 py-1.5 text-xs text-slate-900 dark:text-slate-200 focus:outline-none focus:border-sky-500 shadow-sm"
                    >
                      {field.options.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label[lang] || opt.label['en-US']}
                        </option>
                      ))}
                    </select>
                  ) : field.kind === 'checkbox' ? (
                    <div className="flex items-center space-x-2 pt-1">
                      <input
                        type="checkbox"
                        id={field.id}
                        checked={fieldValues[field.id] === 'true'}
                        onChange={(e) => handleFieldChange(field.id, e.target.checked ? 'true' : 'false')}
                        className="rounded bg-white dark:bg-dark-800 border-slate-300 dark:border-dark-700 text-sky-500 focus:ring-0"
                      />
                      <label htmlFor={field.id} className="text-xs text-slate-600 dark:text-slate-400 cursor-pointer">
                        {field.label[lang] || field.label['en-US']}
                      </label>
                    </div>
                  ) : (
                    <input
                      type={field.kind === 'number' ? 'number' : 'text'}
                      value={fieldValues[field.id] || ''}
                      onChange={(e) => handleFieldChange(field.id, e.target.value)}
                      min={field.min}
                      max={field.max}
                      step={field.step}
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      autoComplete="off"
                      className="w-full bg-white dark:bg-dark-800 border border-slate-300 dark:border-dark-700 rounded-md px-2.5 py-1.5 text-xs font-mono text-slate-900 dark:text-slate-200 focus:outline-none focus:border-sky-500 shadow-sm"
                    />
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Live Command Preview */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-semibold text-slate-600 dark:text-slate-400">
                {t('smartCommand.commandPreview')}
              </label>
              <button
                onClick={handleCopy}
                className="flex items-center space-x-1 text-[11px] text-sky-600 hover:text-sky-500 dark:text-sky-400 dark:hover:text-sky-300 font-medium"
              >
                {copied ? <Check className="w-3 h-3 text-emerald-600 dark:text-emerald-400" /> : <Copy className="w-3 h-3" />}
                <span>{copied ? 'Copiado!' : t('smartCommand.copy')}</span>
              </button>
            </div>
            <div className="bg-slate-950 dark:bg-black/80 rounded-lg p-3 border border-slate-800 dark:border-dark-700 font-mono text-xs text-emerald-400 break-all overflow-x-auto select-all">
              {commandPreview || '# Ready'}
            </div>
          </div>

          {/* Execution Output Console */}
          {outputConsole && (
            <div>
              <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1">
                Output / Log
              </label>
              <pre className="bg-slate-50 dark:bg-black/90 rounded-lg p-3 border border-slate-200 dark:border-dark-700 font-mono text-xs text-slate-900 dark:text-slate-300 max-h-32 overflow-y-auto whitespace-pre-wrap">
                {outputConsole}
              </pre>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="px-5 py-3 border-t border-slate-200 dark:border-dark-700 bg-slate-100 dark:bg-dark-750 flex items-center justify-between">
          <div className="text-[11px] text-slate-500 dark:text-slate-400">
            {selectedPaths.length > 0 && (
              <span>{selectedPaths.length} arquivo(s) selecionado(s)</span>
            )}
          </div>
          <div className="flex items-center space-x-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded-md text-xs font-medium text-slate-700 hover:text-slate-900 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-dark-700 transition-colors border border-slate-300 dark:border-transparent"
            >
              Fechar
            </button>
            <button
              onClick={handleRun}
              disabled={isRunning}
              className="flex items-center space-x-1.5 px-4 py-1.5 rounded-md text-xs font-semibold bg-sky-600 hover:bg-sky-500 text-white shadow-md disabled:opacity-50 transition-all"
            >
              <Play className={`w-3.5 h-3.5 ${isRunning ? 'animate-pulse' : ''}`} />
              <span>{isRunning ? 'Executando...' : t('smartCommand.execute')}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
