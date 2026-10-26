import React, { forwardRef, useId, useState } from 'react';
import { ChevronRight, Loader2 } from 'lucide-react';
import { plainTextInputProps } from '../../utils/inputHardening.ts';

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

/* -------------------------------------------------------------------------- */
/* Buttons                                                                     */
/* -------------------------------------------------------------------------- */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

// Literal class names so Tailwind's content scanner keeps these @layer components classes.
const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'ui-btn-primary',
  secondary: 'ui-btn-secondary',
  ghost: 'ui-btn-ghost',
  danger: 'ui-btn-danger',
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  loading?: boolean;
  icon?: React.ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'secondary', size = 'md', loading, icon, className, children, disabled, type = 'button', ...rest }, ref) => (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cx('ui-btn', size === 'sm' && 'ui-btn-sm', VARIANT_CLASS[variant], className)}
      {...rest}
    >
      {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : icon}
      {children}
    </button>
  )
);
Button.displayName = 'Button';

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  size?: 'sm' | 'md';
  active?: boolean;
}

/** Icon-only ghost button; `label` becomes the tooltip and accessible name. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ label, size = 'md', active, className, children, type = 'button', ...rest }, ref) => (
    <button
      ref={ref}
      type={type}
      title={label}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      className={cx('ui-icon-btn', size === 'sm' && 'ui-icon-btn-sm', active && 'bg-dark-650/80 text-ink', className)}
      {...rest}
    >
      {children}
    </button>
  )
);
IconButton.displayName = 'IconButton';

/* -------------------------------------------------------------------------- */
/* Inputs                                                                      */
/* -------------------------------------------------------------------------- */

export interface TextInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  mono?: boolean;
}

/** Text input that never autocapitalizes, autocorrects or spell-checks. */
export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(({ mono, className, type = 'text', ...rest }, ref) => (
  <input
    ref={ref}
    type={type}
    {...plainTextInputProps}
    autoComplete={type === 'password' ? 'current-password' : 'off'}
    className={cx('ui-input', mono && 'font-mono text-[12.5px]', className)}
    {...rest}
  />
));
TextInput.displayName = 'TextInput';

export const TextArea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }>(
  ({ mono, className, ...rest }, ref) => (
    <textarea ref={ref} {...plainTextInputProps} className={cx('ui-input', mono && 'font-mono text-[12.5px]', className)} {...rest} />
  )
);
TextArea.displayName = 'TextArea';

export const Select = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(({ className, children, ...rest }, ref) => (
  <select ref={ref} className={cx('ui-input', className)} {...rest}>
    {children}
  </select>
));
Select.displayName = 'Select';

export interface FieldProps {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  className?: string;
  /**
   * Gets the generated id (for htmlFor wiring) and, while a hint or an error shows, the id of that
   * text, for the control's `aria-describedby`.
   */
  children: (id: string, describedBy?: string) => React.ReactNode;
}

/** Label + control + hint. Children receive the generated id for htmlFor wiring. */
export const Field: React.FC<FieldProps> = ({ label, hint, error, className, children }) => {
  const id = useId();
  const noteId = `${id}-note`;
  const note = error || hint;
  return (
    <div className={className}>
      {label && (
        <label htmlFor={id} className="ui-label">
          {label}
        </label>
      )}
      {children(id, note ? noteId : undefined)}
      {error ? (
        <span id={noteId} className="ui-hint text-red-600 dark:text-red-400">
          {error}
        </span>
      ) : hint ? (
        <span id={noteId} className="ui-hint">
          {hint}
        </span>
      ) : null}
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* Toggle switch                                                               */
/* -------------------------------------------------------------------------- */

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
}

export const Toggle: React.FC<ToggleProps> = ({ checked, onChange, label, disabled, size = 'md' }) => {
  const dims = size === 'sm' ? { track: 'w-7 h-4', knob: 'w-3 h-3', on: 'translate-x-3' } : { track: 'w-9 h-5', knob: 'w-4 h-4', on: 'translate-x-4' };
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
      className={cx(
        'relative inline-flex shrink-0 items-center rounded-full p-0.5 transition-colors disabled:opacity-50',
        dims.track,
        checked ? 'bg-rust-500' : 'bg-slate-300 dark:bg-dark-600'
      )}
    >
      <span className={cx('rounded-full bg-white shadow-sm transition-transform duration-150', dims.knob, checked && dims.on)} />
    </button>
  );
};

