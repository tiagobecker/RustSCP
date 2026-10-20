import React, { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { CornerDownLeft, Loader2, Terminal, Trash2 } from 'lucide-react';
import { Modal } from './ui/Modal.tsx';
import { Button, IconButton } from './ui/controls.tsx';
import { plainTextInputProps } from '../utils/inputHardening.ts';
import { joinPath } from '../utils/paths.ts';
import { AutomationConfirm } from './automation/AutomationConfirm.tsx';

interface ScriptCommandOutput {
  command: string;
  success: boolean;
  output: string;
  /** Remote working directory after the command (newer backends) */
  remote_dir?: string | null;
  /** Local working directory after the command (newer backends) */
  local_dir?: string | null;
}

interface ScriptConsoleModalProps {
  isOpen: boolean;
  onClose: () => void;
  sessionId: string;
  localPath: string;
  remotePath: string;
}

interface ConsoleLine {
  id: number;
  type: 'input' | 'output' | 'error' | 'info';
  text: string;
}

/** Older lines are dropped so long sessions stay responsive. */
const MAX_LINES = 2000;

/** First word and arguments of a console line, honouring simple quotes (display only). */
function splitLine(line: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

export const ScriptConsoleModal: React.FC<ScriptConsoleModalProps> = ({ isOpen, onClose, sessionId, localPath, remotePath }) => {
  const { i18n } = useTranslation();
  const isPt = i18n.language.startsWith('pt');

  const welcome = isPt
    ? 'Console de scripts do RustSCP.\nDigite "help" para ver os comandos, "clear" para limpar e "exit" para fechar.'
    : 'RustSCP script console.\nType "help" for the command list, "clear" to clear the screen and "exit" to close.';

  const lineId = useRef(1);
  const [inputLine, setInputLine] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [isRunning, setIsRunning] = useState(false);
  const [lines, setLines] = useState<ConsoleLine[]>([{ id: 0, type: 'info', text: welcome }]);
  const [cwdRemote, setCwdRemote] = useState(remotePath);
  const [cwdLocal, setCwdLocal] = useState(localPath);
  const [pendingDelete, setPendingDelete] = useState<{ line: string; target: string } | null>(null);

  const outputRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Working directories start at the panes the console was opened from
  useEffect(() => {
    if (!isOpen) return;
    setCwdRemote(remotePath || '/');
    setCwdLocal(localPath || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, sessionId]);

  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [lines, isRunning]);

  if (!isOpen) return null;

  const append = (...items: Array<Omit<ConsoleLine, 'id'>>) =>
    setLines((prev) => [...prev, ...items.map((l) => ({ ...l, id: lineId.current++ }))].slice(-MAX_LINES));

  const focusInput = () => requestAnimationFrame(() => inputRef.current?.focus());

  const run = async (line: string) => {
    append({ type: 'input', text: `${cwdRemote || '/'} $ ${line}` });
    setIsRunning(true);
    try {
      const res = await invoke<ScriptCommandOutput>('execute_script_line', {
        sessionId,
        line,
        localDir: cwdLocal,
        remoteDir: cwdRemote,
      });
      if (typeof res.remote_dir === 'string' && res.remote_dir) {
        setCwdRemote(res.remote_dir);
      } else if (res.success) {
        // Older backends only report the change in the output text
        const m = /^Remote directory changed to: (.+)$/m.exec(res.output || '');
        if (m) setCwdRemote(m[1]);
      }
      if (typeof res.local_dir === 'string' && res.local_dir) {
        setCwdLocal(res.local_dir);
      } else if (res.success) {
        const m = /^Local directory changed to: (.+)$/m.exec(res.output || '');
        if (m) setCwdLocal(m[1]);
      }
      append({
        type: res.success ? 'output' : 'error',
        text: res.output || (res.success ? 'OK' : isPt ? 'O comando falhou' : 'Command failed'),
      });
    } catch (err) {
      append({ type: 'error', text: `${isPt ? 'Erro' : 'Error'}: ${String(err)}` });
    } finally {
      setIsRunning(false);
      focusInput();
    }
  };

  const handleExecute = () => {
    if (isRunning) return;
    const trimmed = inputLine.trim();
    if (!trimmed) return;
    const lower = trimmed.toLowerCase();

    if (lower === 'clear' || lower === 'cls') {
      setLines([]);
      setInputLine('');
      return;
    }
    if (lower === 'exit' || lower === 'quit' || lower === 'bye') {
      setInputLine('');
      onClose();
      return;
    }

    setHistory((prev) => (prev[0] === trimmed ? prev : [trimmed, ...prev].slice(0, 200)));
    setHistoryIndex(-1);
    setInputLine('');

    const [cmd, ...args] = splitLine(trimmed);
    if ((cmd || '').toLowerCase() === 'rm' || (cmd || '').toLowerCase() === 'del') {
      const arg = args[0] || '';
      const target = !arg ? '' : arg.startsWith('/') ? arg : joinPath(cwdRemote || '/', arg);
      if (target) {
        setPendingDelete({ line: trimmed, target });
        return;
      }
    }
    void run(trimmed);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleExecute();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (history.length > 0 && historyIndex < history.length - 1) {
        const nextIdx = historyIndex + 1;
        setHistoryIndex(nextIdx);
        setInputLine(history[nextIdx]);
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIndex > 0) {
        const prevIdx = historyIndex - 1;
        setHistoryIndex(prevIdx);
        setInputLine(history[prevIdx]);
      } else if (historyIndex === 0) {
        setHistoryIndex(-1);
        setInputLine('');
      }
    }
  };

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        size="2xl"
        className="h-[min(720px,calc(100vh-2rem))]"
        padded={false}
        icon={<Terminal className="w-5 h-5" />}
        title={isPt ? 'Console de scripts' : 'Script console'}
        subtitle={isPt ? 'Comandos do RustSCP na sessão atual e no computador local' : 'RustSCP commands on the current session and this computer'}
        initialFocusRef={inputRef}
        headerActions={
          <IconButton size="sm" label={isPt ? 'Limpar console' : 'Clear console'} onClick={() => setLines([])}>
            <Trash2 className="w-4 h-4" />
          </IconButton>
        }
      >
        <div className="h-full flex flex-col border-t border-line">
          <div
            ref={outputRef}
            className="flex-1 min-h-0 overflow-y-auto bg-surface-sunken px-4 py-3 font-mono text-[12px] leading-relaxed space-y-1 select-text"
            onMouseUp={() => {
              if (!window.getSelection()?.toString()) inputRef.current?.focus();
            }}
          >
            {lines.map((l) => (
              <div
                key={l.id}
                className={`whitespace-pre-wrap break-words ${
                  l.type === 'input'
                    ? 'text-ink font-medium'
                    : l.type === 'error'
                      ? 'text-red-600 dark:text-red-400'
                      : l.type === 'info'
                        ? 'text-ink-faint'
                        : 'text-ink-muted'
                }`}
              >
                {l.text}
              </div>
            ))}
            {isRunning && (
              <div className="flex items-center gap-2 text-ink-faint font-sans text-[12px]">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                {isPt ? 'Executando…' : 'Running…'}
              </div>
            )}
          </div>

          <div className="px-4 py-3 border-t border-line shrink-0 space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[12px] text-ink-muted select-none max-w-[45%] truncate" title={cwdRemote}>
                {cwdRemote || '/'} $
              </span>
              <input
                ref={inputRef}
                type="text"
                {...plainTextInputProps}
                value={inputLine}
                onChange={(e) => setInputLine(e.target.value)}
                onKeyDown={handleKeyDown}
                aria-label={isPt ? 'Comando' : 'Command'}
                placeholder={isPt ? 'ex.: ls, cd /var/www, get arquivo.txt, help' : 'e.g. ls, cd /var/www, get file.txt, help'}
                className="ui-input flex-1 font-mono text-[12.5px]"
              />
              <Button
                variant="primary"
                onClick={handleExecute}
                disabled={isRunning || !inputLine.trim()}
                icon={<CornerDownLeft className="w-3.5 h-3.5" />}
              >
                {isPt ? 'Executar' : 'Run'}
              </Button>
            </div>
            <p className="text-[11.5px] text-ink-faint truncate">
              <span>{isPt ? 'Pasta local:' : 'Local folder:'} </span>
              <span className="font-mono" title={cwdLocal}>
                {cwdLocal || '—'}
              </span>
            </p>
          </div>
        </div>
      </Modal>

      <AutomationConfirm
        isOpen={pendingDelete !== null}
        title={isPt ? 'Excluir arquivo do servidor?' : 'Delete file on the server?'}
        message={isPt ? 'O arquivo será excluído permanentemente.' : 'The file will be deleted permanently.'}
        command={pendingDelete?.target}
        confirmLabel={isPt ? 'Excluir' : 'Delete'}
        cancelLabel={isPt ? 'Cancelar' : 'Cancel'}
        onCancel={() => {
          if (pendingDelete) append({ type: 'info', text: `${pendingDelete.line}  (${isPt ? 'cancelado' : 'cancelled'})` });
          setPendingDelete(null);
          focusInput();
        }}
        onConfirm={() => {
          const p = pendingDelete;
          setPendingDelete(null);
          if (p) void run(p.line);
        }}
      />
    </>
  );
};
