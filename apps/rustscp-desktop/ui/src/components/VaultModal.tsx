import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, CheckCircle2, Copy, Eye, EyeOff, FileText, X } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { ConnectionConfig, VaultSecurityInfo } from '../types.ts';
import { Modal } from './ui/Modal.tsx';
import { Button, Disclosure, Field, IconButton, Segmented, TextArea, TextInput } from './ui/controls.tsx';
import { notify } from './ui/toast.tsx';
import { ConfirmDialogModal } from './ConfirmDialogModal.tsx';
import { copyText, useCopyFeedback } from './copyToClipboard.ts';

export type VaultTab = 'export' | 'import';

interface VaultModalProps {
  isOpen: boolean;
  onClose: () => void;
  siteCount: number;
  onSitesUpdated: (newSites: ConnectionConfig[]) => void;
  /** Tab shown when the dialog opens. Defaults to 'import' when there are no saved sites, otherwise 'export'. */
  initialTab?: VaultTab;
}

/** The backend trims passphrases on export and import, so the length is checked on the trimmed value. */
const MIN_PASSPHRASE_LENGTH = 12;
/** A vault is a few KB per site; anything this large is almost certainly the wrong file. */
const MAX_VAULT_FILE_BYTES = 5 * 1024 * 1024;

const COMMON_PATTERNS = /(password|passw0rd|senha|123456|qwerty|abc123|111111|letmein|rustscp|admin)/i;

/** Rough passphrase strength (0–4). Length matters most; variety and obvious patterns adjust it. */
function passphraseStrength(raw: string): number {
  const pw = raw.trim();
  if (!pw) return 0;
  const len = [...pw].length;
  let score = len < 8 ? 0 : len < 12 ? 1 : len < 16 ? 2 : len < 20 ? 3 : 4;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
  if (classes >= 3 && len >= 10) score += 1;
  if (classes === 1 && len < 20) score -= 1;
  if (/^(.)\1+$/.test(pw) || COMMON_PATTERNS.test(pw) || new Set(pw).size < Math.min(6, len)) score = Math.min(score, 1);
  return Math.max(0, Math.min(4, score));
}

/** Backend errors are Portuguese text and/or stable `vault.*` codes; map both to the UI language. */
function describeImportError(err: unknown, tr: (pt: string, en: string) => string): string {
  const text = String((err as any)?.message ?? err ?? '');
  const lower = text.toLowerCase();
  if (lower.includes('vault.wrong_password') || text.includes('DecryptionFailed') || lower.includes('senha incorreta') || lower.includes('falha ao descriptografar') || lower.includes('wrong password')) {
    return tr('Senha incorreta, ou o arquivo foi alterado ou está corrompido.', 'Wrong passphrase, or the file was changed or is damaged.');
  }
  if (lower.includes('vault.unsupported_version') || lower.includes('versão de cofre incompatível')) {
    return tr('Este backup foi criado por uma versão mais nova do RustSCP. Atualize o aplicativo e tente novamente.', 'This backup was made by a newer version of RustSCP. Update the app and try again.');
  }
  if (lower.includes('vault.invalid_header') || lower.includes('vault.serialization') || lower.includes('inválido ou corrompido') || lower.includes('formato de cofre')) {
    return tr('Este arquivo não é um backup do RustSCP válido.', 'This file is not a valid RustSCP backup.');
  }
  if (lower.includes('vault.kdf_out_of_range') || lower.includes('vault.unsupported_algorithm') || lower.includes('unsafe or invalid key-derivation') || lower.includes('unsupported vault algorithm')) {
    return tr('Este backup usa parâmetros de criptografia não suportados ou inseguros.', 'This backup uses unsupported or unsafe encryption settings.');
  }
  return text || tr('Erro desconhecido.', 'Unknown error.');
}

function formatKb(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
}

const PasswordInput = React.forwardRef<
  HTMLInputElement,
  {
    id: string;
    value: string;
    onChange: (v: string) => void;
    visible: boolean;
    onToggleVisible?: () => void;
    placeholder?: string;
    autoComplete: string;
    showLabel: string;
    hideLabel: string;
    invalid?: boolean;
    describedBy?: string;
    /** Marks the field as the dialog's initial focus target */
    autoFocusTarget?: boolean;
  }
