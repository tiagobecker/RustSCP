import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../ui/Modal.tsx';
import { Button } from '../ui/controls.tsx';

/**
 * What the dialog asks about (spec §8):
 * - `items`: 2 or more items and no folder with contents: "Delete 5 connections?" + [Delete 5].
 * - `folder`: a folder with contents (or a selection holding one): [Delete everything] or the
 *   default [Keep connections], which lifts the contents one level.
 * - `merge`: a rename or move clashes with a folder of the same name: [Merge].
 * - `copy`: an ⌥/Alt drop that would copy more than 50 connections: [Copy N].
 * - `connect`: Connect N / Connect all above 5 connections: [Connect N].
 */
export type DeleteRequest =
  | { kind: 'items'; count: number; sitesOnly: boolean }
  | {
      kind: 'folder';
      /** The folder's name when it is the only item */
      name: string | null;
      /** Items selected (1 for one folder) */
      count: number;
      /** Connections inside, all levels */
      sites: number;
      /** Subfolders inside, all levels */
      subfolders: number;
      /** Where "Keep connections" moves the contents (null: the top level) */
      parent: string | null;
      /** The folders sit in different places: their contents each go one level up */
      mixedParents?: boolean;
    }
  | { kind: 'merge'; name: string; parent: string | null; sites: number }
  | { kind: 'copy'; connections: number }
  | { kind: 'connect'; count: number };

export type DeleteChoice = 'delete' | 'keep' | 'merge' | 'copy' | 'connect';

interface Props {
  request: DeleteRequest;
  onChoose: (choice: DeleteChoice) => void;
  onCancel: () => void;
}

