import React, { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Archive, ArrowDownToLine, FileText, AlertTriangle } from 'lucide-react';
import { Modal } from './ui/Modal.tsx';
import { Button, Disclosure, Field, Segmented, Select, TextInput, Toggle } from './ui/controls.tsx';

interface CompressionModalProps {
  isOpen: boolean;
  onClose: () => void;
  mode: 'compress' | 'extract';
  currentDir: string;
  targetItems?: string[]; // for compress
  archivePath?: string; // for extract
  isRemote: boolean;
  onCompress: (items: string[], format: string, outputName: string) => Promise<void>;
  onExtract: (archivePath: string, destSubfolder?: string) => Promise<void>;
}

type ArchiveFormat = 'zip' | 'tar.gz' | 'tar.bz2' | 'tar.xz' | 'tar';

const FORMATS: { id: ArchiveFormat; ext: string; en: string; pt: string }[] = [
  { id: 'zip', ext: '.zip', en: 'Opens anywhere (Windows, macOS, Linux)', pt: 'Abre em qualquer sistema (Windows, macOS, Linux)' },
  { id: 'tar.gz', ext: '.tar.gz', en: 'Standard on Linux servers', pt: 'Padrão em servidores Linux' },
  { id: 'tar.bz2', ext: '.tar.bz2', en: 'Smaller, slower (bzip2)', pt: 'Menor, mais lento (bzip2)' },
  { id: 'tar.xz', ext: '.tar.xz', en: 'Smallest, slowest (xz)', pt: 'O menor, mais lento (xz)' },
  { id: 'tar', ext: '.tar', en: 'No compression', pt: 'Sem compressão' },
];

const ARCHIVE_EXT_RE = /\.(tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz|tar|zip)$/i;

const FORMAT_BY_EXT: Record<string, ArchiveFormat> = {
  zip: 'zip',
  'tar.gz': 'tar.gz',
  tgz: 'tar.gz',
  'tar.bz2': 'tar.bz2',
  tbz2: 'tar.bz2',
  'tar.xz': 'tar.xz',
  txz: 'tar.xz',
  tar: 'tar',
};

const baseName = (p: string) => p.split('/').pop()?.split('\\').pop() || p;

function extOf(format: ArchiveFormat): string {
  return FORMATS.find((f) => f.id === format)?.ext ?? '.tar.gz';
}

/** Swaps (or adds) the archive extension, keeping whatever name the user typed. */
function withExtension(name: string, format: ArchiveFormat): string {
  const stem = name.trim().replace(ARCHIVE_EXT_RE, '');
  return `${stem || 'archive'}${extOf(format)}`;
}

