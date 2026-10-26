import React, { useEffect, useRef, useState } from 'react';

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

export interface MenuProps {
  /** Renders the trigger; receives open state and toggle handler */
  trigger: (props: { open: boolean; toggle: () => void; ref: React.Ref<HTMLButtonElement> }) => React.ReactNode;
  children: (close: () => void) => React.ReactNode;
  align?: 'left' | 'right';
  width?: string;
}

/** Lightweight dropdown menu: closes on outside click, Escape and item selection. */
export const Menu: React.FC<MenuProps> = ({ trigger, children, align = 'left', width = 'w-64' }) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      } else if (e.key === 'Tab') {
        // The Modal's focus trap steps aside while the menu is top-most, so Tab closes the menu first
        setOpen(false);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const items = Array.from(rootRef.current?.querySelectorAll<HTMLElement>('[role=menuitem], [role=menuitemcheckbox]') || []);
        if (!items.length) return;
        e.preventDefault();
        const idx = items.indexOf(document.activeElement as HTMLElement);
        const next = e.key === 'ArrowDown' ? (idx + 1) % items.length : (idx - 1 + items.length) % items.length;
        items[next].focus();
      }
    };
    const onBlur = () => setOpen(false);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [open]);

  const close = () => setOpen(false);

  return (
    <div ref={rootRef} className="relative">
      {trigger({ open, toggle: () => setOpen((o) => !o), ref: triggerRef })}
      {open && (
        <div
          role="menu"
          // Top-most layer while open: a Modal around it steps aside, so one Escape closes only the menu
          data-ui-modal=""
          className={cx('absolute top-full mt-1.5 z-40 ui-menu animate-pop', width, align === 'right' ? 'right-0' : 'left-0')}
        >
          {children(close)}
        </div>
      )}
    </div>
  );
};

export const MenuItem: React.FC<{
  icon?: React.ReactNode;
  label: React.ReactNode;
  hint?: React.ReactNode;
  shortcut?: string;
  onSelect: () => void;
  close?: () => void;
  disabled?: boolean;
  danger?: boolean;
}> = ({ icon, label, hint, shortcut, onSelect, close, disabled, danger }) => (
  <button
    type="button"
    role="menuitem"
    disabled={disabled}
    onClick={() => {
      close?.();
      onSelect();
    }}
    className={cx('ui-menu-item disabled:opacity-40', danger && 'text-red-600 dark:text-red-400')}
  >
    {icon && <span className="w-4 h-4 shrink-0 text-ink-muted flex items-center justify-center">{icon}</span>}
    <span className="flex-1 min-w-0 truncate">{label}</span>
    {hint}
    {shortcut && <span className="ui-kbd">{shortcut}</span>}
  </button>
);

export const MenuToggleItem: React.FC<{
  icon?: React.ReactNode;
  label: React.ReactNode;
  checked: boolean;
  onToggle: () => void;
}> = ({ icon, label, checked, onToggle }) => (
  <button type="button" role="menuitemcheckbox" aria-checked={checked} onClick={onToggle} className="ui-menu-item">
    {icon && <span className="w-4 h-4 shrink-0 text-ink-muted flex items-center justify-center">{icon}</span>}
    <span className="flex-1 min-w-0 truncate">{label}</span>
    <span
      className={cx(
        'relative inline-flex w-7 h-4 shrink-0 items-center rounded-full p-0.5 transition-colors',
        checked ? 'bg-rust-500' : 'bg-slate-300 dark:bg-dark-600'
      )}
    >
      <span className={cx('w-3 h-3 rounded-full bg-white shadow-sm transition-transform', checked && 'translate-x-3')} />
    </span>
  </button>
);

export const MenuLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => <div className="ui-menu-label">{children}</div>;
export const MenuSeparator: React.FC = () => <div className="ui-menu-sep" role="separator" />;
