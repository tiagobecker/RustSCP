import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, Check, Copy, FileKey2, Share2 } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { Modal } from './ui/Modal.tsx';
import { Button, Field, TextArea, TextInput } from './ui/controls.tsx';
import { notify } from './ui/toast.tsx';
import { copyText, useCopyFeedback } from './copyToClipboard.ts';

/** What is shared: a saved site, or the site of an open session (its current folder pre-filled). */
export interface ShareSource {
  siteId?: string;
  sessionId?: string;
  name: string;
  host: string;
  username: string;
  /** Pre-filled "Open in folder". */
  startPath: string;
}

interface CreatedShare {
  contents: string;
  code: string;
  suggested_name: string;
  host_key_count: number;
  auth_kind: 'password' | 'key' | 'agent' | 'none';
  /** Set once the file is saved (or its text handed over). */
  savedPath?: string | null;
  copiedInstead?: boolean;
}

interface ShareConnectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  source: ShareSource | null;
}

/** Strips the `[share.code] ` prefix the backend puts on sharing errors. */
const shareErrorText = (err: unknown) => String((err as any)?.message ?? err).replace(/^\[share\.[a-z_]+\]\s*/, '');

/**
 * Packs one connection into a `.rustscp` file protected by a one-time access code. The file
 * holds the credentials (password, or the private key itself), the server's verified host key
 * and the folder to open; the code is shown here once and goes to the recipient separately.
 */
