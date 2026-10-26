import React, { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
  /** Right side of the header, before the close button */
  headerActions?: React.ReactNode;
  footer?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl' | 'full';
  /** Close when clicking the dimmed backdrop (default true) */
  dismissOnBackdrop?: boolean;
  /** Close on Escape (default true) */
  dismissOnEscape?: boolean;
  /** Padding for the body (default true) */
  padded?: boolean;
  className?: string;
  bodyClassName?: string;
  children?: React.ReactNode;
  /** Optional ref of the element to focus on open; otherwise the first input */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
}

const SIZES: Record<NonNullable<ModalProps['size']>, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-2xl',
  '2xl': 'max-w-4xl',
  '3xl': 'max-w-[min(1040px,calc(100vw-2rem))]',
  full: 'max-w-[min(1200px,calc(100vw-2rem))] h-[calc(100vh-2rem)]',
};

/**
 * Shared dialog shell: dim backdrop, centered card, calm header, optional footer.
 * Handles Escape, backdrop click, initial focus and restores focus on close.
 */
export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  subtitle,
  icon,
  headerActions,
  footer,
  size = 'lg',
  dismissOnBackdrop = true,
  dismissOnEscape = true,
  padded = true,
  className = '',
  bodyClassName = '',
  children,
  initialFocusRef,
}) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const timer = setTimeout(() => {
      const panel = panelRef.current;
      const target =
        initialFocusRef?.current ||
        panel?.querySelector<HTMLElement>('[data-autofocus]') ||
        panel?.querySelector<HTMLElement>('input:not([type=hidden]):not([disabled]), textarea, select');
      (target || panelRef.current)?.focus();
    }, 30);

    const onKey = (e: KeyboardEvent) => {
      // Only the top-most dialog reacts
      const dialogs = document.querySelectorAll('[data-ui-modal]');
      if (dialogs[dialogs.length - 1] !== panelRef.current) return;
      if (e.key === 'Escape' && dismissOnEscape) {
        e.stopPropagation();
        onCloseRef.current();
      } else if (e.key === 'Tab' && panelRef.current) {
        // Keep keyboard focus inside the dialog (wrap first <-> last)
        const focusables = Array.from(
          panelRef.current.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
          )
        ).filter((el) => el.offsetParent !== null || el === document.activeElement);
        if (!focusables.length) {
          e.preventDefault();
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement as HTMLElement | null;
        const inside = !!active && panelRef.current.contains(active);
        if (e.shiftKey && (active === first || !inside)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || !inside)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', onKey, true);
      previouslyFocused?.focus?.();
    };
  }, [isOpen, dismissOnEscape, initialFocusRef]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 dark:bg-black/55 animate-in"
      onMouseDown={(e) => {
        if (dismissOnBackdrop && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        data-ui-modal=""
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        className={`w-full ${SIZES[size]} max-h-[calc(100vh-2rem)] flex flex-col overflow-hidden rounded-2xl bg-surface-raised text-ink shadow-modal animate-pop ${className}`}
      >
        {(title || icon || headerActions) && (
          <div className="flex items-center gap-3 px-5 pt-4 pb-3 shrink-0 select-none">
            {icon && <div className="shrink-0 text-ink-muted">{icon}</div>}
            <div className="flex-1 min-w-0">
              {title && (
                <h2 id={titleId} className="text-[15px] font-semibold text-ink leading-tight truncate">
                  {title}
                </h2>
              )}
              {subtitle && <p className="text-[12.5px] text-ink-faint mt-0.5 leading-snug">{subtitle}</p>}
            </div>
            {headerActions}
            <button type="button" onClick={onClose} className="ui-icon-btn ui-icon-btn-sm -mr-1.5" aria-label="Close">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}
        <div className={`flex-1 min-h-0 overflow-y-auto ${padded ? 'px-5 pb-5' : ''} ${bodyClassName}`}>{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-line shrink-0 select-none">{footer}</div>
        )}
      </div>
    </div>
  );
};
