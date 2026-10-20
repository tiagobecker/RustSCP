import React, { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { Check, Code, Copy, Loader2 } from 'lucide-react';
import { Modal } from './ui/Modal.tsx';
import { Button, Segmented } from './ui/controls.tsx';

interface ConnectionConfig {
  id: string;
  name: string;
  protocol: string;
  host: string;
  port: number;
  username: string;
  auth: any;
  remote_root: string;
}

interface GenerateCodeModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Shown in the footer only; the code is generated from the session on the backend */
  config: ConnectionConfig | null;
  remotePath: string;
  localPath: string;
  /** Session whose connection settings are used (the backend reads its config; nothing secret is sent) */
  sessionId?: string;
}

type LangId = 'batch_script' | 'session_url' | 'curl' | 'python' | 'bash_rsync' | 'dotnet';

export const GenerateCodeModal: React.FC<GenerateCodeModalProps> = ({ isOpen, onClose, config, remotePath, localPath, sessionId }) => {
  const { i18n } = useTranslation();
  const isPt = i18n.language.startsWith('pt');

  const [selectedLang, setSelectedLang] = useState<LangId>('batch_script');
  const [generatedCode, setGeneratedCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const requestRef = useRef(0);

  const languages: Array<{ value: LangId; label: string; title: string }> = [
    { value: 'batch_script', label: 'Script', title: isPt ? 'Script em lote (WinSCP)' : 'Batch script (WinSCP)' },
    { value: 'session_url', label: 'URL', title: isPt ? 'URL da sessão' : 'Session URL' },
    { value: 'curl', label: 'cURL', title: 'cURL' },
    { value: 'python', label: 'Python', title: 'Python (Paramiko)' },
    { value: 'bash_rsync', label: 'rsync', title: 'rsync (bash)' },
    { value: 'dotnet', label: '.NET', title: '.NET C# (SSH.NET)' },
  ];

  useEffect(() => {
    if (!isOpen) return;
    if (!sessionId) {
      setGeneratedCode('');
      setError(isPt ? 'Nenhuma sessão ativa para gerar o código.' : 'No active session to generate code from.');
      return;
    }
    const id = ++requestRef.current;
    setIsLoading(true);
    setError(null);
    invoke<string>('generate_automation_code', {
      sessionId,
      targetLanguage: selectedLang,
      remotePath: remotePath || '/',
      localPath: localPath || '.',
    })
      .then((code) => {
        if (id !== requestRef.current) return;
        setGeneratedCode(code);
      })
      .catch((err) => {
        if (id !== requestRef.current) return;
        setGeneratedCode('');
        setError(String(err));
      })
      .finally(() => {
        if (id === requestRef.current) setIsLoading(false);
      });
  }, [isOpen, sessionId, selectedLang, remotePath, localPath, isPt]);

  if (!isOpen) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(generatedCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  const current = languages.find((l) => l.value === selectedLang);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="xl"
      icon={<Code className="w-5 h-5" />}
      title={isPt ? 'Gerar código e URL' : 'Generate code & URL'}
      subtitle={isPt ? 'Scripts prontos para automatizar esta conexão' : 'Ready-to-run scripts that automate this connection'}
      footer={
        <>
          {config && (
            <span className="mr-auto min-w-0 truncate font-mono text-[12px] text-ink-faint">
              {config.name} · {config.protocol}://{config.host}
            </span>
          )}
          <Button variant="secondary" onClick={onClose}>
            {isPt ? 'Fechar' : 'Close'}
          </Button>
          <Button
            variant="primary"
            onClick={handleCopy}
            disabled={!generatedCode || isLoading}
            icon={copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
          >
            {copied ? (isPt ? 'Copiado' : 'Copied') : isPt ? 'Copiar código' : 'Copy code'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <Segmented value={selectedLang} onChange={setSelectedLang} options={languages} ariaLabel={isPt ? 'Formato' : 'Format'} />
          <span className="text-[12px] text-ink-faint">{current?.title}</span>
        </div>

        <div className="relative rounded-lg border border-line bg-surface-sunken min-h-[240px] max-h-[48vh] overflow-auto">
          {isLoading && (
            <Loader2 className="absolute right-3 top-3 w-4 h-4 animate-spin text-ink-faint" aria-label={isPt ? 'Gerando' : 'Generating'} />
          )}
          {error ? (
            <p className="p-4 text-[12.5px] text-red-600 dark:text-red-400 whitespace-pre-wrap">
              {isPt ? 'Não foi possível gerar o código: ' : 'Could not generate code: '}
              {error}
            </p>
          ) : (
            <pre className="p-4 font-mono text-[12px] leading-relaxed text-ink whitespace-pre-wrap break-words select-text">{generatedCode}</pre>
          )}
        </div>

        <p className="text-[11.5px] text-ink-faint leading-snug">
          {isPt
            ? 'Por segurança o código nunca inclui senhas salvas: ele lê RUSTSCP_PASSWORD (ou RUSTSCP_KEY_PASSPHRASE) do ambiente.'
            : 'For safety the code never embeds saved passwords: it reads RUSTSCP_PASSWORD (or RUSTSCP_KEY_PASSPHRASE) from the environment.'}
        </p>
      </div>
    </Modal>
  );
};
