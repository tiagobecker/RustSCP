/**
 * Text for "last connected" times (Recent rows, the folder overview's table). No React: the
 * translate function comes from the caller.
 */
import type { TFunction } from 'i18next';
import { recentAge } from './siteTreeModel.ts';

const dateFormats = new Map<string, { short: Intl.DateTimeFormat; full: Intl.DateTimeFormat }>();
const dateFormat = (lang: string) => {
  let f = dateFormats.get(lang);
  if (!f) {
    f = {
      short: new Intl.DateTimeFormat(lang || undefined, { day: 'numeric', month: 'short' }),
      full: new Intl.DateTimeFormat(lang || undefined, { dateStyle: 'medium', timeStyle: 'short' }),
    };
    dateFormats.set(lang, f);
  }
  return f;
};

/** "now", "5 min", "2 h", "3 d", then a short date ("12 Oct"). */
export const recentText = (atSecs: number, lang: string, t: TFunction): string => {
  const age = recentAge(atSecs, Date.now());
  switch (age.unit) {
    case 'now':
      return t('siteTree.agoNow', 'now');
    case 'min':
      return t('siteTree.agoMinutes', { count: age.count, defaultValue: '{{count}} min' });
    case 'h':
      return t('siteTree.agoHours', { count: age.count, defaultValue: '{{count}} h' });
    case 'd':
      return t('siteTree.agoDays', { count: age.count, defaultValue: '{{count}} d' });
    default:
      return dateFormat(lang).short.format(age.date);
  }
};

/** The full date and time (tooltips). */
export const fullDateText = (atSecs: number, lang: string): string => dateFormat(lang).full.format(new Date(atSecs * 1000));
