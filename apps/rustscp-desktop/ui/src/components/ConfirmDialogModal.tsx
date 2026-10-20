import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Modal } from './ui/Modal.tsx';
import { Button } from './ui/controls.tsx';
import { notify } from './ui/toast.tsx';

export interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  subMessage?: string;
  items?: string[];
  confirmText?: string;
  cancelText?: string;
  variant?: 'danger' | 'warning' | 'info';
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}

/** Rows rendered in the item list; selecting thousands of files must not mount thousands of nodes. */
const MAX_LISTED_ITEMS = 100;

/**
 * Apple-style confirmation sheet.
 *
 * Keyboard contract:
 * - Return activates only the focused button (native button behaviour); there is no global Enter handler.
 * - For `danger` the safe button (Cancel) is focused when the dialog opens, so Return never runs the
 *   destructive action unless the user moved focus to it on purpose.
 * - Escape cancels (handled by <Modal>, top-most dialog only).
 * - Focus is set once per dialog, never re-taken on parent re-renders.
 */
export const ConfirmDialogModal: React.FC<ConfirmDialogProps> = ({
  isOpen,
  title,
  message,
  subMessage,
  items = [],
  confirmText,
  cancelText,
  variant = 'danger',
  onConfirm,
  onClose,
}) => {
  const { i18n } = useTranslation();
  const isPt = (i18n.language || '').startsWith('pt');
  const tr = (pt: string, en: string) => (isPt ? pt : en);

  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const mountedRef = useRef(true);

  const isDanger = variant === 'danger';
  const isWarning = variant === 'warning';
  const safeDefaultRef = isDanger ? cancelRef : confirmRef;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Focus the default button once per dialog. Keyed on the dialog's content (strings), so parent
  // re-renders (transfer polling, etc.) never move focus back after the user changed it.
  useEffect(() => {
    if (!isOpen) return;
    busyRef.current = false;
    setBusy(false);
    const timer = setTimeout(() => safeDefaultRef.current?.focus(), 40);
    return () => clearTimeout(timer);
  }, [isOpen, title, message, variant]);

  const listed = useMemo(() => items.slice(0, MAX_LISTED_ITEMS), [items]);
  const hiddenCount = Math.max(0, items.length - listed.length);

  const handleConfirm = async () => {
    // Key repeat or a double click must not run the action twice
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await onConfirm();
    } catch (err) {
      notify.error(tr('Não foi possível concluir a ação', 'The action could not be completed'), err);
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  if (!isOpen || typeof document === 'undefined') return null;

  const icon =
    isDanger || isWarning ? (
      <AlertTriangle
        className={`w-[18px] h-[18px] ${isDanger ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400'}`}
        aria-hidden="true"
      />
    ) : undefined;

  return createPortal(
    <Modal
      isOpen
      onClose={onClose}
      size="md"
      title={title}
      icon={icon}
      initialFocusRef={safeDefaultRef}
      footer={
        <>
          <Button ref={cancelRef} variant="secondary" onClick={onClose}>
            {cancelText || tr('Cancelar', 'Cancel')}
          </Button>
          <Button ref={confirmRef} variant={isDanger ? 'danger' : 'primary'} onClick={handleConfirm} loading={busy}>
            {confirmText || tr('Confirmar', 'Confirm')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-[13px] text-ink leading-relaxed whitespace-pre-line break-words">{message}</p>

        {subMessage && (
          <p
            className={`text-[12.5px] leading-relaxed whitespace-pre-line break-words ${
              isDanger ? 'text-red-600 dark:text-red-400' : isWarning ? 'text-amber-700 dark:text-amber-400' : 'text-ink-muted'
            }`}
          >
            {subMessage}
          </p>
        )}

        {items.length > 0 && (
          <div>
            <div className="text-[12px] font-medium text-ink-faint mb-1.5">
              {items.length === 1 ? tr('1 item selecionado', '1 selected item') : tr(`${items.length} itens selecionados`, `${items.length} selected items`)}
            </div>
            <ul className="max-h-40 overflow-y-auto rounded-lg border border-line bg-surface-sunken px-2.5 py-1.5 space-y-0.5">
              {listed.map((item, idx) => (
                <li key={`${idx}:${item}`} className="font-mono text-[11.5px] leading-5 text-ink-muted truncate" title={item}>
                  {item}
                </li>
              ))}
              {hiddenCount > 0 && (
                <li className="text-[11.5px] leading-5 text-ink-faint">{tr(`…e mais ${hiddenCount}`, `…and ${hiddenCount} more`)}</li>
              )}
            </ul>
          </div>
        )}
      </div>
    </Modal>,
    document.body
  );
};
