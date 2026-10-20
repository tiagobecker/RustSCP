import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, Play, Terminal } from 'lucide-react';
import { ActionDefinition } from '../types.ts';
import { Modal } from './ui/Modal.tsx';
import { Button, Field, IconButton, Select, TextInput, Toggle } from './ui/controls.tsx';
import { commandInDir, describeFieldError, initialFieldValues, renderActionTemplate } from './automation/actionTemplate.ts';
import { AutomationConfirm } from './automation/AutomationConfirm.tsx';
import { RiskBadge } from './automation/RiskBadge.tsx';

interface SmartCommandModalProps {
  isOpen: boolean;
  onClose: () => void;
  actions: ActionDefinition[];
  selectedPaths: string[];
  currentDir: string;
  onExecute: (command: string) => Promise<string>;
}

/**
 * Compact single-action runner. Not mounted by the app today (Command Studio covers it), kept
 * compiling and safe: it shares the quoting renderer and confirmation sheet with Command Studio.
 */
export const SmartCommandModal: React.FC<SmartCommandModalProps> = ({ isOpen, onClose, actions, selectedPaths, currentDir, onExecute }) => {
  const { t, i18n } = useTranslation();
  const isPt = i18n.language.startsWith('pt');
  const lang = isPt ? 'pt-BR' : 'en-US';
  const text = (a: { 'pt-BR': string; 'en-US': string } | undefined, fallback = '') => a?.[lang] || a?.['en-US'] || fallback;

  const [selectedActionId, setSelectedActionId] = useState('');
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [outputConsole, setOutputConsole] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmCommand, setConfirmCommand] = useState<string | null>(null);
  const runIdRef = useRef(0);

  useEffect(() => {
    if (actions.length > 0 && !actions.some((a) => a.id === selectedActionId)) setSelectedActionId(actions[0].id);
  }, [actions, selectedActionId]);

  const activeAction = actions.find((a) => a.id === selectedActionId) || actions[0];
  const selectionKey = selectedPaths.join('\u0000');
  const ctx = useMemo(() => ({ selectedPaths, currentDir }), [selectionKey, currentDir]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!activeAction) return;
    setFieldValues(initialFieldValues(activeAction, ctx));
    setOutputConsole('');
  }, [activeAction, ctx]);

  const rendered = useMemo(
    () => (activeAction ? renderActionTemplate(activeAction, ctx, fieldValues, isPt) : null),
    [activeAction, ctx, fieldValues, isPt]
  );
  const runCommand = rendered ? commandInDir(currentDir, rendered.command) : '';
  const canRun = !!rendered && !rendered.error && Object.keys(rendered.fieldErrors).length === 0 && !!rendered.command && !isRunning;

  if (!isOpen) return null;

  const handleFieldChange = (fieldId: string, value: string) => setFieldValues((prev) => ({ ...prev, [fieldId]: value }));

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(runCommand);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  const execute = async (cmd: string) => {
    const id = ++runIdRef.current;
    setIsRunning(true);
    setOutputConsole('');
    try {
      const result = await onExecute(cmd);
      if (id === runIdRef.current) setOutputConsole(result || (isPt ? 'Comando concluído.' : 'Command finished.'));
    } catch (err) {
      if (id === runIdRef.current) setOutputConsole(`${isPt ? 'Erro' : 'Error'}: ${err}`);
    } finally {
      if (id === runIdRef.current) setIsRunning(false);
    }
  };

  const handleRun = () => {
    if (!activeAction || !canRun) return;
    if (activeAction.risk_level !== 'safe') setConfirmCommand(runCommand);
    else void execute(runCommand);
  };

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        size="xl"
        icon={<Terminal className="w-5 h-5" />}
        title={t('smartCommand.title', 'Smart command')}
        subtitle={<span className="font-mono text-[12px]">{currentDir}</span>}
        footer={
          <>
            <span className="mr-auto text-[12px] text-ink-faint">
              {selectedPaths.length > 0 &&
                (isPt ? `${selectedPaths.length} item(ns) selecionado(s)` : `${selectedPaths.length} item(s) selected`)}
            </span>
            <Button variant="secondary" onClick={onClose}>
              {isPt ? 'Fechar' : 'Close'}
            </Button>
            <Button
              variant={activeAction?.risk_level === 'dangerous' ? 'danger' : 'primary'}
              onClick={handleRun}
              disabled={!canRun}
              loading={isRunning}
              icon={<Play className="w-3.5 h-3.5" />}
            >
              {isRunning ? (isPt ? 'Executando…' : 'Running…') : isPt ? 'Executar' : 'Run'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label={isPt ? 'Ação' : 'Action'}>
            {(id) => (
              <Select id={id} value={activeAction?.id ?? ''} onChange={(e) => setSelectedActionId(e.target.value)}>
                {actions.map((act) => (
                  <option key={act.id} value={act.id}>
                    {text(act.name, act.id)}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          {activeAction && rendered && (
            <div className="ui-card p-4 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h4 className="text-[13px] font-semibold text-ink">{text(activeAction.name, activeAction.id)}</h4>
                  <p className="text-[12px] text-ink-muted mt-0.5">{text(activeAction.description)}</p>
                </div>
                <RiskBadge risk={activeAction.risk_level} isPt={isPt} />
              </div>

              {activeAction.fields.map((field) => {
                const err = rendered.fieldErrors[field.id];
                if (field.kind === 'checkbox') {
                  return (
                    <div key={field.id} className="flex items-center justify-between gap-3">
                      <span className="text-[13px] text-ink">{text(field.label, field.id)}</span>
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
                    label={
                      <>
                        {text(field.label, field.id)}
                        {field.required && <span className="text-ink-faint"> *</span>}
                      </>
                    }
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
                          value={fieldValues[field.id] ?? ''}
                          onChange={(e) => handleFieldChange(field.id, e.target.value)}
                          min={field.min}
                          max={field.max}
                          step={field.step}
                        />
                      )
                    }
                  </Field>
                );
              })}
            </div>
          )}

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[12px] font-medium text-ink-faint">{t('smartCommand.commandPreview', isPt ? 'Comando gerado' : 'Generated command')}</span>
              <IconButton size="sm" label={isPt ? 'Copiar comando' : 'Copy command'} onClick={handleCopy} disabled={!runCommand}>
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              </IconButton>
            </div>
            <pre className="rounded-lg border border-line bg-surface-sunken px-3 py-2.5 font-mono text-[12px] text-ink whitespace-pre-wrap break-all select-text">
              {runCommand || '…'}
            </pre>
            {rendered?.error && <p className="text-[12px] text-red-600 dark:text-red-400">{rendered.error}</p>}
          </div>

          {outputConsole && (
            <div className="space-y-1.5">
              <span className="text-[12px] font-medium text-ink-faint">{isPt ? 'Saída' : 'Output'}</span>
              <pre className="rounded-lg border border-line bg-surface-sunken px-3 py-2.5 font-mono text-[12px] text-ink max-h-40 overflow-y-auto whitespace-pre-wrap select-text">
                {outputConsole}
              </pre>
            </div>
          )}
        </div>
      </Modal>

      <AutomationConfirm
        isOpen={confirmCommand !== null}
        tone={activeAction?.risk_level === 'dangerous' ? 'danger' : 'primary'}
        title={isPt ? 'Executar este comando?' : 'Run this command?'}
        message={t('smartCommand.riskNotice', isPt ? 'Este comando altera arquivos ou serviços.' : 'This command changes files or services.')}
        target={currentDir}
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
