import React, { useState } from 'react';
import { Check, Copy, Loader2 } from 'lucide-react';
import { IconButton } from '../ui/controls.tsx';

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface CommandOutputProps {
  result: CommandResult | null;
  running?: boolean;
  isPt: boolean;
  placeholder?: React.ReactNode;
  onClear?: () => void;
  /** Extra controls on the right of the header (e.g. "Stop waiting") */
  actions?: React.ReactNode;
  className?: string;
  /** Classes of the scrolling output area (height) */
  bodyClassName?: string;
}

/** Output beyond this many characters is collapsed behind "Show full output". */
const DISPLAY_LIMIT = 200_000;

function clip(text: string, full: boolean): { text: string; clipped: boolean } {
  if (full || text.length <= DISPLAY_LIMIT) return { text, clipped: false };
  return { text: text.slice(0, DISPLAY_LIMIT), clipped: true };
}

/** Monospace stdout/stderr view with exit status, copy and clear. Shared by the command tools. */
export const CommandOutput: React.FC<CommandOutputProps> = ({
  result,
  running,
  isPt,
  placeholder,
  onClear,
  actions,
  className = '',
  bodyClassName = 'min-h-[140px] max-h-72',
}) => {
  const [copied, setCopied] = useState(false);
  const [showFull, setShowFull] = useState(false);

  const fullText = result ? [result.stdout, result.stderr].filter(Boolean).join(result.stdout && result.stderr ? '\n' : '') : '';
  const stdout = clip(result?.stdout || '', showFull);
  const stderr = clip(result?.stderr || '', showFull);
  const clipped = stdout.clipped || stderr.clipped;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(fullText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className={`ui-card overflow-hidden flex flex-col ${className}`}>
      <div className="flex items-center gap-2 px-3 h-9 border-b border-line shrink-0 select-none">
        <span className="text-[12px] font-medium text-ink-faint">{isPt ? 'Saída' : 'Output'}</span>
        {running && (
          <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-muted">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            {isPt ? 'Executando…' : 'Running…'}
          </span>
        )}
        {!running && result && (
          <span
            className={`text-[11.5px] font-medium tabular-nums ${
              result.exitCode === 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
            }`}
          >
            {result.exitCode === 0
              ? isPt
                ? 'Concluído (código 0)'
                : 'Finished (exit 0)'
              : isPt
                ? `Falhou (código ${result.exitCode})`
                : `Failed (exit ${result.exitCode})`}
          </span>
        )}
        <div className="flex-1" />
        {actions}
        {result && fullText && (
          <IconButton size="sm" label={isPt ? 'Copiar saída' : 'Copy output'} onClick={handleCopy}>
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
          </IconButton>
        )}
        {onClear && result && (
          <button type="button" onClick={onClear} className="ui-btn ui-btn-ghost ui-btn-sm">
            {isPt ? 'Limpar' : 'Clear'}
          </button>
        )}
      </div>
      <div className={`overflow-auto bg-surface-sunken px-3 py-2.5 font-mono text-[12px] leading-relaxed select-text ${bodyClassName}`}>
        {result ? (
          <>
            {stdout.text && <pre className="whitespace-pre-wrap break-words text-ink">{stdout.text}</pre>}
            {stderr.text && (
              <pre className={`whitespace-pre-wrap break-words text-red-600 dark:text-red-400 ${stdout.text ? 'mt-2' : ''}`}>{stderr.text}</pre>
            )}
            {!stdout.text && !stderr.text && (
              <span className="font-sans text-[12px] text-ink-faint">{isPt ? 'Sem saída.' : 'No output.'}</span>
            )}
            {clipped && (
              <button type="button" onClick={() => setShowFull(true)} className="mt-2 ui-btn ui-btn-secondary ui-btn-sm font-sans">
                {isPt ? 'Mostrar saída completa' : 'Show full output'}
              </button>
            )}
          </>
        ) : (
          <span className="font-sans text-[12px] text-ink-faint">{placeholder ?? (isPt ? 'Nada executado ainda.' : 'Nothing run yet.')}</span>
        )}
      </div>
    </div>
  );
};
