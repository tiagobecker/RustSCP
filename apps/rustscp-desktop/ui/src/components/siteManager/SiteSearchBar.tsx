import React from 'react';
import type { RefObject } from 'react';
import { ListFilter, Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { isMacPlatform } from '../fileListUtils.ts';
import { formatShortcut } from '../ui/contextMenuUtils.ts';
import { plainTextInputProps } from '../../utils/inputHardening.ts';
import { describeTokens, protocolValueLabel } from './siteQuery.ts';
import type { ParsedQuery, TokenPill } from './siteQuery.ts';
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
  /** The query has qualifiers (the filter button shows a dot) */
  filtersActive: boolean;
  /** Opens the filter menu under the button */
  onOpenFilters: (anchor: DOMRect, viaKeyboard: boolean) => void;
}

/**
 * The always-visible search field above the tree, with the filter menu button inside it. Escape is
 * handled by the dialog's escape chain (the Modal routes it there): with text it clears, empty it
 * moves focus to the tree.
 */
export const SiteSearchBar: React.FC<Props> = ({ value, onChange, inputRef, total, autoFocus, onArrowDown, onEnter, filtersActive, onOpenFilters }) => {
  const { t, i18n } = useTranslation();
  const placeholder = t('siteTree.searchPlaceholder', {
    count: total,
    formatted: formatCount(i18n.language, total),
    defaultValue_zero: 'Search connections',
    defaultValue_one: 'Search 1 connection',
    defaultValue_other: 'Search {{formatted}} connections',
  });
  const filtersLabel = t('siteTree.filters', 'Filters');
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
          className={`ui-input h-8 pl-8 text-[13px] ${value ? 'pr-14' : 'pr-8'}`}
        />
        {value && (
          <button
            type="button"
            onClick={() => {
              onChange('');
              inputRef.current?.focus();
            }}
            className="absolute right-7 top-1/2 -translate-y-1/2 w-5 h-5 rounded flex items-center justify-center text-ink-faint hover:text-ink hover:bg-dark-650/70"
            title={t('siteTree.clearSearch', 'Clear search')}
            aria-label={t('siteTree.clearSearch', 'Clear search')}
          >
            <X className="w-3 h-3" />
          </button>
        )}
        <button
          type="button"
          aria-haspopup="menu"
          onClick={(e) => onOpenFilters(e.currentTarget.getBoundingClientRect(), e.detail === 0)}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 w-5 h-5 rounded flex items-center justify-center text-ink-faint hover:text-ink hover:bg-dark-650/70"
          title={filtersLabel}
          aria-label={filtersLabel}
        >
          <ListFilter className="w-3.5 h-3.5" />
          {filtersActive && <span aria-hidden className="absolute top-0 right-0 w-1.5 h-1.5 rounded-full bg-rust-500" />}
        </button>
      </div>
    </div>
  );
};

const IS_LABELS: Record<string, [string, string]> = {
  fav: ['siteTree.filterFavorites', 'Favorites'],
  recent: ['siteTree.filterRecent', 'Used in the last 30 days'],
  open: ['siteTree.filterOpen', 'Connected now'],
  unfiled: ['siteTree.filterUnfiled', 'Not in a folder'],
  empty: ['siteTree.filterEmpty', 'Empty folders'],
  dup: ['siteTree.filterDup', 'Duplicates'],
  nopass: ['siteTree.filterNoPass', 'Password not saved'],
};

const AUTH_LABELS: Record<string, [string, string]> = {
  password: ['siteTree.authPassword', 'Password'],
  key: ['siteTree.authKey', 'Key file'],
  agent: ['siteTree.authAgent', 'SSH agent'],
  none: ['siteTree.authNone', 'Nothing saved'],
};

