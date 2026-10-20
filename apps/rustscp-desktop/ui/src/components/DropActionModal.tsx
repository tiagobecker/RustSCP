import React from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Copy, FolderInput } from 'lucide-react';
import { Modal } from './ui/Modal.tsx';
import { Button } from './ui/controls.tsx';
import { basename } from '../utils/paths.ts';
import { safeDisplayName } from './fileListUtils.ts';

export interface DropActionModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called with the user's choice; the dialog closes itself first. */
  onChoose: (action: 'copy' | 'move') => void;
  /** Paths being dropped (shown by name). */
  paths: string[];
  /** Where they come from, e.g. "This computer" or a server's name. */
  sourceLabel?: string;
  /** Where they go: the destination pane's title. */
  destLabel: string;
  destDir: string;
  /** Source and destination are the same connection (a move is then a rename on that side). */
  sameSession: boolean;
}

const PREVIEW_MAX = 5;

/**
 * "Copy here / Move here / Cancel" chooser for a right-button drag or a drop from Finder/Explorer.
 * Copy is the default (Return); Move says what happens to the originals.
 */
export const DropActionModal: React.FC<DropActionModalProps> = ({
  isOpen,
  onClose,
  onChoose,
  paths,
  sourceLabel,
  destLabel,
  destDir,
  sameSession,
}) => {
  const { i18n } = useTranslation();
  const isPt = (i18n.language || '').startsWith('pt');
  const tr = (pt: string, en: string) => (isPt ? pt : en);

  if (!isOpen || typeof document === 'undefined') return null;

  const count = paths.length;
  const firstName = safeDisplayName(basename(paths[0] || ''));
  const title =
    count === 1
      ? tr(`Copiar ou mover “${firstName}”?`, `Copy or move “${firstName}”?`)
      : tr(`Copiar ou mover ${count} itens?`, `Copy or move ${count} items?`);
  const moveHint = sameSession
    ? tr('Mover tira os itens da pasta onde estão agora.', 'Move takes the items out of the folder they are in now.')
    : tr('Mover apaga os originais depois que forem copiados.', 'Move deletes the originals once they are copied.');

  const choose = (action: 'copy' | 'move') => {
    onClose();
    onChoose(action);
  };

  return createPortal(
    <Modal
      isOpen
      size="sm"
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tr('Cancelar', 'Cancel')}
          </Button>
          <Button variant="secondary" icon={<FolderInput className="w-3.5 h-3.5" />} onClick={() => choose('move')}>
            {tr('Mover para cá', 'Move here')}
          </Button>
          <Button variant="primary" data-autofocus icon={<Copy className="w-3.5 h-3.5" />} onClick={() => choose('copy')}>
            {tr('Copiar para cá', 'Copy here')}
          </Button>
        </>
      }
    >
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px]">
        {sourceLabel && (
          <>
            <dt className="text-ink-faint">{tr('De', 'From')}</dt>
            <dd className="min-w-0 truncate text-ink">
              <bdi>{sourceLabel}</bdi>
            </dd>
          </>
        )}
        <dt className="text-ink-faint">{tr('Para', 'To')}</dt>
        <dd className="min-w-0">
          <div className="truncate text-ink">
            <bdi>{destLabel}</bdi>
          </div>
          <div className="font-mono text-[12px] text-ink-muted break-all">
            <bdi>{safeDisplayName(destDir)}</bdi>
          </div>
        </dd>
      </dl>

      {count > 1 && (
        <ul className="mt-3 max-h-32 overflow-y-auto rounded-lg bg-surface-sunken px-3 py-2 space-y-0.5">
          {paths.slice(0, PREVIEW_MAX).map((p) => (
            <li key={p} className="text-[12px] font-mono text-ink truncate">
              <bdi>{safeDisplayName(basename(p))}</bdi>
            </li>
          ))}
          {count > PREVIEW_MAX && (
            <li className="text-[12px] text-ink-faint">{tr(`…e mais ${count - PREVIEW_MAX}`, `…and ${count - PREVIEW_MAX} more`)}</li>
          )}
        </ul>
      )}

      <p className="mt-3 text-[12px] text-ink-faint leading-relaxed">{moveHint}</p>
    </Modal>,
    document.body
  );
};
