import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { FileText, Folder, Link2, File as FileIcon, AlertTriangle } from 'lucide-react';
import { FileEntry } from '../types.ts';
import { Modal } from './ui/Modal.tsx';
import { Button, Disclosure, TextInput } from './ui/controls.tsx';
import { notify } from './ui/toast.tsx';

interface FilePropertiesModalProps {
  isOpen: boolean;
  onClose: () => void;
  file: FileEntry | null;
  onApplyPermissions: (path: string, mode: number) => Promise<void>;
  /**
   * False for sessions whose protocol has no chmod (S3, FTP): the permissions are shown read-only
   * with an explanation instead of pretending a change succeeded. Defaults to true.
   */
  permissionsSupported?: boolean;
}

const PERM_MASK = 0o7777;
const SPECIAL_MASK = 0o7000;
const SETUID = 0o4000;
const SETGID = 0o2000;
const STICKY = 0o1000;
/** 3 digits edit rwx only (special bits are kept); 4 digits set the special bits too. */
const OCTAL_RE = /^[0-7]{3,4}$/;

const formatOctal = (m: number) => (m & PERM_MASK).toString(8).padStart(4, '0');

/** `ls -l` style string, including s/S and t/T for the special bits. */
function symbolicMode(mode: number, kind: FileEntry['file_type']): string {
  const bit = (mask: number, ch: string) => (mode & mask ? ch : '-');
  const special = (execMask: number, specialMask: number, on: string) => {
    const x = (mode & execMask) !== 0;
    if (mode & specialMask) return x ? on : on.toUpperCase();
    return x ? 'x' : '-';
  };
  const prefix = kind === 'directory' ? 'd' : kind === 'symlink' ? 'l' : '-';
  return (
    prefix +
    bit(0o400, 'r') +
    bit(0o200, 'w') +
    special(0o100, SETUID, 's') +
    bit(0o040, 'r') +
    bit(0o020, 'w') +
    special(0o010, SETGID, 's') +
    bit(0o004, 'r') +
    bit(0o002, 'w') +
    special(0o001, STICKY, 't')
  );
}

function formatSize(bytes: number, locale: string): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const exact = `${bytes.toLocaleString(locale)} bytes`;
  if (bytes < 1024) return exact;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const human = `${v.toLocaleString(locale, { maximumFractionDigits: v < 10 ? 1 : 0 })} ${units[i]}`;
  return `${human} (${exact})`;
}

function formatDate(value: string | undefined, locale: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString(locale);
}

