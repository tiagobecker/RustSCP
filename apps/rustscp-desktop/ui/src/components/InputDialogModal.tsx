import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Modal } from './ui/Modal.tsx';
import { Button, TextInput } from './ui/controls.tsx';

export interface InputDialogProps {
  isOpen: boolean;
  title: string;
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: (value: string) => void | Promise<void>;
  onClose: () => void;
}

/** In-app replacement for window.prompt (WKWebView may ignore it). Return submits, Escape cancels. */
export const InputDialogModal: React.FC<InputDialogProps> = ({
  isOpen,
  title,
  message,
  defaultValue = '',
  placeholder = '',
  confirmText,
  cancelText,
  onConfirm,
  onClose,
}) => {
  const { i18n } = useTranslation();
  const isPt = (i18n.language || '').startsWith('pt');
  const tr = (pt: string, en: string) => (isPt ? pt : en);

  const formId = useId();
  const inputId = useId();
  const [value, setValue] = useState<string>(defaultValue);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    setValue(defaultValue);
    busyRef.current = false;
    setBusy(false);
    const timer = setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 50);
    return () => clearTimeout(timer);
  }, [isOpen, defaultValue]);

  if (!isOpen || typeof document === 'undefined') return null;

  const trimmed = value.trim();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!trimmed || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await onConfirm(trimmed);
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  return createPortal(
    <Modal
      isOpen
      onClose={onClose}
      size="sm"
      title={title}
      initialFocusRef={inputRef}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {cancelText || tr('Cancelar', 'Cancel')}
          </Button>
          <Button type="submit" form={formId} variant="primary" disabled={!trimmed} loading={busy}>
            {confirmText || tr('Criar', 'Create')}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={handleSubmit} className="space-y-1.5">
        {message && (
          <label htmlFor={inputId} className="ui-label">
            {message}
          </label>
        )}
        <TextInput
          id={inputId}
          ref={inputRef}
          mono
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          aria-label={message ? undefined : title}
        />
      </form>
    </Modal>,
    document.body
  );
};
