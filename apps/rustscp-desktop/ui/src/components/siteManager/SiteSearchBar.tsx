import React from 'react';
import type { RefObject } from 'react';
import { Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { isMacPlatform } from '../fileListUtils.ts';
import { plainTextInputProps } from '../../utils/inputHardening.ts';
import { formatCount } from './siteTreeModel.ts';

interface Props {
  value: string;
  onChange: (value: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  /** Saved connections (Local not counted), for the placeholder */
  total: number;
  /** Focused when the dialog opens (only when a saved site other than Local exists) */
  autoFocus: boolean;
  /** ↓: focus the first result row */
  onArrowDown: () => void;
  /** Enter: select the first site result; ⌘Enter (`connect`): connect it */
  onEnter: (connect: boolean) => void;
}

/**
 * The always-visible search field above the tree. Escape is handled by the dialog's escape chain
 * (the Modal routes it there): with text it clears, empty it moves focus to the tree.
 */
export const SiteSearchBar: React.FC<Props> = ({ value, onChange, inputRef, total, autoFocus, onArrowDown, onEnter }) => {
  const { t, i18n } = useTranslation();
  const placeholder = t('siteTree.searchPlaceholder', {
    count: total,
    formatted: formatCount(i18n.language, total),
    defaultValue_zero: 'Search connections',
    defaultValue_one: 'Search 1 connection',
    defaultValue_other: 'Search {{formatted}} connections',
  });
  return (
    <div className="px-3 pb-2 shrink-0">
      <div className="relative">
        <Search aria-hidden className="w-3.5 h-3.5 text-ink-faint absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
        <input
          {...plainTextInputProps}
          ref={inputRef}
          type="text"
          role="searchbox"
          value={value}
          data-autofocus={autoFocus ? '' : undefined}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            const mod = isMacPlatform() ? e.metaKey : e.ctrlKey;
            if (e.key === 'ArrowDown' && !mod && !e.altKey && !e.shiftKey) {
              e.preventDefault();
              onArrowDown();
            } else if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
              e.preventDefault();
              onEnter(mod);
            }
          }}
          placeholder={placeholder}
          aria-label={t('siteTree.searchLabel', 'Search connections')}
          className={`ui-input h-8 pl-8 text-[13px] ${value ? 'pr-8' : 'pr-2.5'}`}
        />
        {value && (
          <button
            type="button"
            onClick={() => {
              onChange('');
              inputRef.current?.focus();
            }}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 w-5 h-5 rounded flex items-center justify-center text-ink-faint hover:text-ink hover:bg-dark-650/70"
            title={t('siteTree.clearSearch', 'Clear search')}
            aria-label={t('siteTree.clearSearch', 'Clear search')}
          >
            <X className="w-3 h-3" />
          </button>
        )}
      </div>
    </div>
  );
};
