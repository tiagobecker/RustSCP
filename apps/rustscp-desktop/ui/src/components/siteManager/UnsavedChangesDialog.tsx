import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Modal } from '../ui/Modal.tsx';
import { Button } from '../ui/controls.tsx';

interface Props {
  /** The saved connection's name, or null for a new connection */
  name: string | null;
  /** Saves the form; resolves to false when it could not (the form then shows why) */
  onSave: () => Promise<boolean>;
  /** Drops the edits and goes on */
  onDontSave: () => void;
  /** Stays on the form */
  onCancel: () => void;
}

/**
 * Asked before an action would drop unsaved edits in the Connect dialog's form (selecting another
 * connection, a new connection, closing, connecting another site). Save is the default (Enter).
 */
export const UnsavedChangesDialog: React.FC<Props> = ({ name, onSave, onDontSave, onCancel }) => {
  const { t } = useTranslation();
  const saveRef = useRef<HTMLButtonElement>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await onSave();
    } finally {
      setSaving(false);
    }
  };

  if (typeof document === 'undefined') return null;
  return createPortal(
    <Modal
      isOpen
      onClose={onCancel}
      size="sm"
      title={name ? t('siteTree.unsavedTitle', { name, defaultValue: 'Save changes to “{{name}}”?' }) : t('siteTree.unsavedTitleNew', 'Save the new connection?')}
      initialFocusRef={saveRef}
      footer={
        <>
          <Button variant="ghost" className="mr-auto" onClick={onDontSave} disabled={saving}>
            {t('siteTree.dontSave', "Don't save")}
          </Button>
          <Button variant="secondary" onClick={onCancel} disabled={saving}>
            {t('loginDialog.cancel', 'Cancel')}
          </Button>
          <Button ref={saveRef} variant="primary" onClick={save} loading={saving}>
            {t('loginDialog.save', 'Save')}
          </Button>
        </>
      }
    >
      <p className="text-[13px] text-ink-muted leading-relaxed">{t('siteTree.unsavedBody', "Your changes are lost if you don't save them.")}</p>
    </Modal>,
    document.body
  );
};