/* -------------------------------------------------------------------------- */
/* Segmented control                                                           */
/* -------------------------------------------------------------------------- */

export interface SegmentedOption<T extends string> {
  value: T;
  label: React.ReactNode;
  icon?: React.ReactNode;
  title?: string;
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = 'md',
  className,
  ariaLabel,
}: {
  value: T;
  onChange: (v: T) => void;
  options: SegmentedOption<T>[];
  size?: 'sm' | 'md';
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cx('inline-flex p-0.5 rounded-lg bg-dark-700 dark:bg-dark-900 border border-line', className)}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={cx(
              'flex-1 inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-all whitespace-nowrap',
              size === 'sm' ? 'h-6 px-2 text-[11.5px]' : 'h-7 px-3 text-[12.5px]',
              active ? 'bg-surface-raised dark:bg-dark-650 text-ink shadow-xs' : 'text-ink-muted hover:text-ink'
            )}
          >
            {o.icon}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Apple-style grouped settings rows                                           */
/* -------------------------------------------------------------------------- */

export const SettingsGroup: React.FC<{ title?: React.ReactNode; footer?: React.ReactNode; children: React.ReactNode; className?: string }> = ({
  title,
  footer,
  children,
  className,
}) => (
  <section className={cx('space-y-1.5', className)}>
    {title && <h3 className="px-1 text-[12px] font-medium text-ink-faint">{title}</h3>}
    <div className="ui-card divide-y divide-line overflow-hidden">{children}</div>
    {footer && <p className="px-1 text-[11.5px] text-ink-faint leading-snug">{footer}</p>}
  </section>
);

export const SettingsRow: React.FC<{
  label: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  children?: React.ReactNode;
  onClick?: () => void;
  stacked?: boolean;
}> = ({ label, description, icon, children, onClick, stacked }) => (
  <div
    onClick={onClick}
    className={cx(
      'px-3.5 py-2.5 min-h-[44px]',
      stacked ? 'space-y-2' : 'flex items-center gap-3',
      onClick && 'cursor-pointer hover:bg-dark-650/40 transition-colors'
    )}
  >
    <div className={cx('flex items-center gap-2.5', !stacked && 'flex-1 min-w-0')}>
      {icon && <span className="shrink-0 text-ink-muted">{icon}</span>}
      <div className="min-w-0">
        <div className="text-[13px] text-ink">{label}</div>
        {description && <div className="text-[11.5px] text-ink-faint leading-snug mt-0.5">{description}</div>}
      </div>
    </div>
    {children && <div className={cx(!stacked && 'shrink-0')}>{children}</div>}
  </div>
);

/* -------------------------------------------------------------------------- */
/* Disclosure ("Advanced")                                                     */
/* -------------------------------------------------------------------------- */

export const Disclosure: React.FC<{
  label: React.ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
  className?: string;
}> = ({ label, defaultOpen = false, open, onOpenChange, children, className }) => {
  const [inner, setInner] = useState(defaultOpen);
  const isOpen = open ?? inner;
  const toggle = () => {
    const next = !isOpen;
    setInner(next);
    onOpenChange?.(next);
  };
  return (
    <div className={className}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={isOpen}
        className="inline-flex items-center gap-1 text-[12.5px] font-medium text-ink-muted hover:text-ink transition-colors select-none"
      >
        <ChevronRight className={cx('w-3.5 h-3.5 transition-transform', isOpen && 'rotate-90')} />
        {label}
      </button>
      {isOpen && <div className="mt-3 animate-in">{children}</div>}
    </div>
  );
};

export const Kbd: React.FC<{ children: React.ReactNode }> = ({ children }) => <span className="ui-kbd">{children}</span>;
