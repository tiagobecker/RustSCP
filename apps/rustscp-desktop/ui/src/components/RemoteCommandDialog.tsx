import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Play, Terminal } from 'lucide-react';
import { Modal } from './ui/Modal.tsx';
import { Button } from './ui/controls.tsx';
import { plainTextInputProps } from '../utils/inputHardening.ts';
import { CommandOutput, CommandResult } from './automation/CommandOutput.tsx';

interface RemoteCommandDialogProps {
  isOpen: boolean;
  onClose: () => void;
  remoteSessionName: string;
  onExecute: (cmd: string) => Promise<{ exit_code: number; stdout: string; stderr: string }>;
  /** false when the command runs on this computer (local session); shown clearly in the title */
  isRemote?: boolean;
  /** Folder the command runs in (the caller applies it); shown in the prompt */
  cwd?: string;
}

const HISTORY_KEY = 'rustscp_remote_command_history';
const HISTORY_MAX = 50;

function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string').slice(0, HISTORY_MAX) : [];
  } catch {
    return [];
  }
}

function saveHistory(items: string[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, HISTORY_MAX)));
  } catch {
    /* storage unavailable */
  }
}

export const RemoteCommandDialog: React.FC<RemoteCommandDialogProps> = ({ isOpen, onClose, remoteSessionName, onExecute, isRemote, cwd }) => {
  const { i18n } = useTranslation();
  const isPt = i18n.language.startsWith('pt');
  const isLocal = isRemote === false;

  const [command, setCommand] = useState('uname -a');
  const [result, setResult] = useState<CommandResult | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [history, setHistory] = useState<string[]>(loadHistory);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const runIdRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Closing detaches from a command that is still running, so reopening starts clean
  useEffect(() => {
    if (!isOpen) {
      runIdRef.current++;
      setIsRunning(false);
      setHistoryIndex(-1);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleRun = async () => {
    if (isRunning) return;
    const cmd = command.trim();
    if (!cmd) return;
    const id = ++runIdRef.current;
    setIsRunning(true);
    setResult(null);
    setHistoryIndex(-1);
    setHistory((prev) => {
      const next = [cmd, ...prev.filter((h) => h !== cmd)].slice(0, HISTORY_MAX);
      saveHistory(next);
      return next;
    });
    try {
      const res = await onExecute(cmd);
      if (id !== runIdRef.current) return;
      setResult({ stdout: res.stdout || '', stderr: res.stderr || '', exitCode: res.exit_code });
    } catch (err) {
      if (id !== runIdRef.current) return;
      setResult({ stdout: '', stderr: String(err), exitCode: -1 });
    } finally {
      if (id === runIdRef.current) {
        setIsRunning(false);
        requestAnimationFrame(() => inputRef.current?.focus());
      }
    }
  };

  const handleStopWaiting = () => {
    runIdRef.current++;
    setIsRunning(false);
    setResult({
      stdout: '',
      stderr: isPt
        ? 'Parou de aguardar. O comando pode continuar rodando.'
        : 'Stopped waiting. The command may still be running.',
      exitCode: -1,
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!isRunning) void handleRun();
    } else if (e.key === 'ArrowUp') {
      if (history.length === 0) return;
      e.preventDefault();
      const next = Math.min(historyIndex + 1, history.length - 1);
      setHistoryIndex(next);
      setCommand(history[next]);
    } else if (e.key === 'ArrowDown') {
      if (historyIndex < 0) return;
      e.preventDefault();
      const next = historyIndex - 1;
      setHistoryIndex(next);
      setCommand(next >= 0 ? history[next] : '');
    }
  };

  const title = isLocal ? (isPt ? 'Executar comando neste computador' : 'Run command on this computer') : isPt ? 'Executar comando remoto' : 'Run remote command';

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="xl"
      icon={<Terminal className="w-5 h-5" />}
      title={title}
      subtitle={<span className="font-mono text-[12px]">{remoteSessionName}</span>}
      initialFocusRef={inputRef}
      footer={
        <Button variant="secondary" onClick={onClose}>
          {isPt ? 'Fechar' : 'Close'}
        </Button>
      }
    >
      <div className="space-y-3">
        {isLocal && (
          <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-[12.5px] text-amber-800 dark:text-amber-300">
            {isPt
              ? 'Nenhum servidor SSH está ativo: o comando roda no seu computador, não em um servidor.'
              : 'No SSH server is active: the command runs on your computer, not on a server.'}
          </p>
        )}
        <div>
          <label htmlFor="remote-command-input" className="ui-label">
            {isPt ? 'Comando de shell' : 'Shell command'}
          </label>
          <div className="flex items-center gap-2">
            {cwd && (
              <span className="font-mono text-[12px] text-ink-muted max-w-[35%] truncate select-none" title={cwd}>
                {cwd} $
              </span>
            )}
            <input
              id="remote-command-input"
              ref={inputRef}
              type="text"
              {...plainTextInputProps}
              value={command}
              onChange={(e) => {
                setCommand(e.target.value);
                setHistoryIndex(-1);
              }}
              onKeyDown={handleKeyDown}
              placeholder={isPt ? 'ex.: df -h, systemctl status nginx, ps aux | grep node' : 'e.g. df -h, systemctl status nginx, ps aux | grep node'}
              className="ui-input flex-1 font-mono text-[12.5px]"
            />
            <Button variant="primary" onClick={() => void handleRun()} disabled={!command.trim()} loading={isRunning} icon={<Play className="w-3.5 h-3.5" />}>
              {isRunning ? (isPt ? 'Executando…' : 'Running…') : isPt ? 'Executar' : 'Run'}
            </Button>
          </div>
          <span className="ui-hint">
            {isPt ? 'Enter executa · ↑ e ↓ percorrem o histórico' : 'Enter runs · ↑ and ↓ browse history'}
          </span>
        </div>

        <CommandOutput
          result={result}
          running={isRunning}
          isPt={isPt}
          onClear={() => setResult(null)}
          bodyClassName="h-72"
          placeholder={
            isLocal
              ? isPt
                ? 'Digite um comando e pressione Enter para executar neste computador.'
                : 'Type a command and press Enter to run it on this computer.'
              : isPt
                ? 'Digite um comando e pressione Enter para executar no servidor.'
                : 'Type a command and press Enter to run it on the server.'
          }
          actions={
            isRunning ? (
              <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={handleStopWaiting}>
                {isPt ? 'Parar de aguardar' : 'Stop waiting'}
              </button>
            ) : null
          }
        />
      </div>
    </Modal>
  );
};
