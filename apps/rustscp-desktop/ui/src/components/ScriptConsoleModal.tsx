import React, { useState, useRef, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { Terminal, X, CornerDownLeft, Trash2 } from 'lucide-react';

interface ScriptCommandOutput {
  command: String;
  success: boolean;
  output: string;
}

interface ScriptConsoleModalProps {
  isOpen: boolean;
  onClose: () => void;
  sessionId: string;
  localPath: string;
  remotePath: string;
}

interface ConsoleLine {
  id: string;
  type: 'input' | 'output' | 'error' | 'info';
  text: string;
}

export const ScriptConsoleModal: React.FC<ScriptConsoleModalProps> = ({
  isOpen,
  onClose,
  sessionId,
  localPath,
  remotePath,
}) => {
  const { i18n } = useTranslation();
  const isPt = i18n.language.startsWith('pt');

  const [inputLine, setInputLine] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [isRunning, setIsRunning] = useState(false);
  const [lines, setLines] = useState<ConsoleLine[]>([
    {
      id: 'welcome',
      type: 'info',
      text: 'RustSCP Scripting Console v1.0.0\nType "help" for a list of commands, or "clear" to empty the terminal.',
    },
  ]);

  const outputRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [lines]);

  if (!isOpen) return null;

  const handleExecute = async () => {
    const trimmed = inputLine.trim();
    if (!trimmed) return;

    if (trimmed.toLowerCase() === 'clear') {
      setLines([]);
      setInputLine('');
      return;
    }

    // Add command to history
    setHistory((prev) => [trimmed, ...prev]);
    setHistoryIndex(-1);

    // Append to lines
    setLines((prev) => [
      ...prev,
      { id: Math.random().toString(), type: 'input', text: `rustscp> ${trimmed}` },
    ]);
    setInputLine('');
    setIsRunning(true);

    try {
      const res = await invoke<ScriptCommandOutput>('execute_script_line', {
        sessionId,
        line: trimmed,
        localDir: localPath,
        remoteDir: remotePath,
      });

      setLines((prev) => [
        ...prev,
        {
          id: Math.random().toString(),
          type: res.success ? 'output' : 'error',
          text: res.output || (res.success ? 'OK' : 'Command failed'),
        },
      ]);
    } catch (err: any) {
      setLines((prev) => [
        ...prev,
        { id: Math.random().toString(), type: 'error', text: `Error: ${err.toString()}` },
      ]);
    } finally {
      setIsRunning(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-white dark:bg-dark-800 border border-slate-300 dark:border-dark-600 rounded-xl shadow-2xl w-full max-w-4xl flex flex-col h-[80vh] overflow-hidden text-slate-900 dark:text-slate-100 animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 dark:border-dark-800 flex items-center justify-between bg-slate-100 dark:bg-dark-750">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-purple-500/10 text-purple-600 dark:text-purple-400 rounded-lg border border-purple-500/20">
              <Terminal className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100 tracking-wide">
                {isPt ? 'Console de Comandos e Scripting RustSCP' : 'RustSCP Command & Scripting Console'}
              </h2>
              <p className="text-xs text-slate-600 dark:text-slate-400">
                {isPt
                  ? 'Terminal interativo RustSCP para automação de lotes e execução remota'
                  : 'Interactive RustSCP batch automation and remote terminal'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setLines([])}
              title={isPt ? 'Limpar console' : 'Clear console'}
              className="text-slate-500 hover:text-slate-950 dark:text-slate-400 dark:hover:text-white p-1.5 rounded-lg hover:bg-slate-200 dark:hover:bg-dark-700 transition-colors"
            >
              <Trash2 className="w-4 h-4" />
            </button>
            <button
              onClick={onClose}
              className="text-slate-500 hover:text-slate-950 dark:text-slate-400 dark:hover:text-white p-1.5 rounded-lg hover:bg-slate-200 dark:hover:bg-dark-700 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Console Output Screen */}
        <div
          ref={outputRef}
          className="flex-1 bg-slate-950 p-4 overflow-y-auto font-mono text-xs space-y-1.5 select-text border-b border-slate-800"
        >
          {lines.map((l) => (
            <div
              key={l.id}
              className={`whitespace-pre-wrap leading-relaxed ${
                l.type === 'input'
                  ? 'text-cyan-400 font-bold'
                  : l.type === 'error'
                  ? 'text-rose-400 font-medium'
                  : l.type === 'info'
                  ? 'text-amber-300/90'
                  : 'text-slate-300'
              }`}
            >
              {l.text}
            </div>
          ))}
          {isRunning && (
            <div className="text-emerald-400 animate-pulse flex items-center gap-2 font-semibold">
              <span>●</span> Executing...
            </div>
          )}
        </div>

        {/* Input Bar */}
        <div className="p-3 bg-slate-100 dark:bg-dark-900 border-t border-slate-200 dark:border-dark-800 flex items-center gap-3">
          <span className="font-mono text-xs text-emerald-600 dark:text-emerald-400 font-bold select-none">rustscp&gt;</span>
          <input
            ref={inputRef}
            type="text"
            value={inputLine}
            onChange={(e) => setInputLine(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isRunning}
            placeholder={isPt ? 'Digite um comando (ex: ls, pwd, get file.txt, cd /var)...' : 'Type a command (e.g. ls, pwd, get file.txt, cd /var)...'}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="off"
            className="flex-1 bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-slate-900 dark:text-slate-100 focus:outline-none focus:border-purple-500 shadow-sm"
          />
          <button
            onClick={handleExecute}
            disabled={isRunning || !inputLine.trim()}
            className="flex items-center gap-1.5 px-4 py-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white rounded-lg text-xs font-semibold transition-colors shadow-md"
          >
            <CornerDownLeft className="w-3.5 h-3.5" />
            {isPt ? 'Executar' : 'Run'}
          </button>
        </div>
      </div>
    </div>
  );
};
