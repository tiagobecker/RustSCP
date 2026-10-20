import React, { useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Check, Copy } from 'lucide-react';
import { Modal } from './ui/Modal.tsx';
import { Button } from './ui/controls.tsx';
import { notify } from './ui/toast.tsx';
import { useCopyFeedback } from './copyToClipboard.ts';

interface AboutModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const CORE_RUNTIME = 'Tauri 2 · Rust · Tokio';

export const AboutModal: React.FC<AboutModalProps> = ({ isOpen, onClose }) => {
  const { i18n } = useTranslation();
  const isPt = (i18n.language || '').startsWith('pt');
  const tr = (pt: string, en: string) => (isPt ? pt : en);
  const { copied, copy } = useCopyFeedback(2000);
  const closeRef = useRef<HTMLButtonElement>(null);

  if (!isOpen || typeof document === 'undefined') return null;

  // Injected by vite.config.ts at build time; the fallbacks only show in unusual dev setups
  const version = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';
  const buildTimestamp = typeof __BUILD_TIMESTAMP__ !== 'undefined' ? __BUILD_TIMESTAMP__ : tr('desconhecida', 'unknown');
  const buildNumber = typeof __BUILD_NUMBER__ !== 'undefined' ? __BUILD_NUMBER__ : tr('desconhecido', 'unknown');
  const buildTarget = typeof __BUILD_TARGET__ !== 'undefined' ? __BUILD_TARGET__ : tr('desconhecido', 'unknown');

  const handleCopyDiagnostics = async () => {
    const info = [
      `RustSCP Version: ${version}`,
      `Build Number: ${buildNumber}`,
      `Build Timestamp: ${buildTimestamp}`,
      `Target: ${buildTarget}`,
      `Engine: ${CORE_RUNTIME}`,
      `UI Language: ${i18n.language || 'unknown'}`,
      `User Agent: ${typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown'}`,
    ].join('\n');
    const ok = await copy(info);
    if (!ok) notify.error(tr('Não foi possível copiar', 'Could not copy'), tr('O acesso à área de transferência foi negado.', 'Clipboard access was denied.'));
  };

  const rows: Array<{ label: string; value: string; mono?: boolean }> = [
    { label: tr('Versão', 'Version'), value: version, mono: true },
    { label: tr('Compilação', 'Build'), value: buildNumber, mono: true },
    { label: tr('Data da compilação', 'Build date'), value: buildTimestamp, mono: true },
    { label: tr('Plataforma', 'Platform'), value: buildTarget },
    { label: tr('Núcleo', 'Core runtime'), value: CORE_RUNTIME },
  ];

  const highlights = [
    tr('Dois painéis com abas e sessões independentes', 'Two panes with tabs and independent sessions'),
    tr('Cópia direta entre servidores, sem passar pelo disco local', 'Direct server-to-server copies without touching the local disk'),
  ];

  return createPortal(
    <Modal
      isOpen
      onClose={onClose}
      size="sm"
      title={tr('Sobre o RustSCP', 'About RustSCP')}
      initialFocusRef={closeRef}
      footer={
        <>
          <Button
            variant="ghost"
            className="mr-auto"
            onClick={handleCopyDiagnostics}
            icon={copied ? <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
          >
            {copied ? tr('Copiado', 'Copied') : tr('Copiar diagnóstico', 'Copy diagnostics')}
          </Button>
          <Button ref={closeRef} variant="primary" onClick={onClose}>
            {tr('Fechar', 'Close')}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="flex flex-col items-center text-center pt-1">
          <img
            src="/icon.png"
            alt=""
            className="w-16 h-16 object-contain select-none"
            draggable={false}
            onError={(e) => {
              e.currentTarget.style.visibility = 'hidden';
            }}
          />
          <div className="mt-3 text-[16px] font-semibold text-ink">RustSCP</div>
          <div className="text-[12.5px] text-ink-muted">
            {tr('Versão', 'Version')} <span className="font-mono">{version}</span>
          </div>
          <p className="mt-1.5 text-[12.5px] text-ink-faint leading-snug max-w-[18rem]">
            {tr('Gerenciador de arquivos em dois painéis para SFTP, FTP e S3.', 'Dual-pane file manager for SFTP, FTP and S3.')}
          </p>
        </div>

        <dl className="ui-card divide-y divide-line">
          {rows.map((r) => (
            <div key={r.label} className="flex items-center gap-3 px-3.5 py-2">
              <dt className="text-[12px] text-ink-faint shrink-0">{r.label}</dt>
              <dd className={`ml-auto min-w-0 text-right text-ink truncate select-text ${r.mono ? 'font-mono text-[12px]' : 'text-[12.5px]'}`} title={r.value}>
                {r.value}
              </dd>
            </div>
          ))}
        </dl>

        <ul className="space-y-1 text-[12px] text-ink-muted">
          {highlights.map((h) => (
            <li key={h} className="flex gap-2">
              <span className="text-ink-faint" aria-hidden="true">
                ·
              </span>
              <span>{h}</span>
            </li>
          ))}
        </ul>
      </div>
    </Modal>,
    document.body
  );
};

