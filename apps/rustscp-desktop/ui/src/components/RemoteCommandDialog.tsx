import React, { useState } from 'react';
import { 
  X, 
  Terminal, 
  Play, 
  
  CheckCircle, 
  AlertCircle 
} from 'lucide-react';

interface RemoteCommandDialogProps {
  isOpen: boolean;
  onClose: () => void;
  remoteSessionName: string;
  onExecute: (cmd: string) => Promise<{ exit_code: number; stdout: string; stderr: string }>;
}

export const RemoteCommandDialog: React.FC<RemoteCommandDialogProps> = ({
  isOpen,
  onClose,
  remoteSessionName,
  onExecute,
}) => {
  const [command, setCommand] = useState<string>('uname -a');
  const [stdout, setStdout] = useState<string>('');
  const [stderr, setStderr] = useState<string>('');
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [isRunning, setIsRunning] = useState<boolean>(false);

  if (!isOpen) return null;

  const handleRun = async () => {
    if (!command.trim()) return;
    setIsRunning(true);
    setStdout('Executando no servidor...\n');
    setStderr('');
    setExitCode(null);

    try {
      const res = await onExecute(command);
      setStdout(res.stdout);
      setStderr(res.stderr);
      setExitCode(res.exit_code);
    } catch (err: any) {
      setStderr(err.toString());
      setExitCode(-1);
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-dark-800 border border-slate-300 dark:border-dark-600 rounded-xl max-w-3xl w-full shadow-2xl flex flex-col h-[520px] overflow-hidden">
        {/* Header */}
        <div className="px-5 py-3 border-b border-slate-200 dark:border-dark-700 flex items-center justify-between bg-slate-100 dark:bg-dark-750">
          <div className="flex items-center space-x-2.5">
            <Terminal className="w-5 h-5 text-amber-500 dark:text-amber-400" />
            <div>
              <h3 className="font-bold text-slate-900 dark:text-slate-100 text-xs">Executar Comando Remoto</h3>
              <p className="text-[10px] text-slate-500 dark:text-slate-400">Canal SSH Remoto: {remoteSessionName}</p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white p-1 rounded-md hover:bg-slate-200 dark:hover:bg-dark-700 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Input Bar */}
        <div className="p-4 bg-slate-50 dark:bg-dark-900 border-b border-slate-200 dark:border-dark-700 space-y-2">
          <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
            Comando Shell Linux / Bash:
          </label>
          <div className="flex items-center space-x-2">
            <input
              type="text"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRun();
              }}
              placeholder="Ex: df -h, systemctl restart nginx, ps aux | grep node"
              autoFocus
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoComplete="off"
              className="flex-1 bg-white dark:bg-dark-800 border border-slate-300 dark:border-dark-700 rounded px-3 py-1.5 text-xs font-mono text-emerald-600 dark:text-emerald-400 focus:outline-none focus:border-sky-500"
            />
            <button
              onClick={handleRun}
              disabled={isRunning}
              className="flex items-center space-x-1.5 px-4 py-1.5 rounded bg-sky-600 hover:bg-sky-500 text-white font-bold text-xs shadow-md disabled:opacity-40"
            >
              <Play className={`w-3.5 h-3.5 ${isRunning ? 'animate-pulse' : ''}`} />
              <span>{isRunning ? 'Executando...' : 'Executar'}</span>
            </button>
          </div>
        </div>

        {/* Console Output */}
        <div className="flex-1 bg-black/90 p-4 font-mono text-xs overflow-y-auto space-y-2 select-text">
          {stdout && (
            <pre className="text-slate-200 whitespace-pre-wrap leading-5">{stdout}</pre>
          )}
          {stderr && (
            <pre className="text-red-400 whitespace-pre-wrap leading-5">{stderr}</pre>
          )}
          {!stdout && !stderr && (
            <span className="text-slate-500 dark:text-slate-600 font-sans text-xs">
              Digite um comando acima e pressione Enter para executar diretamente na sessão SSH remota.
            </span>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-2.5 border-t border-slate-200 dark:border-dark-700 bg-slate-100 dark:bg-dark-750 flex items-center justify-between text-xs font-mono">
          <div className="flex items-center space-x-2">
            {exitCode !== null && (
              <span className={`flex items-center space-x-1 ${exitCode === 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                {exitCode === 0 ? <CheckCircle className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
                <span>Código de Saída: {exitCode}</span>
              </span>
            )}
          </div>
          <button onClick={onClose} className="px-3 py-1 rounded text-slate-700 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white hover:bg-slate-200 dark:hover:bg-dark-700 font-sans transition-colors">
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
};
