import React, { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { HardDrive, Copy, Check, RefreshCw, AlertTriangle } from 'lucide-react';
import { Modal } from './ui/Modal.tsx';
import { Button, Disclosure, IconButton } from './ui/controls.tsx';
import { notify } from './ui/toast.tsx';

interface FileSystemInfo {
  path: string;
  total_bytes: number;
  free_bytes: number;
  available_bytes: number;
  used_bytes: number;
  total_inodes: number | null;
  free_inodes: number | null;
  protocol_name: string;
  protocol_version: string;
  host_key_fingerprint_sha256: string | null;
  host_key_fingerprint_md5: string | null;
  cipher_name: string | null;
  compression_name: string | null;
}

interface FileSystemInfoModalProps {
  isOpen: boolean;
  onClose: () => void;
  sessionId: string;
  path: string;
}

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export const FileSystemInfoModal: React.FC<FileSystemInfoModalProps> = ({ isOpen, onClose, sessionId, path }) => {
  const { i18n } = useTranslation();
  const isPt = (i18n.language || 'en').toLowerCase().startsWith('pt');
  const tr = (pt: string, en: string) => (isPt ? pt : en);

  const [info, setInfo] = useState<FileSystemInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const requestSeq = useRef(0);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadInfo = async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const res = await invoke<FileSystemInfo>('get_filesystem_info', { sessionId, path: path || '/' });
      if (seq !== requestSeq.current) return; // a newer request (other session/path) is in flight
      setInfo(res);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  };

  useEffect(() => {
    requestSeq.current++;
    setInfo(null);
    setError(null);
    if (isOpen) void loadInfo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, sessionId, path]);

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    []
  );

  const hasSpace = !!info && info.total_bytes > 0;
  const usedPct = hasSpace ? Math.min(100, Math.round((info!.used_bytes / info!.total_bytes) * 100)) : 0;
  const na = tr('Não disponível', 'Not available');

  const handleCopy = async (key: string, text: string) => {
    if (await copyText(text)) {
      setCopied(key);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(null), 1800);
    } else {
      notify.error(tr('Não foi possível copiar', 'Could not copy'), tr('A área de transferência não está disponível.', 'The clipboard is not available.'));
    }
  };

  const summaryText = () => {
    if (!info) return '';
    return [
      'RustSCP server & filesystem information',
      `Path: ${info.path}`,
      `Total space: ${hasSpace ? formatBytes(info.total_bytes) : 'N/A'}`,
      `Used space: ${hasSpace ? `${formatBytes(info.used_bytes)} (${usedPct}%)` : 'N/A'}`,
      `Available space: ${hasSpace ? formatBytes(info.available_bytes) : 'N/A'}`,
      `Inodes (free / total): ${info.free_inodes != null ? `${info.free_inodes} / ${info.total_inodes ?? '?'}` : 'N/A'}`,
      `Protocol: ${info.protocol_name} (${info.protocol_version})`,
      `SSH host key (SHA-256): ${info.host_key_fingerprint_sha256 || 'N/A'}`,
      `SSH host key (MD5): ${info.host_key_fingerprint_md5 || 'N/A'}`,
      `Cipher: ${info.cipher_name || 'N/A'}`,
      `Compression: ${info.compression_name || 'N/A'}`,
    ].join('\n');
  };

  const barColor = usedPct > 90 ? 'bg-red-500' : usedPct > 75 ? 'bg-amber-500' : 'bg-rust-500';

  const detailRow = (label: string, value: string | null | undefined, mono?: boolean, copyKey?: string) => (
    <div key={label} className="flex items-start gap-3 px-3.5 py-2 min-h-[36px]">
      <span className="w-40 shrink-0 text-[12.5px] text-ink-muted pt-0.5">{label}</span>
      <span className={`flex-1 min-w-0 break-all text-[12.5px] ${value ? 'text-ink' : 'text-ink-faint'} ${mono ? 'font-mono text-[12px] select-all' : ''}`}>
        {value || na}
      </span>
      {copyKey && value && (
        <IconButton size="sm" label={tr(`Copiar ${label}`, `Copy ${label}`)} onClick={() => void handleCopy(copyKey, value)} className="-my-1">
          {copied === copyKey ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
        </IconButton>
      )}
    </div>
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      icon={<HardDrive className="w-4 h-4" />}
      title={tr('Disco e servidor', 'Disk & server info')}
      subtitle={
        <span className="block font-mono text-[11.5px] truncate" title={path || '/'}>
          {path || '/'}
        </span>
      }
      headerActions={
        <IconButton size="sm" label={tr('Atualizar', 'Refresh')} onClick={() => void loadInfo()} disabled={loading}>
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </IconButton>
      }
      bodyClassName="space-y-4"
      footer={
        <>
          <Button
            variant="ghost"
            className="mr-auto"
            onClick={() => void handleCopy('all', summaryText())}
            disabled={!info}
            icon={copied === 'all' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
          >
            {copied === 'all' ? tr('Copiado', 'Copied') : tr('Copiar informações', 'Copy info')}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {tr('Fechar', 'Close')}
          </Button>
        </>
      }
    >
      {error ? (
        <div className="flex items-start gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-[12.5px] text-red-700 dark:text-red-300" role="alert">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </div>
      ) : !info ? (
        <div className="py-12 text-center text-[13px] text-ink-muted">{loading ? tr('Consultando o servidor…', 'Asking the server…') : ''}</div>
      ) : (
        <>
          <div className="space-y-2">
            {hasSpace ? (
              <>
                <div className="flex items-baseline justify-between gap-3">
                  <div className="text-[15px] text-ink">
                    <span className="font-semibold tabular-nums">{formatBytes(info.available_bytes)}</span>{' '}
                    <span className="text-ink-muted">
                      {tr('disponíveis de', 'available of')} <span className="tabular-nums">{formatBytes(info.total_bytes)}</span>
                    </span>
                  </div>
                  <span className="text-[12.5px] text-ink-muted tabular-nums">{tr(`${usedPct}% usado`, `${usedPct}% used`)}</span>
                </div>
                <div
                  className="h-2 w-full rounded-full bg-dark-650 overflow-hidden"
                  role="meter"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={usedPct}
                  aria-label={tr('Espaço usado', 'Space used')}
                >
                  <div className={`h-full rounded-full transition-[width] duration-500 ${barColor}`} style={{ width: `${usedPct}%` }} />
                </div>
                <div className="flex flex-wrap gap-x-6 gap-y-1 text-[12px] text-ink-muted tabular-nums">
                  <span>
                    {tr('Usado', 'Used')}: <span className="text-ink">{formatBytes(info.used_bytes)}</span>
                  </span>
                  <span>
                    {tr('Disponível', 'Available')}: <span className="text-ink">{formatBytes(info.available_bytes)}</span>
                  </span>
                  <span>
                    {tr('Total', 'Total')}: <span className="text-ink">{formatBytes(info.total_bytes)}</span>
                  </span>
                </div>
                {usedPct > 90 && (
                  <p className="text-[12px] text-red-600 dark:text-red-400">{tr('O disco está quase cheio.', 'The disk is almost full.')}</p>
                )}
              </>
            ) : (
              <p className="text-[13px] text-ink-muted">
                {tr('Este servidor não informa o espaço em disco.', 'This server doesn’t report disk space.')}
              </p>
            )}
            {info.free_inodes != null && info.free_inodes === 0 && (
              <p className="text-[12px] text-red-600 dark:text-red-400">
                {tr('Não há inodes livres: não é possível criar arquivos novos.', 'No free inodes left: new files can’t be created.')}
              </p>
            )}
          </div>

          <Disclosure label={tr('Detalhes', 'Details')}>
            <div className="ui-card divide-y divide-line">
              {detailRow(
                tr('Inodes livres / total', 'Free / total inodes'),
                info.free_inodes != null
                  ? `${info.free_inodes.toLocaleString()} / ${info.total_inodes != null ? info.total_inodes.toLocaleString() : '?'}`
                  : null,
                true
              )}
              {detailRow(tr('Protocolo', 'Protocol'), info.protocol_name)}
              {detailRow(tr('Versão do protocolo', 'Protocol version'), info.protocol_version, true)}
              {detailRow(tr('Cifra', 'Cipher'), info.cipher_name, true)}
              {detailRow(tr('Compressão', 'Compression'), info.compression_name, true)}
              {detailRow(tr('Chave do host (SHA-256)', 'Host key (SHA-256)'), info.host_key_fingerprint_sha256, true, 'sha256')}
              {detailRow(tr('Chave do host (MD5)', 'Host key (MD5)'), info.host_key_fingerprint_md5, true, 'md5')}
            </div>
          </Disclosure>
        </>
      )}
    </Modal>
  );
};