/** Confirmation for deletes that need one, and the merge prompt. Portaled, like ConfirmDialogModal. */
export const DeleteItemsDialog: React.FC<Props> = ({ request, onChoose, onCancel }) => {
  const { t, i18n } = useTranslation();
  const nf = new Intl.NumberFormat(i18n.language);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);

  const choose = (choice: DeleteChoice) => {
    // Key repeat or a double click must not run it twice
    if (busy) return;
    setBusy(true);
    onChoose(choice);
  };

  let title: string;
  let body: React.ReactNode;
  let footer: React.ReactNode;
  const cancel = (
    <Button variant="secondary" onClick={onCancel}>
      {t('loginDialog.cancel', 'Cancel')}
    </Button>
  );

  if (request.kind === 'items') {
    const formatted = nf.format(request.count);
    title = request.sitesOnly
      ? t('siteTree.deleteConfirmTitle', { count: request.count, formatted, defaultValue_other: 'Delete {{formatted}} connections?', defaultValue: 'Delete {{formatted}} connections?' })
      : t('siteTree.deleteItemsTitle', { count: request.count, formatted, defaultValue_other: 'Delete {{formatted}} items?', defaultValue: 'Delete {{formatted}} items?' });
    body = <p className="text-[13px] text-ink-muted leading-relaxed">{t('siteTree.canUndo', 'You can undo right after.')}</p>;
    footer = (
      <>
        {cancel}
        <Button ref={primaryRef} variant="danger" onClick={() => choose('delete')}>
          {t('siteTree.deleteCount', { formatted, defaultValue: 'Delete {{formatted}}' })}
        </Button>
      </>
    );
  } else if (request.kind === 'folder') {
    title =
      request.count === 1 && request.name
        ? t('siteTree.deleteFolderTitle', { name: request.name, defaultValue: 'Delete “{{name}}”?' })
        : t('siteTree.deleteItemsTitle', { count: request.count, formatted: nf.format(request.count), defaultValue: 'Delete {{formatted}} items?' });
    const holdsKey = request.count === 1 ? 'siteTree.folderHolds' : 'siteTree.itemsHold';
    let holds: string;
    if (request.sites > 0) {
      holds = t(holdsKey, {
        count: request.sites,
        formatted: nf.format(request.sites),
        defaultValue_one: request.count === 1 ? 'It holds 1 connection' : 'They hold 1 connection',
        defaultValue_other: request.count === 1 ? 'It holds {{formatted}} connections' : 'They hold {{formatted}} connections',
      });
      if (request.subfolders > 0) {
        holds += ` ${t('siteTree.inSubfolders', {
          count: request.subfolders,
          formatted: nf.format(request.subfolders),
          defaultValue_one: 'in 1 subfolder',
          defaultValue_other: 'in {{formatted}} subfolders',
        })}`;
      }
    } else {
      holds = t('siteTree.folderHoldsFolders', {
        count: request.subfolders,
        formatted: nf.format(request.subfolders),
        defaultValue_one: 'It holds 1 subfolder',
        defaultValue_other: 'It holds {{formatted}} subfolders',
      });
    }
    body = <p className="text-[13px] text-ink leading-relaxed">{`${holds}.`}</p>;
    const hint = request.mixedParents
      ? t('siteTree.keepHintUp', 'Keep connections moves them one level up.')
      : request.parent
        ? t('siteTree.keepHint', { parent: request.parent, defaultValue: 'Keep connections moves them to “{{parent}}”.' })
        : t('siteTree.keepHintTop', 'Keep connections moves them to the top level.');
    footer = (
      <div className="w-full flex flex-col items-end gap-2">
        <div className="flex items-center gap-2">
          {cancel}
          <Button variant="danger" onClick={() => choose('delete')}>
            {t('siteTree.deleteEverything', 'Delete everything')}
          </Button>
          <Button ref={primaryRef} variant="primary" onClick={() => choose('keep')}>
            {t('siteTree.keepConnections', 'Keep connections')}
          </Button>
        </div>
        <p className="text-[11.5px] text-ink-faint text-right">{hint}</p>
      </div>
    );
  } else if (request.kind === 'copy') {
    const formatted = nf.format(request.connections);
    title = t('siteTree.copyConfirmTitle', { count: request.connections, formatted, defaultValue_one: 'Copy 1 connection?', defaultValue_other: 'Copy {{formatted}} connections?' });
    body = (
      <p className="text-[13px] text-ink-muted leading-relaxed">
        {t('siteTree.copyConfirmBody', 'Each copy keeps its saved sign-in. You can undo right after.')}
      </p>
    );
    footer = (
      <>
        {cancel}
        <Button ref={primaryRef} variant="primary" onClick={() => choose('copy')}>
          {t('siteTree.copyCount', { formatted, defaultValue: 'Copy {{formatted}}' })}
        </Button>
      </>
    );
  } else if (request.kind === 'connect') {
    const formatted = nf.format(request.count);
    title = t('siteTree.connectManyTitle', { count: request.count, formatted, defaultValue_one: 'Open 1 connection?', defaultValue_other: 'Open {{formatted}} connections?' });
    body = <p className="text-[13px] text-ink-muted leading-relaxed">{t('siteTree.connectManyBody', 'Each opens in a new tab.')}</p>;
    footer = (
      <>
        {cancel}
        <Button ref={primaryRef} variant="primary" onClick={() => choose('connect')}>
          {t('siteTree.connectN', { count: request.count, formatted, defaultValue_one: 'Connect 1', defaultValue_other: 'Connect {{formatted}}' })}
        </Button>
      </>
    );
  } else {
    title = t('siteTree.mergeTitle', 'Merge folders?');
    body = (
      <p className="text-[13px] text-ink leading-relaxed">
        {t('siteTree.mergeBody', {
          name: request.name,
          parent: request.parent ?? t('siteTree.topLevel', 'Top level'),
          formatted: nf.format(request.sites),
          defaultValue: '“{{name}}” already exists in “{{parent}}”. Move its {{formatted}} connections into it?',
        })}
      </p>
    );
    footer = (
      <>
        {cancel}
        <Button ref={primaryRef} variant="primary" onClick={() => choose('merge')}>
          {t('siteTree.merge', 'Merge')}
        </Button>
      </>
    );
  }

  if (typeof document === 'undefined') return null;
  return createPortal(
    <Modal
      isOpen
      onClose={onCancel}
      size="md"
      title={title}
      icon={request.kind === 'merge' || request.kind === 'copy' || request.kind === 'connect' ? undefined : <AlertTriangle className="w-[18px] h-[18px] text-red-600 dark:text-red-400" aria-hidden="true" />}
      initialFocusRef={primaryRef}
      footer={footer}
    >
      {body}
    </Modal>,
    document.body
  );
};
