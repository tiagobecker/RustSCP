import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, FileKey2, FolderOpen, KeyRound, MessageSquare, Server, ShieldAlert, ShieldCheck } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { ConnectionConfig, Protocol } from '../types.ts';
import { Modal } from './ui/Modal.tsx';
import { Button, Field, TextInput } from './ui/controls.tsx';

/** A `.rustscp` file's name and text (from the OS or the file picker). */
export interface ShareFile {
  name: string;
  contents: string;
}

interface SharePreview {
  name: string;
  protocol: Protocol;
  host: string;
  port: number;
  username: string;
  auth_kind: 'password' | 'key' | 'agent' | 'none';
  key_format: 'ppk' | 'openssh' | 'pem' | null;
  start_path: string;
  note: string;
  created_at: string;
  host_key_fingerprints: string[];
  tls_fingerprint: string | null;
}

interface AcceptedShare {
  site: ConnectionConfig;
  start_path: string;
  host_keys_added: number;
}

interface OpenShareModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** File handed over by the OS (double-click); null shows a file picker. */
  file: ShareFile | null;
  /** Connects the accepted site (and lists it when `saved`). Rejects with the connection error. */
  onOpen: (site: ConnectionConfig, startPath: string, saved: boolean) => Promise<void>;
}

const PROTOCOL_LABELS: Record<string, string> = { sftp: 'SFTP', scp: 'SCP', ftp: 'FTP', ftps: 'FTPS', s3: 'S3', webdav: 'WebDAV', local: 'Local' };

/**
 * Opens a `.rustscp` file: asks for its access code, shows what it holds (server, user,
 * folder, credential kind, verified fingerprint, message) and connects it — for this run
 * only, or saved in the site list. Credentials never reach this window.
 */