>(({ id, value, onChange, visible, onToggleVisible, placeholder, autoComplete, showLabel, hideLabel, invalid, describedBy, autoFocusTarget }, ref) => (
  <div className="relative">
    <TextInput
      id={id}
      ref={ref}
      type={visible ? 'text' : 'password'}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      autoComplete={visible ? 'off' : autoComplete}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      data-autofocus={autoFocusTarget ? '' : undefined}
      className={onToggleVisible ? 'pr-9' : ''}
    />
    {onToggleVisible && (
      <IconButton size="sm" label={visible ? hideLabel : showLabel} onClick={onToggleVisible} className="absolute right-0.5 top-1/2 -translate-y-1/2">
        {visible ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
      </IconButton>
    )}
  </div>
));
PasswordInput.displayName = 'PasswordInput';

export const VaultModal = ({ isOpen, onClose, siteCount, onSitesUpdated, initialTab }: VaultModalProps) => {
  const { i18n } = useTranslation();
  const isPt = (i18n.language || '').startsWith('pt');
  const tr = (pt: string, en: string) => (isPt ? pt : en);

  const defaultTab: VaultTab = initialTab ?? (siteCount === 0 ? 'import' : 'export');
  const exportFormId = useId();
  const importFormId = useId();
  const exportPwId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);

  const [activeTab, setActiveTab] = useState<VaultTab>(defaultTab);
  const [securityInfo, setSecurityInfo] = useState<VaultSecurityInfo | null>(null);

  // --- Export state ---
  const [exportPassword, setExportPassword] = useState('');
  const [exportPasswordConfirm, setExportPasswordConfirm] = useState('');
  const [showExportPassword, setShowExportPassword] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportedJson, setExportedJson] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [saveFellBack, setSaveFellBack] = useState(false);
  const exportCopy = useCopyFeedback(2000);

  // --- Import state ---
  const [importJson, setImportJson] = useState('');
  const [importFileName, setImportFileName] = useState<string | null>(null);
  const [importPassword, setImportPassword] = useState('');
  const [showImportPassword, setShowImportPassword] = useState(false);
  const [mergeMode, setMergeMode] = useState<'merge' | 'replace'>('merge');
  const [isImporting, setIsImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Fresh dialog on every open (callers may keep it mounted)
  useEffect(() => {
    if (!isOpen) return;
    setActiveTab(defaultTab);
    setExportPassword('');
    setExportPasswordConfirm('');
    setShowExportPassword(false);
    setExportError(null);
    setExportedJson(null);
    setSavedPath(null);
    setSaveFellBack(false);
    setImportJson('');
    setImportFileName(null);
    setImportPassword('');
    setShowImportPassword(false);
    setMergeMode('merge');
    setImportError(null);
    setImportSuccess(null);
    setConfirmReplace(false);
    let cancelled = false;
    invoke<VaultSecurityInfo>('get_vault_security_info')
      .then((info) => {
        if (!cancelled) setSecurityInfo(info);
      })
      .catch(() => {
        /* details are optional */
      });
    return () => {
      cancelled = true;
    };
    // defaultTab is read once per open on purpose
  }, [isOpen]);

  if (!isOpen || typeof document === 'undefined') return null;

  const exportIterations = securityInfo?.export_kdf_iterations || null;
  const suggestedName = `rustscp-vault-${new Date().toISOString().slice(0, 10)}.rustscp-vault`;

  // ------------------------------------------------------------------ Export
  const trimmedExportPw = exportPassword.trim();
  const strength = passphraseStrength(exportPassword);
  const tooShort = [...trimmedExportPw].length < MIN_PASSPHRASE_LENGTH;
  const confirmMatches = exportPassword.length > 0 && exportPassword === exportPasswordConfirm;
  const confirmMismatch = exportPasswordConfirm.length > 0 && exportPassword !== exportPasswordConfirm;
  const hasOuterSpaces = exportPassword.length > 0 && exportPassword !== trimmedExportPw;
  const canExport = siteCount > 0 && !tooShort && confirmMatches && !isExporting;

  const strengthLabels = [tr('Muito fraca', 'Very weak'), tr('Fraca', 'Weak'), tr('Razoável', 'Fair'), tr('Boa', 'Good'), tr('Forte', 'Strong')];
  const strengthColor = strength <= 1 ? 'bg-red-500' : strength === 2 ? 'bg-amber-500' : 'bg-emerald-500';
  const strengthText = strength <= 1 ? 'text-red-600 dark:text-red-400' : strength === 2 ? 'text-amber-700 dark:text-amber-400' : 'text-emerald-700 dark:text-emerald-400';

  const handleExport = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setExportError(null);
    if (siteCount === 0) {
      setExportError(tr('Não há conexões salvas para exportar.', 'There are no saved connections to export.'));
      return;
    }
    if (!trimmedExportPw) {
      setExportError(tr('Informe uma senha para proteger o backup.', 'Enter a passphrase to protect the backup.'));
      return;
    }
    if (tooShort) {
      setExportError(
        tr(`Use pelo menos ${MIN_PASSPHRASE_LENGTH} caracteres (espaços no início e no fim não contam).`, `Use at least ${MIN_PASSPHRASE_LENGTH} characters (spaces at the start or end don't count).`)
      );
      return;
    }
    if (exportPassword !== exportPasswordConfirm) {
      setExportError(tr('As senhas não coincidem.', "The passphrases don't match."));
      return;
    }
    if (isExporting) return;
    setIsExporting(true);
    try {
      const json = await invoke<string>('export_sites_vault', { password: exportPassword });
      if (!mountedRef.current) return;
      setExportedJson(json);
      setSavedPath(null);
      setSaveFellBack(false);
    } catch (err: any) {
      if (mountedRef.current) setExportError(String(err?.message ?? err));
    } finally {
      if (mountedRef.current) setIsExporting(false);
    }
  };

  const handleSaveVaultFile = async () => {
    if (!exportedJson || isSaving) return;
    setIsSaving(true);
    try {
      const path = await invoke<string | null>('save_text_file_dialog', { contents: exportedJson, suggestedName });
      if (path && mountedRef.current) {
        setSavedPath(path);
        setSaveFellBack(false);
        notify.success(tr('Backup salvo', 'Backup saved'), path);
      }
      // null: the user cancelled the dialog
    } catch (err) {
      // No native save dialog (or an older backend): never fail silently, hand over the text instead
      const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
      if (!inTauri) {
        const blob = new Blob([exportedJson], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = suggestedName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
      } else {
        const ok = await copyText(exportedJson);
        if (mountedRef.current) setSaveFellBack(ok);
        if (ok) {
          notify.warning(
            tr('Não foi possível abrir a janela Salvar', 'The save dialog is unavailable'),
            tr(`O texto cifrado foi copiado. Cole-o em um arquivo chamado ${suggestedName}.`, `The encrypted text was copied instead. Paste it into a file named ${suggestedName}.`)
          );
        } else {
          notify.error(tr('Não foi possível salvar o backup', 'Could not save the backup'), err);
        }
      }
    } finally {
      if (mountedRef.current) setIsSaving(false);
    }
  };

  const handleCopyExportJson = async () => {
    if (!exportedJson) return;
    const ok = await exportCopy.copy(exportedJson);
    if (!ok) notify.error(tr('Não foi possível copiar', 'Could not copy'), tr('O acesso à área de transferência foi negado.', 'Clipboard access was denied.'));
  };

  const resetExport = () => {
    setExportedJson(null);
    setExportPassword('');
    setExportPasswordConfirm('');
    setSavedPath(null);
    setSaveFellBack(false);
    setExportError(null);
  };

  // ------------------------------------------------------------------ Import
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const file = input.files?.[0];
    // Reset so choosing the same file again fires onChange
    input.value = '';
    if (!file) return;
    setImportError(null);
    setImportSuccess(null);

    if (file.size === 0) {
      setImportError(tr(`O arquivo ${file.name} está vazio.`, `${file.name} is empty.`));
      return;
    }
    if (file.size > MAX_VAULT_FILE_BYTES) {
      setImportError(tr(`${file.name} é grande demais para ser um backup do RustSCP.`, `${file.name} is too large to be a RustSCP backup.`));
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const content = typeof reader.result === 'string' ? reader.result : '';
      if (!content.trim()) {
        setImportError(tr(`O arquivo ${file.name} está vazio.`, `${file.name} is empty.`));
        return;
      }
      try {
        JSON.parse(content);
      } catch {
        setImportError(tr(`${file.name} não é um backup do RustSCP válido.`, `${file.name} is not a valid RustSCP backup.`));
        return;
      }
      setImportJson(content);
      setImportFileName(file.name);
    };
    reader.onerror = () => {
      setImportError(tr(`Não foi possível ler ${file.name}.`, `Could not read ${file.name}.`));
    };
    reader.readAsText(file);
  };

  const clearImportFile = () => {
    setImportJson('');
    setImportFileName(null);
    setImportError(null);
  };

  const runImport = async () => {
    if (isImporting) return;
    setIsImporting(true);
    setImportError(null);
    setImportSuccess(null);
    try {
      const updatedSites = await invoke<ConnectionConfig[]>('import_sites_vault', {
        vaultJson: importJson.trim(),
        password: importPassword,
        mergeMode,
      });
      onSitesUpdated(updatedSites);
      const count = updatedSites.filter((s) => s.id !== 'local').length;
      const msg =
        count === 1
          ? tr('Backup restaurado. Você tem 1 conexão salva.', 'Backup restored. You have 1 saved connection.')
          : tr(`Backup restaurado. Você tem ${count} conexões salvas.`, `Backup restored. You have ${count} saved connections.`);
      notify.success(tr('Conexões importadas', 'Connections imported'), msg);
      if (!mountedRef.current) return;
      setImportSuccess(msg);
      setImportJson('');
      setImportFileName(null);
      setImportPassword('');
      setMergeMode('merge');
    } catch (err) {
      if (mountedRef.current) setImportError(describeImportError(err, tr));
    } finally {
      if (mountedRef.current) setIsImporting(false);
    }
  };

  const handleImport = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setImportError(null);
    setImportSuccess(null);
    if (!importJson.trim()) {
      setImportError(tr('Escolha um arquivo .rustscp-vault ou cole o texto cifrado.', 'Choose a .rustscp-vault file or paste the encrypted text.'));
      return;
    }
    if (!importPassword.trim()) {
      setImportError(tr('Informe a senha usada ao exportar o backup.', 'Enter the passphrase used when the backup was exported.'));
      return;
    }
    // Replacing removes every connection that is not in the file: confirm first
    if (mergeMode === 'replace' && siteCount > 0) {
      setConfirmReplace(true);
      return;
    }
    await runImport();
  };

  const canImport = !!importJson.trim() && !!importPassword.trim() && !isImporting;

  // ------------------------------------------------------------------ Render
  const errorBox = (msg: string) => (
    <div role="alert" className="flex items-start gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-[12.5px] text-red-700 dark:text-red-300">
      <AlertTriangle className="w-4 h-4 mt-px shrink-0" aria-hidden="true" />
      <span className="break-words min-w-0">{msg}</span>
    </div>
  );

  const securityDetails = (
    <Disclosure label={tr('Detalhes de segurança', 'Security details')}>
      <div className="space-y-1.5 text-[12px] text-ink-muted leading-relaxed">
        <p>
          {tr('Criptografia AES-256-GCM com chave derivada da sua senha por PBKDF2-HMAC-SHA256', 'AES-256-GCM encryption with a key derived from your passphrase using PBKDF2-HMAC-SHA256')}
          {exportIterations ? ` (${exportIterations.toLocaleString(isPt ? 'pt-BR' : 'en-US')} ${tr('iterações', 'iterations')})` : ''}.
        </p>
        <p>
          {tr(
            'Sem a senha o arquivo não pode ser lido, mas quem tiver o arquivo pode tentar adivinhá-la. Use uma senha longa e guarde o arquivo em local de confiança.',
            'Without the passphrase the file cannot be read, but anyone who has the file can try to guess it. Use a long passphrase and keep the file somewhere you trust.'
          )}
        </p>
      </div>
    </Disclosure>
  );

  const exportBody = !exportedJson ? (
    <form id={exportFormId} onSubmit={handleExport} className="space-y-4">
      <p className="text-[13px] text-ink-muted leading-relaxed">
        {siteCount === 0
          ? tr('Você ainda não tem conexões salvas para exportar.', "You don't have any saved connections to export yet.")
          : siteCount === 1
            ? tr('A conexão salva, com senhas e chaves, será cifrada em um único arquivo.', 'Your saved connection, including passwords and keys, will be encrypted into a single file.')
            : tr(`As ${siteCount} conexões salvas, com senhas e chaves, serão cifradas em um único arquivo.`, `Your ${siteCount} saved connections, including passwords and keys, will be encrypted into a single file.`)}
      </p>

      <Field label={tr('Senha do backup', 'Backup passphrase')}>
        {(id) => (
          <div className="space-y-1.5">
            <PasswordInput
              id={id}
              autoFocusTarget
              value={exportPassword}
              onChange={(v) => {
                setExportPassword(v);
                setExportError(null);
              }}
              visible={showExportPassword}
              onToggleVisible={() => setShowExportPassword((v) => !v)}
              placeholder={tr(`Pelo menos ${MIN_PASSPHRASE_LENGTH} caracteres`, `At least ${MIN_PASSPHRASE_LENGTH} characters`)}
              autoComplete="new-password"
              showLabel={tr('Mostrar senha', 'Show passphrase')}
              hideLabel={tr('Ocultar senha', 'Hide passphrase')}
              describedBy={`${exportPwId}-strength`}
            />
            <div id={`${exportPwId}-strength`} className="flex items-center gap-2" aria-live="polite">
              <div className="flex flex-1 gap-1" aria-hidden="true">
                {[1, 2, 3, 4].map((i) => (
                  <span key={i} className={`h-1 flex-1 rounded-full ${exportPassword && i <= Math.max(1, strength) ? strengthColor : 'bg-dark-650 dark:bg-dark-600'}`} />
                ))}
              </div>
              <span className={`w-20 text-right text-[11.5px] ${exportPassword ? strengthText : 'text-ink-faint'}`}>
                {exportPassword ? strengthLabels[strength] : tr('Força', 'Strength')}
              </span>
            </div>
            <p className="ui-hint !mt-0">
              {hasOuterSpaces
                ? tr('Espaços no início e no fim são ignorados.', 'Spaces at the start or end are ignored.')
                : tr('Algumas palavras aleatórias formam uma boa senha. Sem ela não há como recuperar o backup.', "A few random words make a good passphrase. The backup can't be recovered without it.")}
            </p>
          </div>
        )}
      </Field>

      <Field label={tr('Confirmar senha', 'Confirm passphrase')}>
        {(id) => (
          <div className="space-y-1">
            <PasswordInput
              id={id}
              value={exportPasswordConfirm}
              onChange={(v) => {
                setExportPasswordConfirm(v);
                setExportError(null);
              }}
              visible={showExportPassword}
              placeholder={tr('Digite a senha novamente', 'Type the passphrase again')}
              autoComplete="new-password"
              showLabel={tr('Mostrar senha', 'Show passphrase')}
              hideLabel={tr('Ocultar senha', 'Hide passphrase')}
              invalid={confirmMismatch}
            />
            {(confirmMatches || confirmMismatch) && (
              <p className={`flex items-center gap-1 text-[11.5px] ${confirmMatches ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`} aria-live="polite">
                {confirmMatches ? <Check className="w-3.5 h-3.5" /> : <X className="w-3.5 h-3.5" />}
                {confirmMatches ? tr('As senhas coincidem', 'Passphrases match') : tr('As senhas não coincidem', "Passphrases don't match")}
              </p>
            )}
          </div>
        )}
      </Field>

      {exportError && errorBox(exportError)}
      {securityDetails}
    </form>
  ) : (
    <div className="space-y-4">
      <div className="flex items-start gap-2.5">
        <CheckCircle2 className="w-5 h-5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
        <div className="min-w-0 space-y-1">
          <p className="text-[13px] font-medium text-ink">{tr('Backup cifrado pronto', 'Encrypted backup ready')}</p>
          <p className="text-[12.5px] text-ink-muted leading-relaxed">
            {tr(
              'Salve o arquivo e guarde a senha. Para restaurar, use Importar neste ou em outro computador (macOS, Windows ou Linux).',
              'Save the file and keep the passphrase. To restore, use Import on this or another computer (macOS, Windows or Linux).'
            )}
          </p>
        </div>
      </div>

      {savedPath && (
        <div className="rounded-lg bg-surface-sunken border border-line px-3 py-2">
          <div className="text-[11.5px] text-ink-faint">{tr('Salvo em', 'Saved to')}</div>
          <div className="font-mono text-[12px] text-ink break-all select-text">{savedPath}</div>
        </div>
      )}

      {saveFellBack && !savedPath && (
        <p className="text-[12px] text-amber-700 dark:text-amber-400 leading-snug">
          {tr(
            `A janela Salvar não está disponível neste sistema. O texto cifrado foi copiado: cole-o em um arquivo chamado ${suggestedName}.`,
            `The save dialog isn't available on this system. The encrypted text was copied: paste it into a file named ${suggestedName}.`
          )}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          onClick={handleCopyExportJson}
          icon={exportCopy.copied ? <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
        >
          {exportCopy.copied ? tr('Copiado', 'Copied') : tr('Copiar texto cifrado', 'Copy encrypted text')}
        </Button>
        <Button variant="ghost" onClick={resetExport}>
          {tr('Exportar com outra senha', 'Export with another passphrase')}
        </Button>
      </div>
      {securityDetails}
    </div>
  );

  const importBody = (
    <form id={importFormId} onSubmit={handleImport} className="space-y-4">
      <p className="text-[13px] text-ink-muted leading-relaxed">
        {tr(
          'Restaure conexões de um backup criado pelo RustSCP em qualquer computador. O arquivo só abre com a senha correta.',
          'Restore connections from a backup made by RustSCP on any computer. The file opens only with the right passphrase.'
        )}
      </p>

      <div>
        <div className="ui-label">{tr('Arquivo de backup', 'Backup file')}</div>
        <input ref={fileInputRef} type="file" accept=".rustscp-vault,.json,application/json" onChange={handleFileUpload} className="hidden" tabIndex={-1} />
        {importFileName ? (
          <div className="flex items-center gap-2.5 rounded-lg border border-line bg-surface-sunken px-3 h-10">
            <FileText className="w-4 h-4 shrink-0 text-ink-muted" aria-hidden="true" />
            <span className="flex-1 min-w-0 truncate text-[13px] text-ink" title={importFileName}>
              {importFileName}
            </span>
            <span className="text-[11.5px] text-ink-faint tabular-nums">{formatKb(new Blob([importJson]).size)}</span>
            <IconButton size="sm" label={tr('Remover arquivo', 'Remove file')} onClick={clearImportFile} className="-mr-1.5">
              <X className="w-3.5 h-3.5" />
            </IconButton>
          </div>
        ) : (
          <Button variant="secondary" data-autofocus="" onClick={() => fileInputRef.current?.click()} icon={<FileText className="w-3.5 h-3.5" />}>
            {tr('Escolher arquivo…', 'Choose file…')}
          </Button>
        )}
      </div>

      <Disclosure label={tr('Colar texto cifrado', 'Paste encrypted text')} defaultOpen={false}>
        <TextArea
          mono
          rows={4}
          value={importJson}
          onChange={(e) => {
            setImportJson(e.target.value);
            setImportFileName(null);
            setImportError(null);
          }}
          placeholder='{"magic":"RUSTSCP_VAULT","version":1,"ciphertext_hex":"..."}'
          aria-label={tr('Texto cifrado do backup', 'Encrypted backup text')}
          className="!text-[11.5px] resize-y"
        />
      </Disclosure>

      <Field label={tr('Senha do backup', 'Backup passphrase')}>
        {(id) => (
          <PasswordInput
            id={id}
            value={importPassword}
            onChange={(v) => {
              setImportPassword(v);
              setImportError(null);
            }}
            visible={showImportPassword}
            onToggleVisible={() => setShowImportPassword((v) => !v)}
            placeholder={tr('A senha usada ao exportar', 'The passphrase used when exporting')}
            autoComplete="current-password"
            showLabel={tr('Mostrar senha', 'Show passphrase')}
            hideLabel={tr('Ocultar senha', 'Hide passphrase')}
          />
        )}
      </Field>

      <Disclosure label={tr('Avançado', 'Advanced')} defaultOpen={mergeMode === 'replace'}>
        <label className="flex items-start gap-2.5 cursor-pointer select-none">
          <input
            type="checkbox"
            className="w-3.5 h-3.5 mt-0.5 accent-red-600"
            checked={mergeMode === 'replace'}
            onChange={(e) => setMergeMode(e.target.checked ? 'replace' : 'merge')}
          />
          <span className="min-w-0">
            <span className="block text-[13px] text-ink">{tr('Substituir todas as conexões salvas', 'Replace all saved connections')}</span>
            <span className="block text-[11.5px] text-ink-faint leading-snug">
              {mergeMode === 'replace' ? (
                <span className="text-red-600 dark:text-red-400">
                  {siteCount === 1
                    ? tr('A conexão salva que não estiver no backup será removida.', 'Your saved connection will be removed if it is not in the backup.')
                    : tr(`As ${siteCount} conexões salvas que não estiverem no backup serão removidas.`, `Any of your ${siteCount} saved connections that are not in the backup will be removed.`)}
                </span>
              ) : (
                tr(
                  'Por padrão as conexões são mescladas: as do backup são adicionadas ou atualizadas e as demais ficam como estão.',
                  'By default connections are merged: the ones in the backup are added or updated and the rest stay as they are.'
                )
              )}
            </span>
          </span>
        </label>
      </Disclosure>

      {importError && errorBox(importError)}
      {importSuccess && (
        <div role="status" className="flex items-start gap-2 rounded-lg bg-emerald-500/10 px-3 py-2 text-[12.5px] text-emerald-800 dark:text-emerald-300">
          <CheckCircle2 className="w-4 h-4 mt-px shrink-0" aria-hidden="true" />
          <span className="break-words min-w-0">{importSuccess}</span>
        </div>
      )}
    </form>
  );

  const footer =
    activeTab === 'export' ? (
      <>
        <Button variant="secondary" onClick={onClose}>
          {tr('Fechar', 'Close')}
        </Button>
        {exportedJson ? (
          <Button variant="primary" onClick={handleSaveVaultFile} loading={isSaving}>
            {savedPath ? tr('Salvar outra cópia…', 'Save another copy…') : tr('Salvar arquivo…', 'Save file…')}
          </Button>
        ) : (
          <Button type="submit" form={exportFormId} variant="primary" loading={isExporting} disabled={!canExport}>
            {tr('Criar backup', 'Create backup')}
          </Button>
        )}
      </>
    ) : (
      <>
        <Button variant="secondary" onClick={onClose}>
          {tr('Fechar', 'Close')}
        </Button>
        <Button type="submit" form={importFormId} variant={mergeMode === 'replace' ? 'danger' : 'primary'} loading={isImporting} disabled={!canImport}>
          {mergeMode === 'replace' ? tr('Substituir e importar', 'Replace and import') : tr('Importar', 'Import')}
        </Button>
      </>
    );

  return createPortal(
    <>
      <Modal
        isOpen
        onClose={onClose}
        size="lg"
        title={tr('Exportar e importar conexões', 'Export and import connections')}
        subtitle={tr('Backup cifrado das conexões salvas, para este ou outro computador.', 'An encrypted backup of your saved connections, for this or another computer.')}
        dismissOnBackdrop={false}
        footer={footer}
      >
        <div className="space-y-5">
          <Segmented<VaultTab>
            value={activeTab}
            onChange={setActiveTab}
            ariaLabel={tr('Ação', 'Action')}
            className="w-full"
            options={[
              { value: 'export', label: tr('Exportar', 'Export') },
              { value: 'import', label: tr('Importar', 'Import') },
            ]}
          />
          {activeTab === 'export' ? exportBody : importBody}
        </div>
      </Modal>

      <ConfirmDialogModal
        isOpen={confirmReplace}
        variant="danger"
        title={
          siteCount === 1
            ? tr('Substituir a conexão salva?', 'Replace your saved connection?')
            : tr(`Substituir as ${siteCount} conexões salvas?`, `Replace all ${siteCount} saved connections?`)
        }
        message={tr(
          'As conexões salvas neste computador que não estiverem no backup serão removidas.',
          'Saved connections on this computer that are not in the backup will be removed.'
        )}
        subMessage={tr('Esta ação não pode ser desfeita. Para manter as atuais, desmarque “Substituir” e importe mesclando.', 'This cannot be undone. To keep your current connections, turn off “Replace” and import with merge.')}
        confirmText={tr('Substituir tudo', 'Replace all')}
        cancelText={tr('Cancelar', 'Cancel')}
        onClose={() => setConfirmReplace(false)}
        onConfirm={async () => {
          setConfirmReplace(false);
          await runImport();
        }}
      />
    </>,
    document.body
  );
};
