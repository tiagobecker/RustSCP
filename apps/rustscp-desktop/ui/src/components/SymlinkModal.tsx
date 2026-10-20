import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import { Modal } from './ui/Modal.tsx';
import { Button, Disclosure, Field, TextInput } from './ui/controls.tsx';
import { notify } from './ui/toast.tsx';
import { basename, joinPath } from '../utils/paths.ts';

interface SymlinkModalProps {
  isOpen: boolean;
  onClose: () => void;
  sessionId: string;
  currentDir: string;
  selectedItemPath?: string;
  onSuccess: () => void;
}

const isAbsolutePath = (p: string) => p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(p);

export const SymlinkModal: React.FC<SymlinkModalProps> = ({
  isOpen,
  onClose,
  sessionId,
  currentDir,
  selectedItemPath,
  onSuccess,
}) => {
  const { i18n } = useTranslation();
  const isPt = (i18n.language || '').startsWith('pt');
  const tr = (pt: string, en: string) => (isPt ? pt : en);

  const formId = useId();
  const linkNameRef = useRef<HTMLInputElement>(null);
  const targetRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);

  const [linkName, setLinkName] = useState('');
  const [targetPath, setTargetPath] = useState(selectedItemPath || '');
  const [isSymbolic, setIsSymbolic] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // App keeps this modal mounted: start from a clean form, prefilled from the selection, on every open
  useEffect(() => {
    if (!isOpen) return;
    setTargetPath(selectedItemPath || '');
    setLinkName('');
    setIsSymbolic(true);
    setError(null);
    setIsSubmitting(false);
  }, [isOpen, selectedItemPath]);

  if (!isOpen || typeof document === 'undefined') return null;

  const name = linkName.trim();
  const target = targetPath.trim();
  const fullLinkPath = name ? (isAbsolutePath(name) ? name : joinPath(currentDir, name)) : '';
  const suggestedName = target ? basename(target) : '';
  const canCreate = !!name && !!target && !isSubmitting;

  const handleCreate = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!canCreate) return;
    setIsSubmitting(true);
    setError(null);
    try {
      await invoke('create_symlink', {
        sessionId,
        linkPath: fullLinkPath,
        targetPath: target,
        isSymbolic,
      });
      notify.success(isSymbolic ? tr('Link simbólico criado', 'Symbolic link created') : tr('Hard link criado', 'Hard link created'), fullLinkPath);
      onSuccess();
      onClose();
    } catch (err: any) {
      if (mountedRef.current) setError(String(err?.message ?? err));
    } finally {
      if (mountedRef.current) setIsSubmitting(false);
    }
  };

  return createPortal(
    <Modal
      isOpen
      onClose={onClose}
      size="md"
      title={tr('Criar link', 'Create link')}
      subtitle={tr('Um atalho que aponta para outro arquivo ou pasta.', 'A shortcut that points to another file or folder.')}
      dismissOnBackdrop={false}
      initialFocusRef={selectedItemPath ? linkNameRef : targetRef}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {tr('Cancelar', 'Cancel')}
          </Button>
          <Button type="submit" form={formId} variant="primary" disabled={!name || !target} loading={isSubmitting}>
            {isSymbolic ? tr('Criar link', 'Create link') : tr('Criar hard link', 'Create hard link')}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={handleCreate} className="space-y-4">
        <Field
          label={tr('Apontar para', 'Points to')}
          hint={tr('Caminho absoluto ou relativo à pasta do link.', "Absolute path, or relative to the link's folder.")}
        >
          {(id) => (
            <TextInput
              id={id}
              ref={targetRef}
              mono
              value={targetPath}
              onChange={(e) => setTargetPath(e.target.value)}
              placeholder={tr('/var/www/html ou ../pasta', '/var/www/html or ../folder')}
            />
          )}
        </Field>

        <Field
          label={tr('Nome do link', 'Link name')}
          hint={
            fullLinkPath ? (
              <>
                {tr('Será criado em ', 'Will be created at ')}
                <span className="font-mono break-all">{fullLinkPath}</span>
              </>
            ) : (
              <>
                {tr('Criado em ', 'Created in ')}
                <span className="font-mono break-all">{currentDir || '/'}</span>
                {tr(' — ou informe um caminho absoluto.', ' — or enter an absolute path.')}
              </>
            )
          }
        >
          {(id) => (
            <TextInput
              id={id}
              ref={linkNameRef}
              mono
              value={linkName}
              onChange={(e) => setLinkName(e.target.value)}
              placeholder={suggestedName ? `${suggestedName}-link` : tr('meu-link', 'my-link')}
            />
          )}
        </Field>

        <Disclosure label={tr('Avançado', 'Advanced')} defaultOpen={!isSymbolic}>
          <label className="flex items-start gap-2.5 cursor-pointer select-none">
            <input
              type="checkbox"
              className="w-3.5 h-3.5 mt-0.5 accent-rust-500"
              checked={!isSymbolic}
              onChange={(e) => setIsSymbolic(!e.target.checked)}
            />
            <span className="min-w-0">
              <span className="block text-[13px] text-ink">{tr('Criar um hard link', 'Create a hard link instead')}</span>
              <span className="block text-[11.5px] text-ink-faint leading-snug">
                {tr(
                  'Outro nome para o mesmo arquivo. Só funciona com arquivos no mesmo disco, não com pastas.',
                  'Another name for the same file. Works only for files on the same disk, not for folders.'
                )}
              </span>
            </span>
          </label>
        </Disclosure>

        {error && (
          <div role="alert" className="flex items-start gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-[12.5px] text-red-700 dark:text-red-300">
            <AlertTriangle className="w-4 h-4 mt-px shrink-0" aria-hidden="true" />
            <span className="break-words min-w-0">{error}</span>
          </div>
        )}
      </form>
    </Modal>,
    document.body
  );
};
