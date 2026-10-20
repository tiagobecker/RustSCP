import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, Copy, X } from 'lucide-react';
import { Modal } from './ui/Modal.tsx';
import { Button, Field, IconButton, Segmented, TextInput } from './ui/controls.tsx';
import { notify } from './ui/toast.tsx';
import { useCopyFeedback } from './copyToClipboard.ts';

interface ChecksumModalProps {
  isOpen: boolean;
  onClose: () => void;
  fileName: string;
  filePath: string;
  onCalculate: (algo: string) => Promise<string>;
}

type Algo = 'SHA-256' | 'MD5';

const HEX_LENGTH: Record<Algo, number> = { 'SHA-256': 64, MD5: 32 };

/** Accepts a bare hash, `sha256sum` output ("<hash>  name"), "SHA256:<hash>", spaces or colons. */
function normalizeExpected(input: string): string {
  let s = input.trim();
  if (!s) return '';
  s = s.split(/\s+/)[0];
  s = s.replace(/^(sha-?256|md5)[:=]/i, '');
  return s.replace(/[:\s-]/g, '').toLowerCase();
}

export const ChecksumModal: React.FC<ChecksumModalProps> = ({ isOpen, onClose, fileName, filePath, onCalculate }) => {
  const { i18n } = useTranslation();
  const isPt = (i18n.language || '').startsWith('pt');
  const tr = (pt: string, en: string) => (isPt ? pt : en);

  const [algo, setAlgo] = useState<Algo>('SHA-256');
  const [result, setResult] = useState<{ algo: Algo; hash: string } | null>(null);
  const [isCalculating, setIsCalculating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expected, setExpected] = useState('');
  const { copied, copy } = useCopyFeedback();
  const calcBtnRef = useRef<HTMLButtonElement>(null);
  // Results that arrive after the algorithm changed (or the dialog closed) are dropped
  const requestRef = useRef(0);

  useEffect(() => {
    if (!isOpen) return;
    setResult(null);
    setError(null);
    setExpected('');
    setIsCalculating(false);
    return () => {
      requestRef.current++;
    };
  }, [isOpen, filePath]);

  if (!isOpen || typeof document === 'undefined') return null;

  const changeAlgo = (next: Algo) => {
    if (next === algo) return;
    requestRef.current++;
    setAlgo(next);
    setResult(null);
    setError(null);
    setIsCalculating(false);
  };

  const handleCompute = async () => {
    const req = ++requestRef.current;
    const forAlgo = algo;
    setIsCalculating(true);
    setError(null);
    setResult(null);
    try {
      const hash = await onCalculate(forAlgo);
      if (req !== requestRef.current) return;
      setResult({ algo: forAlgo, hash: String(hash).trim() });
    } catch (err) {
      if (req !== requestRef.current) return;
      setError(String((err as any)?.message ?? err));
    } finally {
      if (req === requestRef.current) setIsCalculating(false);
    }
  };

  const handleCopy = async () => {
    if (!result) return;
    const ok = await copy(result.hash);
    if (!ok) notify.error(tr('Não foi possível copiar', 'Could not copy'), tr('O acesso à área de transferência foi negado.', 'Clipboard access was denied.'));
  };

  const expectedNorm = normalizeExpected(expected);
  const comparison = result && expectedNorm ? (expectedNorm === result.hash.toLowerCase() ? 'match' : 'mismatch') : null;
  const otherAlgo: Algo = algo === 'SHA-256' ? 'MD5' : 'SHA-256';
  const looksLikeOtherAlgo =
    !!expectedNorm && /^[0-9a-f]+$/.test(expectedNorm) && expectedNorm.length === HEX_LENGTH[otherAlgo] && expectedNorm.length !== HEX_LENGTH[algo];

  return createPortal(
    <Modal
      isOpen
      onClose={onClose}
      size="lg"
      title={tr('Checksum', 'Checksum')}
      subtitle={fileName}
      initialFocusRef={calcBtnRef}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {tr('Fechar', 'Close')}
          </Button>
          <Button ref={calcBtnRef} variant="primary" onClick={handleCompute} loading={isCalculating}>
            {result ? tr('Calcular novamente', 'Calculate again') : tr('Calcular', 'Calculate')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="font-mono text-[11.5px] text-ink-faint break-all select-text" title={filePath}>
          {filePath}
        </div>

        <div className="flex items-center gap-3">
          <span className="text-[12.5px] text-ink-muted">{tr('Algoritmo', 'Algorithm')}</span>
          <Segmented<Algo>
            value={algo}
            onChange={changeAlgo}
            ariaLabel={tr('Algoritmo', 'Algorithm')}
            options={[
              { value: 'SHA-256', label: 'SHA-256', title: tr('Recomendado', 'Recommended') },
              { value: 'MD5', label: 'MD5', title: tr('Legado: use só para comparar com valores antigos', 'Legacy: use only to compare with old values') },
            ]}
          />
        </div>

        <div>
          <div className="ui-label">{result ? result.algo : tr('Resultado', 'Result')}</div>
          <div className="flex items-start gap-2 rounded-lg border border-line bg-surface-sunken px-3 py-2 min-h-[40px]">
            <span
              className={`flex-1 min-w-0 font-mono text-[12px] leading-5 break-all ${result ? 'text-ink select-all' : 'text-ink-faint'}`}
              aria-live="polite"
            >
              {result
                ? result.hash
                : isCalculating
                  ? tr('Calculando… arquivos grandes podem levar um tempo.', 'Calculating… large files can take a while.')
                  : tr('Escolha o algoritmo e clique em Calcular.', 'Choose an algorithm and click Calculate.')}
            </span>
            {result && (
              <IconButton size="sm" label={copied ? tr('Copiado', 'Copied') : tr('Copiar hash', 'Copy hash')} onClick={handleCopy} className="-my-1 -mr-1.5">
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              </IconButton>
            )}
          </div>
        </div>

        <Field
          label={tr('Comparar com', 'Compare with')}
          hint={
            looksLikeOtherAlgo
              ? tr(`Isto parece um hash ${otherAlgo}. Troque o algoritmo para comparar.`, `This looks like a ${otherAlgo} hash. Switch the algorithm to compare.`)
              : tr('Cole o hash esperado (por exemplo, do site de download).', 'Paste the expected hash (for example, from the download page).')
          }
        >
          {(id) => (
            <div className="relative">
              <TextInput
                id={id}
                mono
                value={expected}
                onChange={(e) => setExpected(e.target.value)}
                placeholder={algo === 'MD5' ? 'd41d8cd98f00b204e9800998ecf8427e' : 'e3b0c44298fc1c149afbf4c8996fb924…'}
                className={comparison ? 'pr-28' : ''}
              />
              {comparison && (
                <span
                  className={`absolute right-2.5 top-1/2 -translate-y-1/2 inline-flex items-center gap-1 text-[12px] font-medium ${
                    comparison === 'match' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
                  }`}
                  role="status"
                >
                  {comparison === 'match' ? <Check className="w-3.5 h-3.5" /> : <X className="w-3.5 h-3.5" />}
                  {comparison === 'match' ? tr('Confere', 'Matches') : tr('Diferente', 'No match')}
                </span>
              )}
            </div>
          )}
        </Field>

        {error && (
          <div role="alert" className="flex items-start gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-[12.5px] text-red-700 dark:text-red-300">
            <AlertTriangle className="w-4 h-4 mt-px shrink-0" aria-hidden="true" />
            <span className="break-words min-w-0">
              {tr('Não foi possível calcular: ', 'Could not calculate: ')}
              {error}
            </span>
          </div>
        )}
      </div>
    </Modal>,
    document.body
  );
};
