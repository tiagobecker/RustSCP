import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Plus, Trash2 } from 'lucide-react';
import { plainTextInputProps } from '../../utils/inputHardening.ts';
import { ContextMenu } from '../ui/ContextMenu.tsx';
import type { ContextMenuEntry } from '../ui/ContextMenu.tsx';
import { Modal } from '../ui/Modal.tsx';
import { Button, IconButton } from '../ui/controls.tsx';
import { LABEL_COLOR_NAMES, LABEL_DOT_CLASS, LABEL_PRESETS, labelDefsProblems, newLabelId, nextNewLabel, sameLabelDefs } from './labelsModel.ts';
import { MAX_LABELS, MAX_LABEL_NAME_LEN, formatCount } from './siteTreeModel.ts';
import type { LabelColor, LabelDef } from './types.ts';
import { LABEL_COLORS } from './types.ts';

interface Props {
  labels: LabelDef[];
  /** Items carrying each label as their own */
  usage: Map<string, { sites: number; folders: number }>;
  /** One `set_label_defs` with the edited list (deleting a label only removes its assignments) */
  onSave: (labels: LabelDef[]) => void;
  onCancel: () => void;
}

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

/** Rename labels, pick their colour, add or delete them (spec §14). Saved as one undoable change. */
export const LabelsDialog: React.FC<Props> = ({ labels, usage, onSave, onCancel }) => {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const [rows, setRows] = useState<LabelDef[]>(() => labels.map((l) => ({ ...l })));
  const [showErrors, setShowErrors] = useState(false);
  const [colorMenu, setColorMenu] = useState<{ index: number; rect: DOMRect } | null>(null);
  const inputs = useRef<Array<HTMLInputElement | null>>([]);
  const focusIndex = useRef<number | null>(null);
  const addRef = useRef<HTMLButtonElement>(null);

  // A row just added gets the focus, with its name selected
  useEffect(() => {
    const i = focusIndex.current;
    if (i === null) return;
    focusIndex.current = null;
    const el = inputs.current[i];
    el?.focus();
    el?.select();
  }, [rows.length]);

  const presets = LABEL_PRESETS.map((p) => ({ name: t(p.key, p.name), color: p.color, alt: p.name }));
  const problems = labelDefsProblems(rows);
  const changed = !sameLabelDefs(rows, labels);

  const problemText = (i: number): string | null => {
    switch (problems.get(i)) {
      case 'empty':
        return t('siteTree.errEmptyName', 'Enter a name.');
      case 'too_long':
        return t('siteTree.errLabelTooLong', { max: MAX_LABEL_NAME_LEN, defaultValue: 'Use at most {{max}} characters.' });
      case 'control':
        return t('siteTree.errControl', "Names can't contain control characters.");
      case 'duplicate':
        return t('siteTree.errLabelDuplicate', 'Another label has this name.');
      default:
        return null;
    }
  };

  const update = (i: number, patch: Partial<LabelDef>) => setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const add = () => {
    if (rows.length >= MAX_LABELS) return;
    const next = nextNewLabel(rows, presets);
    focusIndex.current = rows.length;
    setRows((prev) => [...prev, { id: newLabelId(), name: next.name, color: next.color }]);
  };

  const remove = (i: number) => {
    setRows((prev) => prev.filter((_, j) => j !== i));
    // Focus stays in the list: the next row's name, else Add label
    requestAnimationFrame(() => (inputs.current[i] ?? inputs.current[i - 1] ?? addRef.current)?.focus());
  };

  const save = () => {
    if (problems.size > 0) {
      setShowErrors(true);
      const first = Math.min(...problems.keys());
      inputs.current[first]?.focus();
      return;
    }
    if (!changed) {
      onCancel();
      return;
    }
    onSave(rows.map((r) => ({ ...r, name: r.name.trim() })));
  };

  const usageText = (id: string): string => {
    const u = usage.get(id);
    const n = (u?.sites ?? 0) + (u?.folders ?? 0);
    return t('siteTree.labelUsage', { count: n, formatted: formatCount(lang, n), defaultValue_zero: 'Not used', defaultValue_one: '1 item', defaultValue_other: '{{formatted}} items' });
  };

  const colorEntries = (index: number): ContextMenuEntry[] =>
    LABEL_COLORS.map(
      (c: LabelColor): ContextMenuEntry => ({
        kind: 'radio',
        id: `color-${c}`,
        label: t(LABEL_COLOR_NAMES[c][0], LABEL_COLOR_NAMES[c][1]),
        icon: <span aria-hidden className={`w-2.5 h-2.5 rounded-full ${LABEL_DOT_CLASS[c]}`} />,
        checked: rows[index]?.color === c,
        onSelect: () => update(index, { color: c }),
      })
    );

  if (typeof document === 'undefined') return null;
  return createPortal(
    <>
      <Modal
        isOpen
        onClose={onCancel}
        size="md"
        title={t('siteTree.labelsTitle', 'Labels')}
        subtitle={t('siteTree.labelsHint', "One label per connection or folder. A folder's label applies to everything inside.")}
        dismissOnBackdrop={false}
        footer={
          <>
            <Button variant="secondary" onClick={onCancel}>
              {t('loginDialog.cancel', 'Cancel')}
            </Button>
            <Button variant="primary" onClick={save} disabled={showErrors && problems.size > 0}>
              {t('loginDialog.save', 'Save')}
            </Button>
          </>
        }
      >
        <div>
          {rows.length === 0 ? (
            <p className="py-3 text-[13px] text-ink-muted leading-relaxed">
              {t('siteTree.labelsEmpty', "No labels yet. Add one here, or pick one from a connection's Label menu.")}
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {rows.map((row, i) => {
                const error = showErrors ? problemText(i) : null;
                const errorId = `label-row-${row.id}-err`;
                const colorName = t(LABEL_COLOR_NAMES[row.color][0], LABEL_COLOR_NAMES[row.color][1]);
                return (
                  <li key={row.id} className="flex flex-col">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className="h-8 px-2 shrink-0 flex items-center gap-1 rounded-md border border-line hover:bg-dark-650/50"
                        aria-haspopup="menu"
                        aria-label={t('siteTree.labelColorOf', { name: row.name.trim() || t('siteTree.label', 'Label'), color: colorName, defaultValue: 'Color of “{{name}}”: {{color}}' })}
                        title={colorName}
                        onClick={(e) => setColorMenu({ index: i, rect: e.currentTarget.getBoundingClientRect() })}
                      >
                        <span aria-hidden className={`w-3 h-3 rounded-full ${LABEL_DOT_CLASS[row.color]}`} />
                        <ChevronDown aria-hidden className="w-3 h-3 text-ink-faint" />
                      </button>
                      <input
                        {...plainTextInputProps}
                        ref={(el) => {
                          inputs.current[i] = el;
                        }}
                        value={row.name}
                        maxLength={60}
                        placeholder={t('siteTree.labelName', 'Name')}
                        aria-label={t('siteTree.labelNameField', 'Label name')}
                        aria-invalid={error ? true : undefined}
                        aria-describedby={error ? errorId : undefined}
                        onChange={(e) => update(i, { name: e.target.value })}
                        onKeyDown={(e) => {
                          // Enter saves (the Modal's footer is outside this list)
                          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                            e.preventDefault();
                            save();
                          }
                        }}
                        className={cx('ui-input h-8 flex-1 min-w-0 px-2.5 text-[13px]', error && '!border-red-500/70')}
                      />
                      <span className="w-[68px] shrink-0 text-right text-[11.5px] tabular-nums text-ink-faint truncate">{labels.some((l) => l.id === row.id) ? usageText(row.id) : ''}</span>
                      <IconButton size="sm" label={t('siteTree.deleteLabel', 'Delete label')} onClick={() => remove(i)}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </IconButton>
                    </div>
                    {error && (
                      <p id={errorId} role="alert" className="mt-1 ml-[60px] text-[11.5px] text-red-600 dark:text-red-400">
                        {error}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <div className="mt-3 flex items-center gap-3">
            <Button ref={addRef} variant="ghost" size="sm" icon={<Plus className="w-3.5 h-3.5" />} onClick={add} disabled={rows.length >= MAX_LABELS}>
              {t('siteTree.addLabel', 'Add label')}
            </Button>
            {rows.length >= MAX_LABELS && (
              <span className="text-[11.5px] text-ink-faint">{t('siteTree.errTooManyLabels', { max: MAX_LABELS, defaultValue: 'You can have up to {{max}} labels.' })}</span>
            )}
          </div>
        </div>
      </Modal>
      {colorMenu && (
        <ContextMenu
          at={{ rect: colorMenu.rect, placement: 'below' }}
          entries={colorEntries(colorMenu.index)}
          ariaLabel={t('siteTree.labelColor', 'Color')}
          width={180}
          onClose={() => setColorMenu(null)}
        />
      )}
    </>,
    document.body
  );
};