export const FilePropertiesModal: React.FC<FilePropertiesModalProps> = ({
  isOpen,
  onClose,
  file,
  onApplyPermissions,
  permissionsSupported = true,
}) => {
  const { i18n } = useTranslation();
  const isPt = (i18n.language || '').startsWith('pt');
  const tr = (pt: string, en: string) => (isPt ? pt : en);
  const locale = isPt ? 'pt-BR' : 'en-US';

  const formId = useId();
  const octalId = useId();
  const octalInputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);

  const rawMode = file?.permissions?.mode;
  // `??`, not `||`: a real mode of 000 must be shown as 000, not as an invented 0644
  const originalMode = (typeof rawMode === 'number' ? rawMode : 0o644) & PERM_MASK;

  const [mode, setMode] = useState<number>(originalMode);
  const [octalText, setOctalText] = useState<string>(formatOctal(originalMode));
  const [isApplying, setIsApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState<boolean>((originalMode & SPECIAL_MASK) !== 0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Re-seed whenever another file is shown (the modal may stay mounted between uses)
  useEffect(() => {
    if (!isOpen || !file) return;
    setMode(originalMode);
    setOctalText(formatOctal(originalMode));
    setError(null);
    setIsApplying(false);
    setAdvancedOpen((originalMode & SPECIAL_MASK) !== 0);
  }, [isOpen, file?.path, originalMode]);

  if (!isOpen || !file || typeof document === 'undefined') return null;

  const octalValid = OCTAL_RE.test(octalText.trim());
  const editable = permissionsSupported;
  const changed = mode !== originalMode;
  const isDir = file.file_type === 'directory';

  // Removing the owner's r/w (or x on a folder) can lock the user out, especially over SFTP
  const ownerLossMask = isDir ? 0o700 : 0o600;
  const losesOwnerAccess = changed && (originalMode & ownerLossMask & ~mode) !== 0;

  const setModeAndText = (next: number) => {
    const m = next & PERM_MASK;
    setMode(m);
    setOctalText(formatOctal(m));
    setError(null);
  };

  const toggleBit = (mask: number, on: boolean) => setModeAndText(on ? mode | mask : mode & ~mask);

  const handleOctalChange = (val: string) => {
    setOctalText(val);
    setError(null);
    const t = val.trim();
    if (!OCTAL_RE.test(t)) return;
    const parsed = parseInt(t, 8);
    setMode(t.length === 3 ? (mode & SPECIAL_MASK) | parsed : parsed);
  };

  const handleApply = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!editable || isApplying) return;
    // The inline hint under the field already explains what is wrong
    if (!octalValid) {
      octalInputRef.current?.focus();
      return;
    }
    if (!changed) {
      onClose();
      return;
    }
    setIsApplying(true);
    setError(null);
    try {
      await onApplyPermissions(file.path, mode);
      notify.success(tr('Permissões atualizadas', 'Permissions updated'), `${file.name} → ${formatOctal(mode)}`);
      onClose();
    } catch (err) {
      if (mountedRef.current) setError(String((err as any)?.message ?? err));
    } finally {
      if (mountedRef.current) setIsApplying(false);
    }
  };

  const KindIcon = isDir ? Folder : file.file_type === 'symlink' ? Link2 : file.file_type === 'file' ? FileText : FileIcon;
  const kindLabel = isDir
    ? tr('Pasta', 'Folder')
    : file.file_type === 'symlink'
      ? tr('Link simbólico', 'Symbolic link')
      : file.file_type === 'file'
        ? tr('Arquivo', 'File')
        : tr('Outro', 'Other');
  const modified = formatDate(file.modified_at, locale);
  const created = formatDate(file.created_at, locale);
  const owner = file.permissions?.owner;
  const group = file.permissions?.group;

  const rows: Array<{ label: string; shift: number }> = [
    { label: tr('Dono', 'Owner'), shift: 6 },
    { label: tr('Grupo', 'Group'), shift: 3 },
    { label: tr('Outros', 'Others'), shift: 0 },
  ];
  const cols: Array<{ label: string; bit: number }> = [
    { label: tr('Leitura', 'Read'), bit: 4 },
    { label: tr('Escrita', 'Write'), bit: 2 },
    { label: tr('Execução', 'Execute'), bit: 1 },
  ];

  const specials: Array<{ mask: number; label: string; hint: string }> = [
    {
      mask: SETUID,
      label: 'setuid',
      hint: tr('Executa com as permissões do dono do arquivo.', "Runs with the file owner's privileges."),
    },
    {
      mask: SETGID,
      label: 'setgid',
      hint: isDir
        ? tr('Novos itens herdam o grupo desta pasta.', "New items inherit this folder's group.")
        : tr('Executa com as permissões do grupo do arquivo.', "Runs with the file group's privileges."),
    },
    {
      mask: STICKY,
      label: 'sticky',
      hint: isDir
        ? tr('Só o dono de cada item pode excluí-lo ou renomeá-lo.', 'Only the owner of an item can delete or rename it.')
        : tr('Sem efeito na maioria dos sistemas para arquivos.', 'Has no effect on files on most systems.'),
    },
  ];

  const metaRow = (label: string, value: React.ReactNode, mono = false) => (
    <div className="flex gap-3 py-1">
      <dt className="w-24 shrink-0 text-[12px] text-ink-faint">{label}</dt>
      <dd className={`min-w-0 flex-1 text-[12.5px] text-ink break-words ${mono ? 'font-mono text-[12px]' : ''}`}>{value}</dd>
    </div>
  );

  return createPortal(
    <Modal
      isOpen
      onClose={onClose}
      size="md"
      title={tr('Propriedades', 'Properties')}
      dismissOnBackdrop={!changed}
      initialFocusRef={editable ? octalInputRef : undefined}
      footer={
        editable ? (
          <>
            <Button variant="secondary" onClick={onClose}>
              {tr('Cancelar', 'Cancel')}
            </Button>
            <Button type="submit" form={formId} variant="primary" loading={isApplying} disabled={!octalValid}>
              {tr('Aplicar', 'Apply')}
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={onClose}>
            {tr('Fechar', 'Close')}
          </Button>
        )
      }
    >
      <form id={formId} onSubmit={handleApply} className="space-y-5">
        {/* Summary */}
        <div className="flex items-start gap-3">
          <KindIcon className="w-8 h-8 mt-0.5 shrink-0 text-ink-muted" strokeWidth={1.5} aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div className="text-[13.5px] font-medium text-ink break-words">{file.name}</div>
            <div className="font-mono text-[11.5px] text-ink-faint break-all select-text">{file.path}</div>
          </div>
        </div>

        <dl className="-my-1">
          {metaRow(tr('Tipo', 'Kind'), kindLabel)}
          {metaRow(tr('Tamanho', 'Size'), formatSize(file.size, locale))}
          {modified && metaRow(tr('Modificado', 'Modified'), modified)}
          {created && metaRow(tr('Criado', 'Created'), created)}
          {(owner || group) && metaRow(tr('Dono / grupo', 'Owner / group'), `${owner || '—'} / ${group || '—'}`, true)}
        </dl>

        {/* Permissions */}
        <section className="space-y-2">
          <h3 className="text-[12px] font-medium text-ink-faint">{tr('Permissões', 'Permissions')}</h3>

          {!editable && (
            <p className="text-[12px] text-ink-muted leading-snug">
              {tr(
                'Este tipo de conexão (S3, FTP) não permite alterar permissões Unix.',
                'This connection type (S3, FTP) does not support changing Unix permissions.'
              )}
            </p>
          )}

          <div className="ui-card overflow-hidden">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="text-[11.5px] text-ink-faint">
                  <th className="py-2 pl-3.5 pr-2 text-left font-medium" />
                  {cols.map((c) => (
                    <th key={c.bit} className="py-2 px-2 text-center font-medium w-20">
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line border-t border-line">
                {rows.map((r) => (
                  <tr key={r.shift}>
                    <td className="py-2 pl-3.5 pr-2 text-ink">{r.label}</td>
                    {cols.map((c) => {
                      const mask = c.bit << r.shift;
                      return (
                        <td key={c.bit} className="py-2 px-2 text-center">
                          <input
                            type="checkbox"
                            className="w-3.5 h-3.5 accent-rust-500 cursor-pointer disabled:cursor-not-allowed"
                            checked={(mode & mask) !== 0}
                            disabled={!editable}
                            onChange={(e) => toggleBit(mask, e.target.checked)}
                            aria-label={`${r.label}: ${c.label}`}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center gap-3 pt-1">
            <label htmlFor={octalId} className="text-[12.5px] text-ink-muted">
              {tr('Octal', 'Octal')}
            </label>
            <TextInput
              id={octalId}
              ref={octalInputRef}
              mono
              inputMode="numeric"
              maxLength={4}
              value={octalText}
              disabled={!editable}
              onChange={(e) => handleOctalChange(e.target.value)}
              aria-invalid={!octalValid}
              aria-describedby={`${octalId}-hint`}
              className={`!w-20 text-center ${!octalValid ? '!border-red-500/70' : ''}`}
            />
            <span className="font-mono text-[12px] text-ink-faint select-text" aria-label={tr('Modo simbólico', 'Symbolic mode')}>
              {symbolicMode(mode, file.file_type)}
            </span>
          </div>
          <p id={`${octalId}-hint`} className={`text-[11.5px] leading-snug ${octalValid ? 'text-ink-faint' : 'text-red-600 dark:text-red-400'}`}>
            {octalValid
              ? tr('3 dígitos mudam rwx e mantêm setuid/setgid/sticky; 4 dígitos definem tudo.', '3 digits change rwx and keep setuid/setgid/sticky; 4 digits set everything.')
              : tr('Use 3 ou 4 dígitos octais (0–7), por exemplo 755 ou 0644.', 'Use 3 or 4 octal digits (0–7), for example 755 or 0644.')}
          </p>

          {losesOwnerAccess && editable && (
            <p className="flex items-start gap-1.5 text-[12px] leading-snug text-amber-700 dark:text-amber-400">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
              <span>
                {isDir
                  ? tr(
                      'Isto remove leitura, escrita ou acesso do dono a esta pasta. Talvez não seja possível abri-la ou desfazer a mudança depois.',
                      "This removes the owner's read, write or access permission on this folder. You may not be able to open it or undo the change afterwards."
                    )
                  : tr(
                      'Isto remove a leitura ou escrita do dono. Talvez não seja possível abrir ou alterar o arquivo depois.',
                      "This removes the owner's read or write permission. You may not be able to open or change the file afterwards."
                    )}
              </span>
            </p>
          )}
        </section>

        <Disclosure label={tr('Avançado', 'Advanced')} open={advancedOpen} onOpenChange={setAdvancedOpen}>
          <div className="ui-card divide-y divide-line">
            {specials.map((s) => (
              <label key={s.mask} className={`flex items-start gap-3 px-3.5 py-2.5 ${editable ? 'cursor-pointer' : 'cursor-not-allowed'}`}>
                <input
                  type="checkbox"
                  className="w-3.5 h-3.5 mt-0.5 accent-rust-500"
                  checked={(mode & s.mask) !== 0}
                  disabled={!editable}
                  onChange={(e) => toggleBit(s.mask, e.target.checked)}
                />
                <span className="min-w-0">
                  <span className="block font-mono text-[12.5px] text-ink">{s.label}</span>
                  <span className="block text-[11.5px] text-ink-faint leading-snug">{s.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </Disclosure>

        {error && (
          <div role="alert" className="flex items-start gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-[12.5px] text-red-700 dark:text-red-300">
            <AlertTriangle className="w-4 h-4 mt-px shrink-0" aria-hidden="true" />
            <span className="break-words min-w-0">
              {tr('Não foi possível aplicar as permissões: ', 'Could not apply the permissions: ')}
              {error}
            </span>
          </div>
        )}
      </form>
    </Modal>,
    document.body
  );
};
