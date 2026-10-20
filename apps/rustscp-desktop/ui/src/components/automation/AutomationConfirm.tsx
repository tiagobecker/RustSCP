import React, { useRef } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle } from 'lucide-react';
import { Modal } from '../ui/Modal.tsx';

interface AutomationConfirmProps {
  isOpen: boolean;
  title: React.ReactNode;
  /** Short explanation above the details */
  message?: React.ReactNode;
  /** Exact command that will run (shown monospaced) */
  command?: string;
  /** Where it runs, e.g. "prod-vps · /var/www" */
  target?: React.ReactNode;
  children?: React.ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  /** 'danger' paints the confirm button red */
  tone?: 'danger' | 'primary';
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirmation sheet for commands and batch changes. Rendered in a portal so it stacks above the
 * dialog that opened it, and Cancel is focused so Enter never triggers the risky action.
 */
export const AutomationConfirm: React.FC<AutomationConfirmProps> = ({
  isOpen,
  title,
  message,
  command,
  target,
  children,
  confirmLabel,
  cancelLabel,
  tone = 'danger',
  onConfirm,
  onCancel,
}) => {
  const cancelRef = useRef<HTMLButtonElement>(null);
  if (!isOpen || typeof document === 'undefined') return null;
  return createPortal(
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      size="lg"
      title={title}
      icon={<AlertTriangle className={`w-5 h-5 ${tone === 'danger' ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400'}`} />}
      initialFocusRef={cancelRef}
      footer={
        <>
          <button ref={cancelRef} type="button" className="ui-btn ui-btn-secondary" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`ui-btn ${tone === 'danger' ? 'ui-btn-danger' : 'ui-btn-primary'}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-[13px]">
        {message && <p className="text-ink-muted leading-relaxed">{message}</p>}
        {target && <p className="text-[12px] text-ink-faint">{target}</p>}
        {command && (
          <pre className="max-h-48 overflow-auto rounded-lg border border-line bg-surface-sunken px-3 py-2 font-mono text-[12px] text-ink whitespace-pre-wrap break-all select-text">
            {command}
          </pre>
        )}
        {children}
      </div>
    </Modal>,
    document.body
  );
};