export const ShareConnectionModal: React.FC<ShareConnectionModalProps> = ({ isOpen, onClose, source }) => {
  const { i18n } = useTranslation();
  const isPt = (i18n.language || '').startsWith('pt');
  const tr = (pt: string, en: string) => (isPt ? pt : en);

  const [startPath, setStartPath] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedShare | null>(null);
  const codeCopy = useCopyFeedback();
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Fresh form on every open
  useEffect(() => {
    if (!isOpen) return;
    setStartPath(source?.startPath ?? '');
    setNote('');
    setBusy(false);
    setError(null);
    setCreated(null);
  }, [isOpen, source]);

  if (!isOpen || !source) return null;

  const saveFile = async (share: CreatedShare) => {
    try {
      const path = await invoke<string | null>('save_text_file_dialog', { contents: share.contents, suggestedName: share.suggested_name });
      if (!path) return false; // cancelled
      if (mountedRef.current) setCreated({ ...share, savedPath: path, copiedInstead: false });
      return true;
    } catch (err) {
      // No native save dialog: never fail silently, hand over the text instead
      const ok = await copyText(share.contents);
      if (!mountedRef.current) return ok;
      if (ok) {
        setCreated({ ...share, savedPath: null, copiedInstead: true });
        notify.warning(
          tr('Não foi possível abrir a janela Salvar', 'The save dialog is unavailable'),
          tr(`O conteúdo do arquivo foi copiado. Cole-o em um arquivo chamado ${share.suggested_name}.`, `The file's contents were copied. Paste them into a file named ${share.suggested_name}.`)
        );
      } else {
        notify.error(tr('Não foi possível salvar o arquivo', 'Could not save the file'), err);
      }
      return ok;
    }
  };

  const handleCreate = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const share = await invoke<CreatedShare>('create_connection_share', {
        siteId: source.siteId ?? null,
        sessionId: source.sessionId ?? null,
        startPath: startPath.trim(),
        note,
      });
      if (!mountedRef.current) return;
      // The code is shown even if the save dialog is cancelled: the file can be saved again from here
      setCreated({ ...share, savedPath: null });
      await saveFile(share);
    } catch (err) {
      if (mountedRef.current) setError(shareErrorText(err));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const handleCopyCode = async () => {
    if (!created) return;
    const ok = await codeCopy.copy(created.code);
    if (!ok) notify.error(tr('Não foi possível copiar', 'Could not copy'), tr('O acesso à área de transferência foi negado.', 'Clipboard access was denied.'));
  };

  const subtitle = `${source.name}${source.host ? ` · ${source.username ? `${source.username}@` : ''}${source.host}` : ''}`;

  const footer = created ? (
    <>
      {!created.savedPath && (
        <Button variant="secondary" onClick={() => saveFile(created)}>
          {tr('Salvar arquivo…', 'Save file…')}
        </Button>
      )}
      <Button variant="primary" onClick={onClose}>
        {tr('Concluir', 'Done')}
      </Button>
    </>
  ) : (
    <>
      <Button variant="ghost" onClick={onClose}>
        {tr('Cancelar', 'Cancel')}
      </Button>
      <Button variant="primary" type="submit" form="share-connection-form" loading={busy}>
        {tr('Criar arquivo…', 'Create file…')}
      </Button>
    </>
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="md"
      icon={<Share2 className="w-5 h-5" />}
      title={tr('Compartilhar conexão', 'Share connection')}
      subtitle={subtitle}
      footer={footer}
      dismissOnBackdrop={!created}
    >
      {!created ? (
        <form id="share-connection-form" onSubmit={handleCreate} className="space-y-4">
          <p className="text-[12.5px] text-ink-muted leading-relaxed">
            {tr(
              'Gera um arquivo .rustscp que abre esta conexão direto no RustSCP de outra pessoa, sem digitar senha ou chave. O arquivo é cifrado e só abre com um código que você envia separado.',
              'Creates a .rustscp file that opens this connection straight in someone else’s RustSCP, with no password or key to type. The file is encrypted and only opens with a code you send separately.'
            )}
          </p>
          <Field label={tr('Abrir na pasta', 'Open in folder')} hint={tr('Deixe vazio para a pasta inicial da conexão.', 'Leave empty for the connection’s start folder.')}>
            {(id) => <TextInput id={id} mono value={startPath} onChange={(e) => setStartPath(e.target.value)} placeholder="/var/www" data-autofocus />}
          </Field>
          <Field label={tr('Mensagem (opcional)', 'Message (optional)')}>
            {(id) => (
              <TextArea
                id={id}
                rows={2}
                maxLength={1000}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={tr('Ex.: o log de erro está em logs/app.log', 'e.g. the error log is in logs/app.log')}
                className="resize-none"
              />
            )}
          </Field>
          {error && (
            <div role="alert" className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-red-500/10 text-red-700 dark:text-red-300 text-[12.5px] select-text">
              <AlertCircle className="w-4 h-4 shrink-0 mt-px" />
              <span className="flex-1 break-words">{error}</span>
            </div>
          )}
        </form>
      ) : (
        <div className="space-y-4">
          <div className="flex items-start gap-2 text-[12.5px] text-ink-muted">
            {created.savedPath ? (
              <>
                <Check className="w-4 h-4 shrink-0 mt-px text-emerald-600 dark:text-emerald-400" />
                <span className="break-all select-text">
                  {tr('Arquivo salvo em ', 'File saved to ')}
                  <span className="font-mono text-ink">{created.savedPath}</span>
                </span>
              </>
            ) : created.copiedInstead ? (
              <>
                <FileKey2 className="w-4 h-4 shrink-0 mt-px" />
                <span>{tr(`Conteúdo copiado: cole-o em um arquivo ${created.suggested_name}.`, `Contents copied: paste them into a file named ${created.suggested_name}.`)}</span>
              </>
            ) : (
              <>
                <FileKey2 className="w-4 h-4 shrink-0 mt-px" />
                <span>{tr('O arquivo ainda não foi salvo.', 'The file is not saved yet.')}</span>
              </>
            )}
          </div>

          <div>
            <div className="ui-label">{tr('Código de acesso', 'Access code')}</div>
            <div className="flex items-center gap-2">
              <div className="flex-1 h-11 px-3 rounded-lg bg-dark-650/60 border border-line flex items-center justify-center font-mono text-[19px] tracking-[0.12em] text-ink select-all" aria-live="polite">
                {created.code}
              </div>
              <Button onClick={handleCopyCode} icon={codeCopy.copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}>
                {codeCopy.copied ? tr('Copiado', 'Copied') : tr('Copiar', 'Copy')}
              </Button>
            </div>
            <p className="ui-hint mt-1.5">
              {tr(
                'Envie o arquivo e o código por canais diferentes (ex.: arquivo por e-mail, código por telefone). O código não fica salvo: anote-o antes de fechar.',
                'Send the file and the code through different channels (e.g. the file by email, the code by phone). The code is not stored anywhere: note it before closing.'
              )}
            </p>
          </div>

          {(created.auth_kind === 'agent' || created.auth_kind === 'none') && (
            <p className="flex items-start gap-2 text-[12px] text-amber-700 dark:text-amber-400 leading-snug">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" />
              {tr(
                'Esta conexão não tem senha nem chave salva, então nenhuma credencial vai no arquivo: quem receber precisará das próprias.',
                'This connection has no saved password or key, so no credentials are in the file: the recipient will need their own.'
              )}
            </p>
          )}
          <p className="text-[12px] text-ink-faint leading-snug">
            {created.host_key_count > 0
              ? tr(
                  'O arquivo leva a impressão digital do servidor: o RustSCP de quem receber recusa um servidor diferente.',
                  'The file carries the server’s fingerprint: the recipient’s RustSCP refuses a different server.'
                )
              : tr(
                  'Este computador ainda não verificou o servidor, então o arquivo não leva sua impressão digital. Conecte uma vez antes de compartilhar para incluí-la.',
                  'This computer has not verified the server yet, so the file carries no fingerprint. Connect once before sharing to include it.'
                )}
          </p>
          <p className="text-[12px] text-ink-faint leading-snug">
            {tr(
              'Quem tiver o arquivo e o código terá a credencial. Para cortar o acesso, troque a senha ou remova a chave do servidor.',
              'Whoever has the file and the code has the credential. To revoke access, change the password or remove the key from the server.'
            )}
          </p>
        </div>
      )}
    </Modal>
  );
};