/** Text of one summary pill ("Protocol: SFTP, FTPS", "Duplicates", "Not: FTP", "In: Production"). */
function pillText(pill: TokenPill, t: TFunction): string {
  const tr = (entry: [string, string] | undefined, raw: string) => (entry ? t(entry[0], entry[1]) : raw);
  let inner: string;
  switch (pill.key) {
    case 'p': {
      const value = pill.values.map(protocolValueLabel).join(', ');
      if (pill.negated) return t('siteTree.pillNot', { value, defaultValue: 'Not: {{value}}' });
      inner = t('siteTree.pillProtocol', { value, defaultValue: 'Protocol: {{value}}' });
      break;
    }
    case 'is': {
      const value = pill.values.map((v) => tr(IS_LABELS[v], `is:${v}`)).join(', ');
      if (pill.negated) return t('siteTree.pillNot', { value, defaultValue: 'Not: {{value}}' });
      inner = value;
      break;
    }
    case 'auth': {
      const value = pill.values.map((v) => tr(AUTH_LABELS[v], v)).join(', ');
      inner = t('siteTree.pillSignIn', { value, defaultValue: 'Sign-in: {{value}}' });
      break;
    }
    case 'in':
      inner = t('siteTree.pillIn', { value: pill.values.join(', '), defaultValue: 'In: {{value}}' });
      break;
    case 'host':
      inner = t('siteTree.pillHost', { value: pill.values.join(', '), defaultValue: 'Server: {{value}}' });
      break;
    case 'user':
      inner = t('siteTree.pillUser', { value: pill.values.join(', '), defaultValue: 'User: {{value}}' });
      break;
    case 'port':
      inner = t('siteTree.pillPort', { value: pill.values.join(', '), defaultValue: 'Port: {{value}}' });
      break;
    default:
      inner = t('siteTree.pillLabel', { value: pill.values.join(', '), defaultValue: 'Label: {{value}}' });
  }
  return pill.negated ? t('siteTree.pillNot', { value: inner, defaultValue: 'Not: {{value}}' }) : inner;
}

/**
 * The summary row under the search field: one removable pill per qualifier. The text stays the
 * only source of truth; a pill's × removes its token from it.
 */
export const FilterPills: React.FC<{ parsed: ParsedQuery; onRemove: (tokenIndex: number) => void }> = ({ parsed, onRemove }) => {
  const { t } = useTranslation();
  const pills = describeTokens(parsed);
  if (pills.length === 0) return null;
  return (
    <div className="px-3 pb-1.5 flex flex-wrap gap-1 max-h-[46px] overflow-hidden shrink-0">
      {pills.map((pill) => {
        const text = pillText(pill, t);
        return (
          <span key={`${pill.index}-${text}`} className="h-5 max-w-full pl-1.5 rounded-md bg-dark-650 text-[11.5px] text-ink-muted inline-flex items-center" title={text}>
            <span className="truncate">{text}</span>
            <button
              type="button"
              onClick={() => onRemove(pill.index)}
              className="w-4 h-4 ml-0.5 mr-0.5 shrink-0 rounded flex items-center justify-center text-ink-faint hover:text-ink hover:bg-dark-600/70"
              aria-label={t('siteTree.removeFilter', { name: text, defaultValue: 'Remove filter “{{name}}”' })}
            >
              <X className="w-2.5 h-2.5" />
            </button>
          </span>
        );
      })}
    </div>
  );
};

/** The "Search tips" card (opened from the filter menu): the query syntax and the Enter keys. */
export const SearchTips: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { t } = useTranslation();
  const mac = isMacPlatform();
  return (
    <div role="note" aria-label={t('siteTree.tipsTitle', 'Search tips')} className="mx-3 mb-2 shrink-0 rounded-lg border border-line bg-dark-800/60 px-2.5 py-2 text-[12px] leading-snug text-ink-muted">
      <div className="flex items-center gap-2 mb-1">
        <span className="flex-1 font-medium text-ink">{t('siteTree.tipsTitle', 'Search tips')}</span>
        <button
          type="button"
          onClick={onClose}
          className="w-5 h-5 -mr-1 rounded flex items-center justify-center text-ink-faint hover:text-ink hover:bg-dark-650/70"
          aria-label={t('siteTree.close', 'Close')}
          title={t('siteTree.close', 'Close')}
        >
          <X className="w-3 h-3" />
        </button>
      </div>
      <p>{t('siteTree.tipsWords', 'Words match name, server, user and folder. Case and accents are ignored.')}</p>
      <p className="mt-1 font-mono text-[11px] text-ink-faint break-words select-text">
        {t('siteTree.tipsQualifiers', 'p:sftp · in:Clients/Acme · host: · user: · port: · is:fav · is:recent · is:dup · is:nopass · auth:key · label: · -p:ftp')}
      </p>
      <p className="mt-1">{t('siteTree.tipsKeys', { shortcut: formatShortcut('Mod+Enter', mac), defaultValue: 'Enter selects, Enter again connects. {{shortcut}} connects at once.' })}</p>
    </div>
  );
};