export const OpenShareModal: React.FC<OpenShareModalProps> = ({ isOpen, onClose, file, onOpen }) => {
  const { i18n } = useTranslation();
  const isPt = (i18n.language || '').startsWith('pt');
  const tr = (pt: string, en: string) => (isPt ? pt : en);

  const [current, setCurrent] = useState<ShareFile | null>(null);
  const [code, setCode] = useState('');
  const [opened, setOpened] = useState<{ token: string; preview: SharePreview } | null>(null);
  // Accepted but not connected yet (the connection failed): a retry connects it again
  const [accepted, setAccepted] = useState<{ result: AcceptedShare; saved: boolean } | null>(null);
  const [busy, setBusy] = useState<null | 'open' | 'connect' | 'save'>(null);
  const [error, setError] = useState<{ text: string; detail?: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const tokenRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /** Maps the backend's `[share.code] message` errors to a sentence (and keeps the details). */
  const describe = (err: unknown): { text: string; detail?: string } => {
    const raw = String((err as any)?.message ?? err);
    const detail = raw.replace(/^\[share\.[a-z_]+\]\s*/, '');
    if (raw.includes('[share.wrong_code]'))
      return { text: tr('Código incorreto. Confira os 12 caracteres (letras e números; maiúsculas ou minúsculas tanto faz).', 'Wrong code. Check the 12 characters (letters and digits; case does not matter).') };
    if (raw.includes('[share.not_a_share]')) return { text: tr('Este arquivo não é uma conexão compartilhada do RustSCP.', 'This file is not a RustSCP shared connection.') };
    if (raw.includes('[share.unsupported_version]'))
      return { text: tr('Este arquivo foi criado por uma versão mais nova do RustSCP. Atualize o RustSCP para abri-lo.', 'This file was made by a newer RustSCP. Update RustSCP to open it.') };
    if (raw.includes('[share.invalid]')) return { text: tr('O arquivo está danificado ou foi alterado.', 'The file is damaged or was changed.'), detail };
    if (raw.includes('[share.host_key_conflict]'))
      return {
        text: tr(
          'A impressão digital do servidor no arquivo não confere com a que este computador já conhece. Nada foi alterado: confirme com quem enviou.',
          'The server fingerprint in the file does not match the one this computer already knows. Nothing was changed: check with the sender.'
        ),
        detail,
      };
    if (raw.includes('[share.expired]')) return { text: tr('Abra o arquivo novamente.', 'Open the file again.') };
    return { text: detail };
  };

  const discard = () => {
    const token = tokenRef.current;
    tokenRef.current = null;
    if (token) invoke('discard_connection_share', { token }).catch(() => {});
  };

  const loadFile = async (f: ShareFile | null) => {
    setOpened(null);
    setAccepted(null);
    setCode('');
    setError(null);
    setCurrent(f);
    if (!f) return;
    try {
      await invoke('check_connection_share', { contents: f.contents });
      setTimeout(() => codeRef.current?.focus(), 30);
    } catch (err) {
      if (mountedRef.current) {
        setCurrent(null);
        setError(describe(err));
      }
    }
  };

  // Fresh state on every open (or new file from the OS)
  useEffect(() => {
    if (!isOpen) return;
    loadFile(file);
    return discard;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, file]);

  if (!isOpen) return null;

  const handlePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const picked = input.files?.[0];
    input.value = '';
    if (!picked) return;
    if (picked.size > 512 * 1024) {
      setError(describe('[share.not_a_share]'));
      return;
    }
    loadFile({ name: picked.name, contents: await picked.text() });
  };

  const handleOpen = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!current || busy || !code.trim()) return;
    setBusy('open');
    setError(null);
    try {
      const result = await invoke<{ token: string; preview: SharePreview }>('open_connection_share', { contents: current.contents, code });
      if (!mountedRef.current) return;
      discard();
      tokenRef.current = result.token;
      setOpened(result);
    } catch (err) {
      if (mountedRef.current) setError(describe(err));
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  };

  const handleConnect = async (save: boolean) => {
    if (busy) return;
    setBusy(save ? 'save' : 'connect');
    setError(null);
    try {
      let done = accepted;
      if (!done) {
        if (!opened) return;
        const result = await invoke<AcceptedShare>('accept_connection_share', { token: opened.token, save });
        tokenRef.current = null;
        done = { result, saved: save };
        if (mountedRef.current) setAccepted(done);
      }
      await onOpen(done.result.site, done.result.start_path, done.saved);
      if (mountedRef.current) onClose();
    } catch (err) {
      if (mountedRef.current) setError(describe(err));
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  };

  const p = opened?.preview;
  const credential = (preview: SharePreview) => {
    if (preview.auth_kind === 'password') return preview.protocol === 's3' ? tr('Chave secreta (incluída)', 'Secret key (included)') : tr('Senha (incluída)', 'Password (included)');
    if (preview.auth_kind === 'key') {
      const kind = preview.key_format === 'ppk' ? 'PuTTY (.ppk)' : preview.key_format === 'pem' ? 'PEM' : 'OpenSSH';
      return tr(`Chave privada ${kind} (incluída)`, `${kind} private key (included)`);
    }
    if (preview.auth_kind === 'agent') return tr('Nenhuma: usa o agente SSH deste computador', 'None: uses this computer’s SSH agent');
    return tr('Nenhuma', 'None');
  };
  const createdAt = (() => {
    if (!p?.created_at) return '';
    const d = new Date(p.created_at);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(isPt ? 'pt-BR' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' });
  })();

  const footer = accepted ? (
    <>
      <Button variant="ghost" onClick={onClose}>
        {tr('Fechar', 'Close')}
      </Button>
      <Button variant="primary" onClick={() => handleConnect(accepted.saved)} loading={!!busy}>
        {tr('Tentar de novo', 'Try again')}
      </Button>
    </>
  ) : p ? (
    <>
      <Button variant="ghost" onClick={onClose}>
        {tr('Cancelar', 'Cancel')}
      </Button>
      <Button variant="secondary" onClick={() => handleConnect(true)} loading={busy === 'save'} disabled={!!busy && busy !== 'save'}>
        {tr('Salvar e conectar', 'Save and connect')}
      </Button>
      <Button variant="primary" onClick={() => handleConnect(false)} loading={busy === 'connect'} disabled={!!busy && busy !== 'connect'} data-autofocus>
        {tr('Conectar', 'Connect')}
      </Button>
    </>
  ) : (
    <>
      <Button variant="ghost" onClick={onClose}>
        {tr('Cancelar', 'Cancel')}
      </Button>
      {current && (
        <Button variant="primary" type="submit" form="open-share-form" loading={busy === 'open'} disabled={!code.trim()}>
          {tr('Abrir', 'Open')}
        </Button>
      )}
    </>
  );

  const row = (icon: React.ReactNode, label: string, value: React.ReactNode) => (
    <div className="flex items-start gap-3 py-2">
      <div className="w-4 h-4 mt-0.5 shrink-0 text-ink-faint">{icon}</div>
      <div className="w-28 shrink-0 text-[12.5px] text-ink-faint">{label}</div>
      <div className="flex-1 min-w-0 text-[13px] text-ink break-words select-text">{value}</div>
    </div>
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="md"
      icon={<FileKey2 className="w-5 h-5" />}
      title={p ? p.name : tr('Abrir conexão compartilhada', 'Open shared connection')}
      subtitle={p ? tr('Conexão compartilhada', 'Shared connection') + (createdAt ? ` · ${createdAt}` : '') : current?.name}
      footer={footer}
      dismissOnBackdrop={!busy}
    >
      <input ref={fileInputRef} type="file" accept=".rustscp" className="hidden" tabIndex={-1} onChange={handlePick} />

      {!p && !current && (
        <div className="space-y-3">
          <p className="text-[12.5px] text-ink-muted leading-relaxed">
            {tr(
              'Escolha o arquivo .rustscp que você recebeu. Depois digite o código de acesso que veio separado.',
              'Choose the .rustscp file you received. Then type the access code that came separately.'
            )}
          </p>
          <Button onClick={() => fileInputRef.current?.click()} icon={<FolderOpen className="w-3.5 h-3.5" />} data-autofocus>
            {tr('Escolher arquivo…', 'Choose file…')}
          </Button>
        </div>
      )}

      {!p && current && (
        <form id="open-share-form" onSubmit={handleOpen} className="space-y-3">
          <Field label={tr('Código de acesso', 'Access code')} hint={tr('Quem enviou o arquivo tem o código.', 'The sender has the code.')}>
            {(id) => (
              <TextInput
                id={id}
                ref={codeRef}
                mono
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="XXXX-XXXX-XXXX"
                className="!text-[16px] tracking-[0.1em] uppercase"
                maxLength={64}
              />
            )}
          </Field>
          <button type="button" onClick={() => fileInputRef.current?.click()} className="text-[12px] text-ink-faint hover:text-ink underline-offset-2 hover:underline">
            {tr('Escolher outro arquivo…', 'Choose another file…')}
          </button>
        </form>
      )}

      {p && (
        <div className="divide-y divide-line">
          {row(<Server className="w-4 h-4" />, tr('Servidor', 'Server'), (
            <span className="font-mono text-[12.5px]">
              {PROTOCOL_LABELS[p.protocol] ?? p.protocol} · {p.username ? `${p.username}@` : ''}
              {p.host}
              {p.port ? `:${p.port}` : ''}
            </span>
          ))}
          {row(<FolderOpen className="w-4 h-4" />, tr('Abre em', 'Opens in'), p.start_path ? <span className="font-mono text-[12.5px]">{p.start_path}</span> : <span className="text-ink-muted">{tr('Pasta inicial da conexão', 'The connection’s start folder')}</span>)}
          {row(<KeyRound className="w-4 h-4" />, tr('Credencial', 'Credential'), credential(p))}
          {p.protocol === 'sftp' || p.protocol === 'scp'
            ? row(
                p.host_key_fingerprints.length ? <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400" /> : <ShieldAlert className="w-4 h-4 text-amber-600 dark:text-amber-400" />,
                tr('Servidor verificado', 'Verified server'),
                p.host_key_fingerprints.length ? (
                  <span className="font-mono text-[11.5px] text-ink-muted break-all">{p.host_key_fingerprints.join('\n')}</span>
                ) : (
                  <span className="text-ink-muted">{tr('Sem impressão digital: o servidor será confiado na primeira conexão.', 'No fingerprint: the server is trusted on first connection.')}</span>
                )
              )
            : p.tls_fingerprint
              ? row(<ShieldCheck className="w-4 h-4" />, tr('Certificado', 'Certificate'), <span className="font-mono text-[11.5px] text-ink-muted break-all">{p.tls_fingerprint}</span>)
              : null}
          {p.note && row(<MessageSquare className="w-4 h-4" />, tr('Mensagem', 'Message'), <span className="whitespace-pre-wrap">{p.note}</span>)}
          {p.auth_kind === 'agent' || p.auth_kind === 'none' ? (
            <p className="pt-3 text-[12px] text-amber-700 dark:text-amber-400 leading-snug">
              {tr('O arquivo não traz senha nem chave: a conexão vai usar as suas credenciais.', 'The file carries no password or key: the connection uses your own credentials.')}
            </p>
          ) : (
            <p className="pt-3 text-[12px] text-ink-faint leading-snug">
              {tr(
                '“Conectar” abre só nesta execução do RustSCP; “Salvar e conectar” guarda a conexão (com a credencial cifrada) nos seus sites.',
                '“Connect” opens it for this run of RustSCP only; “Save and connect” keeps it (credential encrypted) in your sites.'
              )}
            </p>
          )}
        </div>
      )}

      {error && (
        <div role="alert" className="mt-3 flex items-start gap-2 px-3 py-2.5 rounded-lg bg-red-500/10 text-red-700 dark:text-red-300 text-[12.5px] select-text">
          <AlertCircle className="w-4 h-4 shrink-0 mt-px" />
          <div className="flex-1 min-w-0 break-words">
            {error.text}
            {error.detail && error.detail !== error.text && <div className="mt-1 text-[11.5px] opacity-80 break-words">{error.detail}</div>}
          </div>
        </div>
      )}
    </Modal>
  );
};
