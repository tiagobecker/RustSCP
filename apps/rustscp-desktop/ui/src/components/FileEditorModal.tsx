import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Save, Check, Search, ChevronDown, X } from 'lucide-react';
import { Modal } from './ui/Modal.tsx';
import { Button, IconButton } from './ui/controls.tsx';
import { notify } from './ui/toast.tsx';
import { plainTextInputProps } from '../utils/inputHardening.ts';

/**
 * Legacy single-file editor. The app uses RustScpEditor; this stays for compatibility.
 */
interface FileEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  fileName: string;
  filePath: string;
  initialContent: string;
  onSave: (path: string, content: string) => Promise<void>;
}

const LINE_HEIGHT = 20;

export const FileEditorModal: React.FC<FileEditorModalProps> = ({ isOpen, onClose, fileName, filePath, initialContent, onSave }) => {
  const { i18n } = useTranslation();
  const isPt = (i18n.language || 'en').toLowerCase().startsWith('pt');
  const tr = (pt: string, en: string) => (isPt ? pt : en);

  const [content, setContent] = useState<string>('');
  const [savedContent, setSavedContent] = useState<string>('');
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [saveSuccess, setSaveSuccess] = useState<boolean>(false);
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [showSearch, setShowSearch] = useState<boolean>(false);
  const [confirmDiscard, setConfirmDiscard] = useState<boolean>(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLPreElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setContent(initialContent);
    setSavedContent(initialContent);
    setConfirmDiscard(false);
  }, [initialContent, filePath]);

  const isDirty = content !== savedContent;
  const lineCount = useMemo(() => content.split('\n').length, [content]);
  const gutterText = useMemo(() => Array.from({ length: lineCount }, (_, i) => String(i + 1)).join('\n'), [lineCount]);

  const handleSave = async (): Promise<boolean> => {
    if (isSaving) return false;
    if (!isDirty) return true;
    const toSave = content;
    setIsSaving(true);
    try {
      await onSave(filePath, toSave);
      setSavedContent(toSave);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 1800);
      return true;
    } catch (err) {
      notify.error(tr('Não foi possível salvar', 'Could not save'), err);
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  const findNext = () => {
    const ta = textareaRef.current;
    if (!ta || !searchTerm) return;
    const hay = content.toLowerCase();
    const needle = searchTerm.toLowerCase();
    let pos = hay.indexOf(needle, ta.selectionEnd);
    if (pos === -1) pos = hay.indexOf(needle);
    if (pos === -1) {
      notify.info(tr('Nada encontrado', 'Not found'), searchTerm);
      return;
    }
    ta.focus();
    ta.setSelectionRange(pos, pos + searchTerm.length);
  };

  const requestClose = () => {
    if (isDirty) setConfirmDiscard(true);
    else onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void handleSave();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      setShowSearch(true);
      requestAnimationFrame(() => searchRef.current?.focus());
    }
  };

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={requestClose}
        size="2xl"
        padded={false}
        dismissOnBackdrop={false}
        title={
          <span className="inline-flex items-center gap-2">
            {fileName}
            {isDirty && <span className="w-1.5 h-1.5 rounded-full bg-rust-500" aria-label={tr('Não salvo', 'Unsaved')} />}
          </span>
        }
        subtitle={<span className="font-mono text-[11.5px]">{filePath}</span>}
        initialFocusRef={textareaRef}
        headerActions={
          <>
            <IconButton size="sm" label={tr('Localizar', 'Find')} active={showSearch} onClick={() => setShowSearch((v) => !v)}>
              <Search className="w-4 h-4" />
            </IconButton>
            <Button
              size="sm"
              variant="primary"
              onClick={() => void handleSave()}
              disabled={!isDirty && !isSaving}
              loading={isSaving}
              icon={saveSuccess ? <Check className="w-3.5 h-3.5" /> : <Save className="w-3.5 h-3.5" />}
            >
              {saveSuccess ? tr('Salvo', 'Saved') : tr('Salvar', 'Save')}
            </Button>
          </>
        }
      >
        <div className="h-[65vh] flex flex-col" onKeyDown={handleKeyDown}>
          {showSearch && (
            <div className="flex items-center gap-1.5 px-4 py-2 border-y border-line">
              <input
                ref={searchRef}
                type="text"
                {...plainTextInputProps}
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    findNext();
                  }
                }}
                placeholder={tr('Localizar no arquivo', 'Find in file')}
                aria-label={tr('Localizar no arquivo', 'Find in file')}
                className="ui-input h-7 w-72 text-[12.5px]"
              />
              <IconButton size="sm" label={tr('Próximo', 'Next')} onClick={findNext} disabled={!searchTerm}>
                <ChevronDown className="w-4 h-4" />
              </IconButton>
              <IconButton size="sm" label={tr('Fechar busca', 'Close find')} onClick={() => setShowSearch(false)}>
                <X className="w-3.5 h-3.5" />
              </IconButton>
            </div>
          )}
          <div className="flex-1 min-h-0 flex border-t border-line bg-surface-raised font-mono text-[12.5px]">
            <pre
              ref={gutterRef}
              aria-hidden="true"
              className="m-0 w-12 shrink-0 overflow-hidden select-none border-r border-line bg-surface text-ink-faint text-right pr-2 pt-3 pb-12"
              style={{ lineHeight: `${LINE_HEIGHT}px`, font: 'inherit' }}
            >
              {gutterText}
            </pre>
            <textarea
              ref={textareaRef}
              {...plainTextInputProps}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              onScroll={(e) => {
                if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop;
              }}
              wrap="off"
              aria-label={tr(`Conteúdo de ${fileName}`, `Contents of ${fileName}`)}
              className="flex-1 min-w-0 bg-transparent text-ink p-3 resize-none focus:outline-none overflow-auto whitespace-pre font-mono selection:bg-rust-500/25"
              style={{ lineHeight: `${LINE_HEIGHT}px` }}
            />
          </div>
          <div className="flex items-center gap-4 h-7 px-4 border-t border-line text-[11.5px] text-ink-faint select-none">
            <span className="tabular-nums">
              {lineCount.toLocaleString()} {tr('linhas', 'lines')}
            </span>
            <span className="tabular-nums">{content.length.toLocaleString()} {tr('caracteres', 'characters')}</span>
            <span className="ml-auto">UTF-8</span>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={isOpen && confirmDiscard}
        onClose={() => setConfirmDiscard(false)}
        size="sm"
        title={tr(`Salvar as alterações em “${fileName}”?`, `Save changes to “${fileName}”?`)}
        initialFocusRef={cancelRef}
        footer={
          <>
            <Button
              variant="ghost"
              className="mr-auto text-red-600 dark:text-red-400"
              onClick={() => {
                setConfirmDiscard(false);
                setContent(savedContent);
                onClose();
              }}
            >
              {tr('Não salvar', 'Don’t save')}
            </Button>
            <Button ref={cancelRef} variant="secondary" onClick={() => setConfirmDiscard(false)}>
              {tr('Cancelar', 'Cancel')}
            </Button>
            <Button
              variant="primary"
              loading={isSaving}
              onClick={async () => {
                const ok = await handleSave();
                setConfirmDiscard(false);
                if (ok) onClose();
              }}
            >
              {tr('Salvar', 'Save')}
            </Button>
          </>
        }
      >
        <p className="text-[13px] text-ink-muted">{tr('Se você não salvar, as alterações serão perdidas.', 'Your changes will be lost if you don’t save them.')}</p>
      </Modal>
    </>
  );
};