export const CompressionModal: React.FC<CompressionModalProps> = ({
  isOpen,
  onClose,
  mode,
  currentDir,
  targetItems = [],
  archivePath = '',
  isRemote,
  onCompress,
  onExtract,
}) => {
  const { i18n } = useTranslation();
  const isPt = (i18n.language || 'en').toLowerCase().startsWith('pt');
  const tr = (pt: string, en: string) => (isPt ? pt : en);
  const formId = useId();

  // Compress state
  const [format, setFormat] = useState<ArchiveFormat>('tar.gz');
  const [outputName, setOutputName] = useState<string>('');

  // Extract state
  const [destSubfolder, setDestSubfolder] = useState<string>('');
  const [extractToFolder, setExtractToFolder] = useState<boolean>(true);

  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string>('');

  const itemsKey = targetItems.join('\n');

  // Suggest names when the dialog opens for new items (not when the format changes)
  useEffect(() => {
    if (!isOpen) return;
    if (mode === 'compress') {
      const first = targetItems[0] ? baseName(targetItems[0]) : 'archive';
      const stem = targetItems.length > 1 ? baseName(currentDir.replace(/[\\/]+$/, '')) || 'archive' : first.includes('.') && !first.startsWith('.') ? first.slice(0, first.lastIndexOf('.')) : first;
      setOutputName(withExtension(stem, format));
    } else if (archivePath) {
      setDestSubfolder(baseName(archivePath).replace(ARCHIVE_EXT_RE, '') || 'extracted');
      setExtractToFolder(true);
    }
    setErrorMessage('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, mode, itemsKey, archivePath]);

  const changeFormat = (next: ArchiveFormat) => {
    setFormat(next);
    setOutputName((name) => withExtension(name, next));
  };

  /** A typed extension picks the format; a name without one gets the current format's. */
  const resolveName = (raw: string): { name: string; format: ArchiveFormat } => {
    const name = raw.trim();
    const m = ARCHIVE_EXT_RE.exec(name);
    const detected = m ? FORMAT_BY_EXT[m[1].toLowerCase()] : undefined;
    return detected ? { name, format: detected } : { name: withExtension(name, format), format };
  };

  const normalizeName = () => {
    if (!outputName.trim()) return;
    const r = resolveName(outputName);
    if (r.format !== format) setFormat(r.format);
    setOutputName(r.name);
  };

  const trimmedName = outputName.trim();
  const trimmedFolder = destSubfolder.trim();
  const nameError =
    mode === 'compress' && /[\\/]/.test(trimmedName)
      ? tr('O nome não pode conter / ou \\.', 'The name can’t contain / or \\.')
      : mode === 'extract' && extractToFolder && (/[\\/]/.test(trimmedFolder) || trimmedFolder === '.' || trimmedFolder === '..')
      ? tr('Use apenas um nome de pasta, sem / ou \\.', 'Use a single folder name, without / or \\.')
      : '';
  const canSubmit =
    !isProcessing &&
    !nameError &&
    (mode === 'compress' ? targetItems.length > 0 && trimmedName.length > 0 : !!archivePath && (!extractToFolder || trimmedFolder.length > 0));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setIsProcessing(true);
    setErrorMessage('');
    try {
      if (mode === 'compress') {
        const r = resolveName(trimmedName);
        await onCompress(targetItems.map(baseName), r.format, r.name);
      } else {
        await onExtract(archivePath, extractToFolder ? trimmedFolder : undefined);
      }
      onClose();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setIsProcessing(false);
    }
  };

  const where = `${isRemote ? tr('Servidor', 'Server') : tr('Este computador', 'This computer')} · ${currentDir}`;
  const isAdvancedFormat = format !== 'zip' && format !== 'tar.gz';

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => !isProcessing && onClose()}
      size="md"
      icon={mode === 'compress' ? <Archive className="w-4 h-4" /> : <ArrowDownToLine className="w-4 h-4" />}
      title={
        mode === 'compress'
          ? targetItems.length === 1
            ? tr('Compactar 1 item', 'Compress 1 item')
            : tr(`Compactar ${targetItems.length} itens`, `Compress ${targetItems.length} items`)
          : tr('Extrair arquivo compactado', 'Extract archive')
      }
      subtitle={
        <span className="block font-mono text-[11.5px] truncate" title={where}>
          {where}
        </span>
      }
      dismissOnBackdrop={!isProcessing}
      dismissOnEscape={!isProcessing}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={isProcessing}>
            {tr('Cancelar', 'Cancel')}
          </Button>
          <Button type="submit" form={formId} variant="primary" loading={isProcessing} disabled={!canSubmit}>
            {isProcessing
              ? mode === 'compress'
                ? tr('Compactando…', 'Compressing…')
                : tr('Extraindo…', 'Extracting…')
              : mode === 'compress'
              ? tr('Compactar', 'Compress')
              : tr('Extrair', 'Extract')}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={handleSubmit} className="space-y-4">
        {mode === 'compress' ? (
          <>
            <div className="ui-card px-3 py-2 max-h-28 overflow-y-auto space-y-1">
              {targetItems.map((item) => (
                <div key={item} className="flex items-center gap-2 text-[12px] text-ink min-w-0" title={item}>
                  <FileText className="w-3.5 h-3.5 text-ink-faint shrink-0" />
                  <span className="font-mono truncate">{baseName(item)}</span>
                </div>
              ))}
            </div>

            <Field label={tr('Nome do arquivo', 'Archive name')} error={nameError || undefined}>
              {(id) => (
                <TextInput id={id} mono value={outputName} onChange={(e) => setOutputName(e.target.value)} onBlur={normalizeName} />
              )}
            </Field>

            <div>
              <span className="ui-label">{tr('Formato', 'Format')}</span>
              <Segmented<ArchiveFormat>
                ariaLabel={tr('Formato', 'Format')}
                value={isAdvancedFormat ? ('' as ArchiveFormat) : format}
                onChange={changeFormat}
                options={[
                  { value: 'zip', label: 'Zip', title: tr(FORMATS[0].pt, FORMATS[0].en) },
                  { value: 'tar.gz', label: 'Tar.gz', title: tr(FORMATS[1].pt, FORMATS[1].en) },
                ]}
              />
              <span className="ui-hint">
                {(() => {
                  const f = FORMATS.find((x) => x.id === format);
                  return f ? `${f.ext} · ${tr(f.pt, f.en)}` : '';
                })()}
              </span>
            </div>

            <Disclosure label={tr('Avançado', 'Advanced')} defaultOpen={isAdvancedFormat}>
              <Field label={tr('Todos os formatos', 'All formats')}>
                {(id) => (
                  <Select id={id} value={format} onChange={(e) => changeFormat(e.target.value as ArchiveFormat)}>
                    {FORMATS.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.ext} — {tr(f.pt, f.en)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </Disclosure>
          </>
        ) : (
          <>
            <div className="ui-card px-3 py-2 flex items-center gap-2 min-w-0">
              <Archive className="w-3.5 h-3.5 text-ink-faint shrink-0" />
              <span className="font-mono text-[12px] text-ink truncate" title={archivePath}>
                {baseName(archivePath)}
              </span>
            </div>

            <div className="flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-[13px] text-ink">{tr('Extrair para uma pasta nova', 'Extract into a new folder')}</div>
                <div className="text-[11.5px] text-ink-faint">{tr('Mantém a pasta atual organizada.', 'Keeps the current folder tidy.')}</div>
              </div>
              <Toggle checked={extractToFolder} onChange={setExtractToFolder} label={tr('Extrair para uma pasta nova', 'Extract into a new folder')} />
            </div>

            {extractToFolder ? (
              <Field
                label={tr('Nome da pasta', 'Folder name')}
                error={nameError || undefined}
                hint={tr('Se a pasta já existir, arquivos com o mesmo nome dentro dela são substituídos.', 'If the folder already exists, files with the same name inside it are replaced.')}
              >
                {(id) => <TextInput id={id} mono value={destSubfolder} onChange={(e) => setDestSubfolder(e.target.value)} />}
              </Field>
            ) : (
              <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-[12.5px] text-ink" role="note">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
                <span>
                  {tr(
                    'Os arquivos são extraídos direto na pasta atual. Arquivos com o mesmo nome são substituídos sem aviso.',
                    'Files are extracted straight into the current folder. Files with the same name are replaced without warning.'
                  )}
                </span>
              </div>
            )}
          </>
        )}

        {errorMessage && (
          <div className="flex items-start gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-[12.5px] text-red-700 dark:text-red-300" role="alert">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <span className="min-w-0 break-words">{errorMessage}</span>
          </div>
        )}
      </form>
    </Modal>
  );
};
